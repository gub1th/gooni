/**
 * The frontmost-app interval state machine — the OS twin of the browser
 * extension's `tracker.js`.
 *
 * Pure logic: no electron, no child_process, no network, no clock of its own.
 * Duration math is the entire product here, and a fake clock is the only way to
 * have any confidence in it — same split, and same reason, as the extension.
 *
 * Exactly ONE interval is open at a time, because exactly one application can
 * be frontmost. An interval closes when:
 *
 *   - a different app comes to the front        → app_change
 *   - the machine goes idle                     → idle
 *   - the screen locks                          → locked
 *   - the machine sleeps                        → suspended
 *   - the shell quits cleanly                   → shutdown
 *   - observation lapsed (the frontmost query
 *     has been failing)                         → unobserved
 *   - the record is found orphaned on the next
 *     launch (shell killed, machine crashed)    → truncated
 *
 * The honesty rules are the extension's rules, restated for this sensor because
 * they are the difference between a measurement and a flattering story:
 *
 * 1. **Idle is backdated.** The idle threshold has ALREADY elapsed by the time
 *    anything reports idle, so those seconds were already not attention.
 *    Closing at `now - threshold` rather than `now` is the difference between a
 *    number and a systematic overcount on every interval that ends by walking
 *    away from the machine.
 *
 * 2. **A span is only ever as long as OBSERVATION reaches**, and where it isn't,
 *    it says so. If the shell is killed — or the Mac sleeps with the lid shut —
 *    there is no close event, and the honest end is the last poll that saw the
 *    app frontmost, NOT the time the shell next started. Without that, the
 *    single most common failure (quit the shell at 6pm, launch it at 9am)
 *    reports a fifteen-hour session on whatever was frontmost at the time.
 *
 *    That rule belongs to `_close`, not to the salvage path, because a crash is
 *    not the only way observation stops. The frontmost query can simply FAIL —
 *    System Events wedges, or the Accessibility grant is revoked mid-session —
 *    and then `lastSeenAt` stops advancing while the interval keeps accruing.
 *    A close arriving after that gap would otherwise credit hours nothing was
 *    watching to whatever was frontmost when the sensor went blind, and hand it
 *    over as a CLEAN measurement. So every close clamps down to the last
 *    confirmed observation once the requested end runs past it by more than the
 *    sensor's tolerance, and every such row carries `truncated: true` — the same
 *    flag `/focus`'s 6h session cap uses, and the same flag the extension puts
 *    on a poll-discovered blur.
 *
 * 3. **Sub-threshold intervals are dropped.** Flicking through apps with
 *    cmd-tab produces a burst of sub-second "attention" that is not attention.
 *    (The 5-minute `opened X` gap rule on the server is a separate, much
 *    coarser filter, and it operates on rows — this keeps the rows themselves
 *    from being noise.)
 */

/** Below this, an app was passed through, not used. */
const MIN_DURATION_MS = 2000;

// Longest interval we will emit. The idle check closes intervals after a minute
// or two of no input, so nothing legitimate approaches this. Exceeding it means
// observation stopped (lid closed, process suspended, machine slept) and the
// span is a lie about attention, not a long focus session. We clamp to the last
// confirmed observation and flag, rather than emitting the lie or dropping the
// row silently. Deliberately the same 6h the server rejects past
// (interval_ingest.MAX_INTERVAL_SEC) and the same cap /focus puts on a session.
const MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;

// How far past the last CONFIRMED observation a close may land before the span
// stops being a measurement.
//
// The sensor only knows an app was frontmost at the moments it successfully
// asked, and asking can fail for hours at a stretch (see honesty rule 2). The
// 6h cap above cannot catch that: a forty-minute hole sails straight through it
// and lands in `app_intervals` as a clean row. This is the same cap at the
// resolution the sensor actually observes at, so an unobserved stretch is
// clamped away and flagged instead of being credited.
//
// The real value is INJECTED by the sensor, derived from its own poll cadence —
// that cadence is what decides how big an ORDINARY gap is, and this module has
// no business holding a second copy of it. This is only the fallback for a
// tracker built without one.
const OBSERVATION_GAP_MS = 30_000;

function newId() {
  return globalThis.crypto.randomUUID();
}

class AppFocusTracker {
  /**
   * @param {object} opts
   * @param {(interval: object) => void} opts.onInterval  called with each closed interval
   * @param {number} [opts.minDurationMs]
   * @param {number} [opts.observationGapMs]  set by the sensor from its poll cadence
   * @param {() => string} [opts.idFactory]  client_id minting (injected in tests)
   */
  constructor({
    onInterval,
    minDurationMs = MIN_DURATION_MS,
    observationGapMs = OBSERVATION_GAP_MS,
    idFactory = newId,
  } = {}) {
    this.onInterval = onInterval || (() => {});
    this.minDurationMs = minDurationMs;
    this.observationGapMs = observationGapMs;
    this.idFactory = idFactory;
    /** @type {null | {app:string, title:string|null, startedAt:number, lastSeenAt:number}} */
    this.open = null;
  }

  /** Serializable snapshot of the open interval (persisted after every event). */
  toJSON() {
    return this.open;
  }

  /** Restore a snapshot read back from disk after a restart. */
  load(open) {
    this.open = open && open.app ? open : null;
  }

  /**
   * This app is now frontmost. Closes whatever was open first.
   *
   * Re-observing the SAME app only refreshes the confirmation stamp: the poll
   * fires every few seconds and reports the same app almost every time, so an
   * unconditional close would chop a genuine hour of work into hundreds of
   * poll-length slivers — and would make every duration a measurement of the
   * poll interval rather than of attention.
   */
  focus({ app, title, at }) {
    if (!app) return null;
    if (this.open && this.open.app === app) {
      if (title) this.open.title = title;
      this.open.lastSeenAt = Math.max(this.open.lastSeenAt, at);
      return null;
    }
    const closed = this.open ? this._close(at, "app_change") : null;
    this.open = { app, title: title || null, startedAt: at, lastSeenAt: at };
    return closed;
  }

  /**
   * The machine went idle. `thresholdMs` is the no-input period that had to
   * elapse before this could be reported, so the interval ended that long ago.
   */
  idle(at, thresholdMs = 0) {
    if (!this.open) return null;
    return this._close(Math.max(this.open.startedAt, at - thresholdMs), "idle");
  }

  /** Screen locked. Unlike idle this is instantaneous — no backdating. */
  lock(at) {
    return this._close(at, "locked");
  }

  /**
   * The machine is going to sleep. Electron delivers `suspend` BEFORE the
   * machine actually sleeps, so `at` is a real observation and needs no
   * backdating — this is the clean version of the salvage path below, and the
   * reason a normal lid-close does not produce a `truncated` row.
   */
  suspend(at) {
    return this._close(at, "suspended");
  }

  /** The shell is quitting and told us so. */
  shutdown(at) {
    return this._close(at, "shutdown");
  }

  /** Poll tick that confirmed the same app is still frontmost; the salvage anchor. */
  seen(at) {
    if (this.open) this.open.lastSeenAt = Math.max(this.open.lastSeenAt, at);
  }

  /**
   * Observation has lapsed while the shell is still running: the frontmost
   * query has been failing for longer than the sensor's tolerance. Close at the
   * last confirmed moment and flag it — the gap is time nothing was watching,
   * exactly like the salvage path, and leaving the interval open would let a
   * wedged System Events hand the whole outage to whatever was frontmost when
   * it broke.
   */
  unobserved() {
    if (!this.open) return null;
    return this._close(this.open.lastSeenAt, "unobserved", true);
  }

  /**
   * Called at startup when a snapshot was found on disk: the shell died (or the
   * machine did) mid-interval. Close it at the last confirmed observation, NOT
   * at now — the gap between them is time nothing was watching.
   */
  recoverOrphan() {
    if (!this.open) return null;
    return this._close(this.open.lastSeenAt, "truncated", true);
  }

  /** Drop the open interval without emitting (config turned the sensor off). */
  discard() {
    this.open = null;
  }

  _close(at, reason, truncated = false) {
    const open = this.open;
    this.open = null;
    if (!open) return null;

    let endedAt = Math.max(open.startedAt, at);
    let flagged = truncated;
    // Clamp DOWNWARD only, and only past the tolerance: a normal idle close
    // already backdates to roughly the last observation, and a quit or a lock
    // we were present for is a real end time we should keep.
    if (endedAt - open.lastSeenAt > this.observationGapMs) {
      endedAt = Math.max(open.startedAt, open.lastSeenAt);
      flagged = true;
    }
    if (endedAt - open.startedAt > MAX_INTERVAL_MS) {
      // The last confirmed observation is the newest moment we can prove the app
      // was frontmost; prefer it, then hard-clamp.
      endedAt = Math.max(open.startedAt, Math.min(endedAt, open.lastSeenAt));
      if (endedAt - open.startedAt > MAX_INTERVAL_MS) {
        endedAt = open.startedAt + MAX_INTERVAL_MS;
      }
      flagged = true;
    }

    if (endedAt - open.startedAt < this.minDurationMs) return null;

    const interval = {
      client_id: this.idFactory(),
      app: open.app,
      // Window titles are NOT collected (see AppInterval's docstring): the app
      // name answers the question this sensor exists for, and a window title is
      // the field most likely to carry something private. The field is carried
      // through only because the tracker is generic.
      title: open.title,
      started_at: new Date(open.startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      end_reason: reason,
      truncated: flagged,
    };
    this.onInterval(interval);
    return interval;
  }
}

module.exports = { AppFocusTracker, MIN_DURATION_MS, MAX_INTERVAL_MS, OBSERVATION_GAP_MS };
