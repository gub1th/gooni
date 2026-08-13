/**
 * The frontmost-app sensor's orchestration — the decision layer between the
 * tracker (what an interval is), the reporter (how it gets delivered) and the
 * OS (who is frontmost, and is anyone there).
 *
 * No electron import: the two OS reads are injected as `queryFrontmost` and
 * `getIdleSeconds`, so the whole loop runs in node:test with a fake clock.
 * Same split, and the same reason, as extension/src/attention.js — that module
 * exists because "is the human here, and on what?" turned out to be ONE
 * decision, and splitting it across event handlers is what let the browser
 * sensor credit a two-hour lunch as focus.
 *
 * The two rules that make the numbers honest, both learned the hard way in the
 * browser sensor:
 *
 * 1. **Idle is checked FIRST, and it wins.** A frontmost app is not an
 *    attending human — walking away never changes which app is frontmost, so
 *    polling "who is frontmost" alone would credit every lunch break to
 *    whatever was on screen. `getSystemIdleTime` is asked before anything else,
 *    and anything past the threshold closes the interval BACKDATED by the
 *    reported idle time, which is exact (unlike the browser's fixed-threshold
 *    backdate, macOS tells us precisely how long it has been).
 *
 * 2. **Everything settles, and nothing overlaps.** Ticks run through a
 *    one-at-a-time chain; a tick that arrives while one is running is dropped
 *    rather than queued, because a queued tick would report a stale `now` by
 *    the time it ran. A wedged `osascript` therefore costs one skipped tick,
 *    not a stalled sensor (the query bounds itself — see frontmost.js).
 *
 * 3. **A LAPSE IN OBSERVATION closes the interval, however it happened.**
 *    `osascript` can wedge and the Accessibility grant can be revoked
 *    mid-session, so the frontmost read stops answering; but polling itself can
 *    also stop — the machine sleeps without `suspend` landing (SIGSTOP, a
 *    forward clock jump, a wedged main process) and ticks simply do not run.
 *    Either way `lastSeenAt` stops advancing while an interval stays open, and
 *    leaving it open hands the whole outage — possibly overnight — to whatever
 *    was frontmost when observation stopped, as a clean measurement. So EVERY
 *    tick checks the anchor first: once observation has been absent for longer
 *    than `observationGapMs`, the interval closes at its last confirmed moment
 *    and is flagged, and the app being frontmost NOW opens a fresh one starting
 *    now. The same-app branch of `tracker.focus` deliberately does not close (a
 *    real hour of work must not become poll-length slivers), which is exactly
 *    why the staleness question is asked here, on both paths, and answered in
 *    one place. "The sensor is sitting on a stale open interval" is not allowed
 *    to be an invisible state.
 *
 * A tick's OS reads are async, so a lock or a suspend can land between the read
 * and its use. The generation counter is what makes that safe: a power event
 * closes the interval and bumps the counter, and a tick whose reads predate the
 * bump discards them instead of re-opening an interval for a machine that has
 * gone to sleep.
 */

// How many poll periods of failed observation before an open interval stops
// being credited. A single failed query is ordinary — one slow `osascript`, one
// timeout — and closing on it would chop real sessions at every hiccup; a run of
// them is the sensor going blind. Derived from `pollMs` rather than fixed,
// because "how long is an ordinary gap" is entirely a question about the poll
// cadence, and that cadence is configurable.
const OBSERVATION_GAP_POLLS = 5;

// …with a floor, because pollMs clamps as low as 1s and five seconds is inside
// the noise of a single slow query. Well under the 5-minute OPEN_GAP the server
// derives `opened X` rows with, so this can never change what the log says —
// only how honest a duration is.
const MIN_OBSERVATION_GAP_MS = 15_000;

class AppSensor {
  /**
   * @param {object} opts
   * @param {import("./appfocus").AppFocusTracker} opts.tracker
   * @param {import("./appreporter").AppReporter} opts.reporter
   * @param {() => Promise<{app: string|null, error?: string, permission?: boolean}>} opts.queryFrontmost
   * @param {() => number} opts.getIdleSeconds  seconds since the last user input
   * @param {number} [opts.idleSec]   no-input seconds before attention is gone
   * @param {number} [opts.pollMs]
   * @param {number} [opts.flushMs]
   * @param {number} [opts.observationGapMs]  overrides the pollMs-derived default
   */
  constructor({
    tracker,
    reporter,
    queryFrontmost,
    getIdleSeconds,
    idleSec = 90,
    pollMs = 4000,
    flushMs = 60_000,
    observationGapMs,
    now = Date.now,
    setTimer = setInterval,
    clearTimer = clearInterval,
    onStatus = () => {},
    log = () => {},
  } = {}) {
    this.tracker = tracker;
    this.reporter = reporter;
    this.queryFrontmost = queryFrontmost;
    this.getIdleSeconds = getIdleSeconds;
    this.idleSec = idleSec;
    this.pollMs = pollMs;
    this.flushMs = flushMs;
    this.observationGapMs =
      observationGapMs ?? Math.max(pollMs * OBSERVATION_GAP_POLLS, MIN_OBSERVATION_GAP_MS);
    // The tracker is pure and holds no cadence of its own, so the one place that
    // knows how often observation actually happens tells it.
    if (this.tracker) this.tracker.observationGapMs = this.observationGapMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onStatus = onStatus;
    this.log = log;

    this.running = false;
    /** null = unknown yet; true/false once a query has answered. */
    this.permission = null;
    this.lastError = null;
    this.generation = 0;
    this._ticking = false;
    this._pollTimer = null;
    this._flushTimer = null;
  }

  status() {
    return {
      running: this.running,
      permission: this.permission,
      lastError: this.lastError,
      current: this.tracker.open?.app || null,
      ...this.reporter.status(),
    };
  }

  /**
   * Salvage first, THEN start observing.
   *
   * A record left open on disk means the shell (or the machine) died
   * mid-interval, and `now` at launch proves nothing about the past — the same
   * ordering both of the extension's boot paths use. Skipping this would let a
   * shell quit at 6pm and relaunched at 9am report a fifteen-hour session on
   * whatever happened to be frontmost.
   */
  start() {
    if (this.running) return Promise.resolve(null);
    this.running = true;

    const orphan = this.reporter.open;
    if (orphan) {
      this.tracker.load(orphan);
      const salvaged = this.tracker.recoverOrphan();
      if (salvaged) {
        this.reporter.add(salvaged);
        this.log(`salvaged ${salvaged.app} (truncated at last observation)`);
      }
      this.reporter.setOpen(null);
    }

    this._pollTimer = this.setTimer(() => void this.tick(), this.pollMs);
    this._flushTimer = this.setTimer(() => void this.reporter.flush(), this.flushMs);
    // The first observation happens immediately rather than a poll period from
    // now, and the promise is RETURNED so a caller that needs the sensor to have
    // actually looked can await it. main.js does not; the tests do, and without
    // it every test would race the tick it is about to assert on.
    return this.tick();
  }

  /**
   * Stop observing and hand over what is buffered.
   *
   * `shutdown` closes the open interval with a REAL end time (we are here, we
   * know when), which is what keeps a clean quit from producing a `truncated`
   * row; the salvage path is for the deaths we don't get told about.
   */
  async stop({ flush = true } = {}) {
    if (!this.running) return;
    this.running = false;
    this.generation += 1;
    if (this._pollTimer !== null) this.clearTimer(this._pollTimer);
    if (this._flushTimer !== null) this.clearTimer(this._flushTimer);
    this._pollTimer = null;
    this._flushTimer = null;

    this._emit(this.tracker.shutdown(this.now()));
    this.reporter.setOpen(null);
    if (flush) await this.reporter.flush();
    this.onStatus(this.status());
  }

  /** Screen locked — instantaneous, so the close needs no backdating. */
  onLock() {
    this.generation += 1;
    this._emit(this.tracker.lock(this.now()));
    this.reporter.setOpen(null);
  }

  /**
   * The machine is going to sleep. Electron delivers this BEFORE the sleep, so
   * it is a real observation — which is exactly why a normal lid-close does not
   * produce a truncated row while a hard crash does.
   */
  onSuspend() {
    this.generation += 1;
    this._emit(this.tracker.suspend(this.now()));
    this.reporter.setOpen(null);
    void this.reporter.flush();
  }

  /** Woke up / unlocked. The next tick reopens whatever is frontmost now. */
  onResume() {
    void this.tick();
  }

  /** One observation. Never throws; returns the interval it closed, if any. */
  async tick() {
    if (!this.running || this._ticking) return null;
    this._ticking = true;
    const generation = this.generation;
    try {
      // IDLE FIRST, and idle wins. See the class header.
      let idleSeconds = 0;
      try {
        idleSeconds = Number(this.getIdleSeconds()) || 0;
      } catch {
        // An idle read that throws fails CLOSED — the same posture as the
        // extension's idle probe. Treating an unknown as "present" is the
        // direction that invents attention.
        idleSeconds = this.idleSec;
      }
      if (idleSeconds >= this.idleSec) {
        const closed = this.tracker.idle(this.now(), idleSeconds * 1000);
        this._emit(closed);
        this.reporter.setOpen(this.tracker.toJSON());
        return closed;
      }

      const result = await this.queryFrontmost();
      // A power event landed while we were asking. Its close already happened;
      // reopening now would resurrect an interval for a sleeping machine.
      if (generation !== this.generation || !this.running) return null;

      if (!result || !result.app) {
        this.lastError = result?.error || "unknown";
        this._closeUnobserved();
        if (result?.permission) {
          // Never clears by itself, so it is stated once, loudly, rather than
          // retried in silence forever.
          if (this.permission !== false) this.log(`NEEDS ACCESSIBILITY: ${this.lastError}`);
          this.permission = false;
          this.onStatus(this.status());
        }
        return null;
      }

      if (this.permission === false) this.log("accessibility granted — sensing again");
      this.permission = true;
      this.lastError = null;

      // A successful answer says who is frontmost NOW; it says nothing about the
      // stretch since the last confirmed observation. If that stretch is past
      // the tolerance the open interval is closed at its anchor first, so the
      // same-app branch below cannot absorb an unobserved gap as continuity.
      const lapsed = this._closeUnobserved();

      const closed = this.tracker.focus({ app: result.app, at: this.now() });
      this._emit(closed);
      this.tracker.seen(this.now());
      // Persist the open interval every tick: its `lastSeenAt` is the anchor a
      // salvage closes at, so a stale one would credit everything between the
      // last write and the crash.
      this.reporter.setOpen(this.tracker.toJSON());
      return closed || lapsed;
    } finally {
      this._ticking = false;
    }
  }

  /**
   * Observation has been absent long enough that the open interval is no longer
   * a measurement — the query kept failing, or ticks stopped running at all.
   * Close it at the last confirmed moment, flagged.
   *
   * ONE owner for that predicate, called from both the query-failure branch and
   * the success branch, because a lapse in polling and a lapse in answering are
   * the same lie about attention and must not be judged by two rules.
   *
   * The anchor is cleared too: an interval this already closed must not also be
   * salvaged as an orphan on the next launch.
   */
  _closeUnobserved() {
    const open = this.tracker.open;
    if (!open) return null;
    if (this.now() - open.lastSeenAt <= this.observationGapMs) return null;
    const closed = this.tracker.unobserved();
    this.log(`observation lapsed — closed ${open.app} at its last confirmed moment`);
    this._emit(closed);
    this.reporter.setOpen(this.tracker.toJSON());
    return closed;
  }

  _emit(interval) {
    if (!interval) return;
    this.reporter.add(interval);
    this.onStatus(this.status());
  }
}

module.exports = { AppSensor };
