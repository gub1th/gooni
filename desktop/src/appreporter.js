/**
 * Buffer + delivery for the frontmost-app sensor.
 *
 * The browser extension's `buffer.js`, restated for a shell that has a
 * filesystem instead of chrome.storage — and deliberately restated rather than
 * generalised, because the two run in different runtimes and a shared module
 * would have to abstract over both storages to save maybe forty lines.
 *
 * The rules ARE the extension's rules, and each one exists because losing
 * attention data is silent:
 *
 *  - **Retain by default.** A batch is destroyed ONLY on a status the server
 *    would refuse identically forever (400/413/422). 5xx, 429, 404, offline and
 *    timeouts all keep the buffer: a wrong `apiUrl` or an outage must cost a
 *    retry, not the day.
 *  - **Ack only what committed.** The server names `stored_ids`; those and the
 *    duplicates are what leave the buffer. An over-eager ack is permanent loss,
 *    an under-eager one costs a redelivery that dedups on `client_id`.
 *  - **The buffer is bounded, and overflow is COUNTED.** Past MAX_BUFFERED the
 *    oldest go, and the number that went is remembered — a gap the app admits
 *    to is a bug report; a gap it hides is a wrong answer. The same reasoning
 *    gives a lost state FILE its own third counter (`corrupted`), reported by
 *    the store: after that loss nothing else remembers it happened.
 *  - **One flush at a time.** Flushes are triggered by a timer AND by quit AND
 *    by the buffer filling; two overlapping flushes would post the same rows
 *    twice. (Harmless on the server, which dedups — but it would double-count
 *    `sent` and make the health report lie.)
 *
 * TWO stores, because the two things persisted here change at wildly different
 * rates. The interval buffer changes only when `add()` or a flush changes it.
 * The open-interval pointer is rewritten on EVERY sensor tick — deliberately,
 * since its `lastSeenAt` is the anchor a crash salvage closes at, and a stale
 * one would credit everything between the last write and the crash. Sharing one
 * file made every tick serialise and synchronously write the whole backlog: a
 * day-long outage buffers ~1MB of JSON, so a 4s poll wrote a megabyte to disk
 * every four seconds, on the main process, forever. `openStore` is optional —
 * without it the two collapse back into one file, which is still correct, just
 * expensive.
 *
 * Both are injected (`{read(), write(state)}`) so all of this is testable with
 * a plain object, no fs and no Electron.
 */

/** Past this many buffered intervals, the oldest are dropped and counted. */
const MAX_BUFFERED = 5000;
/** Most intervals in one POST. The server's own ceiling is 500. */
const MAX_BATCH = 200;

/**
 * Statuses that mean "this exact body will be refused identically forever":
 * a malformed batch (400), one past the server's size cap (413), one the server
 * can parse but not accept (422). Retrying any of them wedges every later
 * interval behind one poison batch, so the batch is destroyed and COUNTED.
 *
 * Everything else retains, and the exclusions are deliberate: 429 is Gooni's
 * own rate limiter (it stored nothing, so dropping would lose data the server
 * never saw), and 404 means the shell is pointed at the wrong host or a dev
 * port that isn't listening — a config mistake, not a bad payload.
 */
const DROP_BATCH_STATUSES = new Set([400, 413, 422]);

/** Longest Retry-After we honour; an absurd value can't wedge the sensor. */
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

/** Bound on one flush. Everything in the sensor's path has to settle. */
const FLUSH_TIMEOUT_MS = 20_000;

function parseRetryAfter(res, now) {
  const raw = res?.headers?.get?.("Retry-After");
  if (!raw) return 0;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.min(Math.max(0, when - now), MAX_RETRY_AFTER_MS);
  return 0;
}

class AppReporter {
  /**
   * @param {object} opts
   * @param {{read: () => object, write: (state: object) => void}} opts.store
   * @param {{read: () => object, write: (state: object) => void}} [opts.openStore]
   * @param {() => string} opts.getBaseUrl
   * @param {() => string} opts.getToken
   * @param {Function} [opts.fetchImpl]
   * @param {() => number} [opts.now]
   */
  constructor({
    store,
    openStore,
    getBaseUrl,
    getToken,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    maxBuffered = MAX_BUFFERED,
    maxBatch = MAX_BATCH,
    flushTimeoutMs = FLUSH_TIMEOUT_MS,
  } = {}) {
    this.store = store;
    this.openStore = openStore || null;
    this.getBaseUrl = getBaseUrl;
    this.getToken = getToken;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.maxBuffered = maxBuffered;
    this.maxBatch = maxBatch;
    this.flushTimeoutMs = flushTimeoutMs;

    const saved = store?.read?.() || {};
    const savedOpen = (this.openStore ? this.openStore.read?.() : saved) || {};
    /** @type {object[]} */
    this.buffered = Array.isArray(saved.buffered) ? saved.buffered : [];
    /** Intervals lost to buffer overflow (a very long outage). */
    this.dropped = Number(saved.dropped) || 0;
    /** Intervals destroyed because the server refused the batch. */
    this.refused = Number(saved.refused) || 0;
    // A THIRD cause of loss, deliberately not folded into either of the other
    // two: the state file itself was unreadable, so an unknown backlog went
    // with it — along with whatever `dropped`/`refused` had counted. The store
    // reports it (see jsonstore.js) because after that loss nothing else can.
    // Summed across BOTH files, since either can be the one that was lost.
    this.corrupted =
      (Number(saved.corrupted) || 0) + (this.openStore ? Number(savedOpen.corrupted) || 0 : 0);
    // The open interval, so a crash can be salvaged on the next launch.
    // `saved.open` is where it lived before the split: read it as a fallback so
    // the first launch after an upgrade still salvages whatever was open, and
    // only until the open store has written a key of its own.
    this.open = ("open" in savedOpen ? savedOpen.open : saved.open) || null;
    this._openJson = JSON.stringify(this.open);
    this.retryAfter = 0;
    this.lastFlush = null;
    this._flushing = null;

    // Write the count back immediately. The file it came from is the one that
    // was just lost, so a shell that senses nothing before quitting would
    // otherwise forget the loss ever happened — and the next launch, reading a
    // file it wrote itself, would look like a clean first run.
    if (this.corrupted) this._persist();
  }

  /** The batch state: the buffer and the two loss counters. */
  _persist() {
    const state = {
      buffered: this.buffered,
      dropped: this.dropped,
      refused: this.refused,
      corrupted: this.corrupted,
    };
    // Without a dedicated open store the two collapse back into one file, and
    // the anchor has to keep riding along or a crash loses it.
    if (!this.openStore) state.open = this.open;
    this.store?.write?.(state);
  }

  /** The salvage anchor alone — small, and rewritten every tick. */
  _persistOpen() {
    if (!this.openStore) return this._persist();
    this.openStore.write?.({ open: this.open });
  }

  /** Remember (or clear) the open interval so a crash is salvageable. */
  setOpen(open) {
    const next = open || null;
    const json = JSON.stringify(next);
    // A tick that moved nothing must not touch the disk at all: a machine
    // sitting idle overnight calls this every poll period with the same `null`.
    if (json === this._openJson) return;
    this.open = next;
    this._openJson = json;
    this._persistOpen();
  }

  add(interval) {
    if (!interval) return;
    this.buffered.push(interval);
    if (this.buffered.length > this.maxBuffered) {
      const overflow = this.buffered.length - this.maxBuffered;
      this.buffered.splice(0, overflow);
      this.dropped += overflow;
    }
    this._persist();
  }

  status() {
    return {
      buffered: this.buffered.length,
      dropped: this.dropped,
      refused: this.refused,
      corrupted: this.corrupted,
      lastFlush: this.lastFlush,
      retryAfter: this.retryAfter,
    };
  }

  /**
   * Send what's buffered. Never throws; returns a report.
   *
   * A concurrent caller JOINS the in-flight flush rather than starting a second
   * one — the timer, the quit path and the buffer-full trigger can all land at
   * once, and two flushes of one buffer would post the same rows twice.
   */
  flush() {
    if (this._flushing) return this._flushing;
    this._flushing = this._flushOnce().finally(() => {
      this._flushing = null;
    });
    return this._flushing;
  }

  async _flushOnce() {
    const at = this.now();
    if (!this.buffered.length) return this._record({ at, status: "empty", sent: 0 });
    if (at < this.retryAfter) {
      return this._record({ at, status: "backpressure", sent: 0 });
    }

    const base = String(this.getBaseUrl() || "").replace(/\/+$/, "");
    const token = this.getToken();
    if (!base) return this._record({ at, status: "not_configured", sent: 0 });
    if (!token) return this._record({ at, status: "not_authenticated", sent: 0 });

    const batch = this.buffered.slice(0, this.maxBatch);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.flushTimeoutMs);
    let res;
    try {
      res = await this.fetchImpl(`${base}/app/intervals`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ intervals: batch }),
        signal: controller.signal,
      });
    } catch (e) {
      // Offline, DNS, abort. RETAIN — the rows are still real.
      return this._record({ at, status: "error", error: e?.name === "AbortError" ? "timeout" : e.message, sent: 0 });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const wait = parseRetryAfter(res, at);
      if (wait) this.retryAfter = at + wait;
      if (DROP_BATCH_STATUSES.has(res.status)) {
        // The server will refuse this body identically forever. Destroy it —
        // and say so with a counter of its own, NOT the overflow counter: the
        // two are different losses and the report labels them differently.
        //
        // Removed by client_id, exactly the way the success path does it.
        // `batch` was captured before the await and `add()` can splice the
        // FRONT of the buffer for overflow while the request is in flight, so a
        // positional slice would destroy that many rows that were never sent
        // while leaving the same number of sent ones behind.
        const refusedIds = new Set(batch.map((iv) => iv.client_id));
        const heldBefore = this.buffered.length;
        this.buffered = this.buffered.filter((iv) => !refusedIds.has(iv.client_id));
        const destroyed = heldBefore - this.buffered.length;
        this.refused += destroyed;
        this._persist();
        return this._record({ at, status: "refused", httpStatus: res.status, destroyed, sent: 0 });
      }
      // 5xx, 429, 404, 401 — keep the buffer.
      return this._record({ at, status: "error", error: `http_${res.status}`, sent: 0 });
    }

    let body = null;
    try {
      body = await res.json();
    } catch {
      // A 200 we can't read is not proof anything committed. RETAIN; the
      // client_ids make the redelivery a no-op.
      return this._record({ at, status: "error", error: "unreadable_response", sent: 0 });
    }

    // A 2xx acks the WHOLE batch: the server took a position on every row in
    // it, whether that position was accepted, duplicate, or
    // rejected-with-a-reason. Trying to ack only `stored_ids` would strand
    // every duplicate in the buffer forever, because duplicates are counted and
    // not named — the buffer would grow monotonically on a replay.
    const rejected = Array.isArray(body?.rejected) ? body.rejected : [];
    const sent = new Set(batch.map((iv) => iv.client_id));
    this.buffered = this.buffered.filter((iv) => !sent.has(iv.client_id));
    // A per-row rejection is still a loss, and a different one from an overflow
    // drop. Counted so the tray can say so instead of calling it a clean flush.
    this.refused += rejected.length;
    this._persist();

    return this._record({
      at,
      status: "ok",
      sent: batch.length,
      accepted: Number(body?.accepted) || 0,
      duplicates: Number(body?.duplicates) || 0,
      rejected: rejected.length,
      firstRejectReason: rejected[0]?.reason || null,
    });
  }

  _record(report) {
    // Zero-sent flushes still record: "nothing buffered" and "no token" are
    // both things a human needs to be able to see, and the extension's bug was
    // exactly that its worst states never wrote a report at all.
    this.lastFlush = report;
    return report;
  }
}

/**
 * One line for the tray. Silent when healthy is NOT an option here — the tray
 * only shows this inside its own submenu — but the wording still has to make
 * "sensing and delivering" distinguishable from "sensing into a void".
 */
function describeReporter(status, { enabled, permission }) {
  if (!enabled) return "App sensor: off (disabled in config)";
  if (permission === false) {
    return "App sensor: NEEDS ACCESSIBILITY — grant it in System Settings ▸ Privacy";
  }
  const parts = [];
  const last = status.lastFlush;
  if (last?.status === "not_authenticated") parts.push("not signed in");
  else if (last?.status === "refused") parts.push(`server refused ${last.destroyed}`);
  else if (last?.status === "error") parts.push(`last send failed (${last.error})`);
  if (status.buffered) parts.push(`${status.buffered} buffered`);
  if (status.dropped) parts.push(`${status.dropped} dropped`);
  if (status.refused) parts.push(`${status.refused} destroyed`);
  // Never clears on its own, so it stays on the line: a backlog was lost with
  // the state file and the other two counts went with it.
  if (status.corrupted) parts.push(`state lost ${status.corrupted}×`);
  return `App sensor: ${parts.length ? parts.join(" · ") : "running"}`;
}

module.exports = {
  AppReporter,
  describeReporter,
  parseRetryAfter,
  DROP_BATCH_STATUSES,
  MAX_BUFFERED,
  MAX_BATCH,
  MAX_RETRY_AFTER_MS,
  FLUSH_TIMEOUT_MS,
};
