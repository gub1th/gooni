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
 * A tick's OS reads are async, so a lock or a suspend can land between the read
 * and its use. The generation counter is what makes that safe: a power event
 * closes the interval and bumps the counter, and a tick whose reads predate the
 * bump discards them instead of re-opening an interval for a machine that has
 * gone to sleep.
 */

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
   */
  constructor({
    tracker,
    reporter,
    queryFrontmost,
    getIdleSeconds,
    idleSec = 90,
    pollMs = 4000,
    flushMs = 60_000,
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

      const closed = this.tracker.focus({ app: result.app, at: this.now() });
      this._emit(closed);
      this.tracker.seen(this.now());
      // Persist the open interval every tick: its `lastSeenAt` is the anchor a
      // salvage closes at, so a stale one would credit everything between the
      // last write and the crash.
      this.reporter.setOpen(this.tracker.toJSON());
      return closed;
    } finally {
      this._ticking = false;
    }
  }

  _emit(interval) {
    if (!interval) return;
    this.reporter.add(interval);
    this.onStatus(this.status());
  }
}

module.exports = { AppSensor };
