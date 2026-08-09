/**
 * The focus-interval state machine. Pure logic — no chrome APIs, no storage,
 * no network — so it can be unit-tested with a fake clock, which is the only
 * way to have any confidence in duration math.
 *
 * Exactly ONE interval is open at a time, because exactly one tab in one
 * focused window can hold attention. An interval closes when:
 *
 *   - the active tab changes                       → tab_change
 *   - the active tab navigates                     → url_change
 *   - the window loses focus (or all windows do)   → window_blur
 *   - the machine goes idle                        → idle
 *   - the screen locks                             → locked
 *   - the browser shuts down / the record is found
 *     orphaned on next startup                     → truncated
 *
 * Two details that decide whether the numbers are honest:
 *
 * 1. **Idle is backdated.** chrome.idle reports "idle" only after N seconds of
 *    no input, so those N seconds were already not attention. Closing at
 *    `now - N` instead of `now` is the difference between a measurement and a
 *    systematic overcount on every single interval that ends by walking away.
 *
 * 2. **A salvaged interval is labelled.** If the browser is killed mid-interval
 *    there is no end event, and the honest end is the last heartbeat we
 *    recorded — not the time the browser next started, which would report an
 *    overnight session. Those rows carry `truncated: true` so downstream code
 *    can tell a measured span from a salvaged one.
 */

export const MIN_DURATION_MS = 1000;

// Longest interval we will emit. Nothing legitimate approaches this — idle
// detection closes intervals after a minute of no input — so exceeding it
// means the heartbeat stopped (laptop lid closed, process suspended). We clamp
// and flag rather than emit a 16-hour lie or drop the row silently.
export const MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;

function newId() {
  // crypto.randomUUID exists in MV3 service workers and in Node 19+.
  return globalThis.crypto.randomUUID();
}

export class FocusTracker {
  /**
   * @param {object} opts
   * @param {(interval: object) => void} opts.onInterval  called with each closed interval
   * @param {number} [opts.minDurationMs]  intervals shorter than this are dropped as switch noise
   * @param {() => string} [opts.idFactory]  client_id minting (injected in tests)
   */
  constructor({ onInterval, minDurationMs = MIN_DURATION_MS, idFactory = newId } = {}) {
    this.onInterval = onInterval || (() => {});
    this.minDurationMs = minDurationMs;
    this.idFactory = idFactory;
    /** @type {null | {url:string, host:string, path:string, title:string|null, startedAt:number, lastHeartbeatAt:number}} */
    this.open = null;
  }

  /** Serializable snapshot of the open interval (persisted after every event). */
  toJSON() {
    return this.open;
  }

  /** Restore a snapshot read back from storage after a service-worker restart. */
  load(open) {
    this.open = open || null;
  }

  /**
   * The user is now attending to this page. Closes whatever was open first.
   * Re-focusing the SAME url only refreshes the title + heartbeat: a tab that
   * regains focus after a blur starts a new interval (the blur closed it), but
   * a duplicate focus event for a page already open must not chop one span
   * into two.
   */
  focus({ url, host, path, title, at }) {
    if (this.open && this.open.url === url) {
      if (title) this.open.title = title;
      this.open.lastHeartbeatAt = Math.max(this.open.lastHeartbeatAt, at);
      return null;
    }
    const closed = this.open ? this._close(at, this.open.host === host ? "url_change" : "tab_change") : null;
    this.open = {
      url,
      host,
      path,
      title: title || null,
      startedAt: at,
      lastHeartbeatAt: at,
    };
    return closed;
  }

  /** Window lost focus, or every window did. A background window is not attention. */
  blur(at) {
    return this._close(at, "window_blur");
  }

  /**
   * Close because a POLL discovered the window is no longer focused, rather
   * than because an event said so.
   *
   * This exists because chrome.windows.onFocusChanged does NOT fire on macOS
   * when another application takes the foreground (verified against Chrome
   * 151: the listener is never called, though chrome.windows.getLastFocused()
   * correctly reports focused:false immediately). The heartbeat poll is
   * therefore the real detector of "he alt-tabbed away", and the honest end of
   * the interval is the last poll that CONFIRMED attention — not the poll that
   * discovered its absence, which would silently credit a whole heartbeat
   * period of another app's work to the browser.
   */
  blurStale() {
    if (!this.open) return null;
    return this._close(this.open.lastHeartbeatAt, "window_blur");
  }

  /**
   * chrome.idle went idle. `detectionMs` is the detection interval it was
   * configured with — the idle period had ALREADY elapsed when this fired, so
   * the interval ended that long ago.
   */
  idle(at, detectionMs = 0) {
    if (!this.open) return null;
    const endedAt = Math.max(this.open.startedAt, at - detectionMs);
    return this._close(endedAt, "idle");
  }

  /** Screen locked — unlike idle this is instantaneous, so no backdating. */
  lock(at) {
    return this._close(at, "locked");
  }

  /** Browser is going away and told us about it. */
  shutdown(at) {
    return this._close(at, "shutdown");
  }

  /** Keep-alive tick while an interval is open; the salvage anchor. */
  heartbeat(at) {
    if (this.open) this.open.lastHeartbeatAt = Math.max(this.open.lastHeartbeatAt, at);
  }

  /**
   * Called at startup when a snapshot was found on disk: the browser died
   * mid-interval. Close it at the last heartbeat, NOT at now — the gap between
   * them is time the browser wasn't running.
   */
  recoverOrphan() {
    if (!this.open) return null;
    return this._close(this.open.lastHeartbeatAt, "truncated", true);
  }

  /** Drop the open interval without emitting (used when config says stop). */
  discard() {
    this.open = null;
  }

  _close(at, reason, truncated = false) {
    const open = this.open;
    this.open = null;
    if (!open) return null;

    let endedAt = Math.max(open.startedAt, at);
    let flagged = truncated;
    if (endedAt - open.startedAt > MAX_INTERVAL_MS) {
      // The heartbeat is the last moment we can prove the browser was alive
      // and attending; prefer it, then hard-clamp.
      endedAt = Math.max(open.startedAt, Math.min(endedAt, open.lastHeartbeatAt));
      if (endedAt - open.startedAt > MAX_INTERVAL_MS) {
        endedAt = open.startedAt + MAX_INTERVAL_MS;
      }
      flagged = true;
    }

    if (endedAt - open.startedAt < this.minDurationMs) return null;

    const interval = {
      client_id: this.idFactory(),
      host: open.host,
      path: open.path,
      url: open.url,
      title: open.title,
      started_at: new Date(open.startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      end_reason: flagged && reason === "truncated" ? "truncated" : reason,
      truncated: flagged,
    };
    this.onInterval(interval);
    return interval;
  }
}
