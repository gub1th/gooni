/**
 * The local buffer + flush loop.
 *
 * One request per tab switch would be absurd — Daniel switches constantly and
 * the browser is regularly offline (laptop shut, plane, dead wifi). So every
 * closed interval is appended to chrome.storage.local and flushed in batches,
 * on a timer AND on a size threshold.
 *
 * Storage is injected (an object with async get/set over a single key) so this
 * is testable without chrome, and `fetch` is injected for the same reason.
 *
 * Delivery rules that matter:
 *
 *  - **Nothing is removed until the server has it.** A batch is peeked, POSTed,
 *    and only the ids the server confirms it holds (accepted OR duplicate —
 *    both mean "landed") are dropped from the buffer. A 500, a timeout or an
 *    offline browser leaves the buffer untouched and the next flush retries.
 *  - **Retries can't double-count.** Each interval's `client_id` is minted once
 *    at close and never regenerated, so a batch the server actually stored but
 *    whose response we never saw dedups on the way back in.
 *  - **The buffer is bounded.** Past MAX_BUFFERED intervals (a multi-week
 *    outage) the OLDEST are dropped, and the count of dropped intervals is
 *    kept so the extension can admit to a gap rather than quietly pretend the
 *    log is complete.
 */

export const BUFFER_KEY = "gooni_interval_buffer";
export const DROPPED_KEY = "gooni_dropped_count";

/**
 * Intervals destroyed because the SERVER refused the batch outright
 * (DROP_BATCH_STATUSES). Deliberately a second counter rather than a reuse of
 * DROPPED_KEY: that one means "buffer overflow after a very long outage", and
 * the options page says so. Folding a server refusal into it would swap one
 * wrong number for another. Both are durable — a refusal that only showed up
 * in `gooni_last_flush` would vanish the moment the next flush overwrote it.
 */
export const REFUSED_KEY = "gooni_refused_count";

/** The transient record of the most recent flush, read by the options page. */
export const LAST_FLUSH_KEY = "gooni_last_flush";

/** Epoch ms before which we honour a server's Retry-After and don't flush. */
export const RETRY_UNTIL_KEY = "gooni_retry_until";
export const MAX_BUFFERED = 5000;
export const FLUSH_THRESHOLD = 25;
export const MAX_BATCH = 200;

/**
 * The ONLY statuses that justify throwing a batch away.
 *
 * Dropping is an irreversible admission that this data will never be
 * deliverable, so the list is an allowlist of shapes that would fail
 * identically forever: a malformed body (400), a body over the server's size
 * cap (413), a body the server can parse but not accept (422). Retrying any of
 * those verbatim wedges the buffer behind one poison batch.
 *
 * Everything else keeps the buffer, including the two that used to fall into
 * the drop branch and cost real measurements:
 *   - 429: Gooni's own rate limiter (300/min per IP, shared with the SPA's
 *     polling surfaces) returns this during a burst. The server stored nothing;
 *     dropping would destroy up to a full batch of intervals for a condition
 *     that clears in seconds.
 *   - 404: a baseUrl pointing at the wrong host or dev port. That is a config
 *     mistake to be fixed in options, and the buffer is what makes the fix
 *     recover the backlog instead of starting from empty.
 * A permanently-wrong baseUrl still can't grow the buffer without bound —
 * MAX_BUFFERED drops the oldest and COUNTS the loss, so the gap is admitted.
 */
export const DROP_BATCH_STATUSES = new Set([400, 413, 422]);

/** Longest Retry-After we'll respect; a hostile or absurd value can't wedge us. */
export const MAX_RETRY_AFTER_SEC = 15 * 60;

/**
 * How long a flush waits for the server before giving up on the request.
 *
 * Same policy as the idle probe's IDLE_PROBE_TIMEOUT_MS, for the same reason:
 * every flush runs inside the one-slot serial queue, so a request that never
 * settles holds that slot and every later tab switch, blur and heartbeat queues
 * behind it — the tracker stops updating `lastHeartbeatAt` and the sensor is
 * silently dead. A server that accepts the connection and then goes quiet (a
 * hung dev process, a captive-portal proxy) is exactly that case, and it is
 * invisible without a bound because nothing errors.
 *
 * A timeout is RETRYABLE, not a drop: the server may well have stored the batch
 * and only the response was lost, and the client_ids dedup on the way back in.
 * Losing buffered attention because a socket went quiet would be the same
 * data-loss class the 429/404 retention rules already closed.
 */
export const FLUSH_TIMEOUT_MS = 20000;

/**
 * Retry-After as seconds, from either header form (delta-seconds or HTTP-date).
 * Null when absent/unparseable — the caller then uses its normal flush cadence.
 */
/**
 * Persist the outcome of a flush.
 *
 * A NO-OP flush leaves the previous record standing. The flush alarm fires
 * every 60s regardless of buffer state, and the buffer is empty immediately
 * after any successful flush, so writing a `{sent: 0}` record unconditionally
 * erased the informative one within a minute — every minute.
 *
 * That erasure is not cosmetic. Buffer overflow has DROPPED_KEY and a refused
 * batch has REFUSED_KEY, but a server-REJECTED row is acked and deleted from
 * the buffer exactly like an accepted one, so this record is the ONLY trace it
 * ever existed. The reachable case with no bug anywhere: a clock >5min fast
 * makes the server reject every row as `future`; the flush that reports it is
 * overwritten 60s later and the panel goes back to reading like a clean flush.
 *
 * The record is transient by nature even so — the durable counters stay the
 * authoritative signal, and the panel should trust them if the two disagree.
 *
 * `retryAfterSec` bookkeeping is written either way: it is about the NEXT
 * flush, not a report of this one.
 */
export async function recordFlush(
  storage,
  res,
  { at = new Date().toISOString(), now = Date.now() } = {}
) {
  const patch = {
    [RETRY_UNTIL_KEY]: res?.retryAfterSec ? now + res.retryAfterSec * 1000 : 0,
  };
  const record = (res?.sent ?? 0) > 0 ? { at, ...res } : null;
  if (record) patch[LAST_FLUSH_KEY] = record;
  await storage.set(patch);
  return record;
}

export function retryAfterSeconds(res, now = Date.now()) {
  const raw = res?.headers?.get?.("Retry-After");
  if (raw === null || raw === undefined || raw === "") return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0), MAX_RETRY_AFTER_SEC);
  const when = Date.parse(String(raw));
  if (Number.isFinite(when)) {
    return Math.min(Math.max((when - now) / 1000, 0), MAX_RETRY_AFTER_SEC);
  }
  return null;
}

export class IntervalBuffer {
  /**
   * @param {object} opts
   * @param {{get:(keys:any)=>Promise<object>, set:(items:object)=>Promise<void>}} opts.storage
   */
  constructor({ storage, maxBuffered = MAX_BUFFERED, maxBatch = MAX_BATCH } = {}) {
    this.storage = storage;
    this.maxBuffered = maxBuffered;
    this.maxBatch = maxBatch;
  }

  async _read() {
    const got = (await this.storage.get([BUFFER_KEY, DROPPED_KEY, REFUSED_KEY])) || {};
    return {
      items: Array.isArray(got[BUFFER_KEY]) ? got[BUFFER_KEY] : [],
      dropped: Number(got[DROPPED_KEY]) || 0,
      refused: Number(got[REFUSED_KEY]) || 0,
    };
  }

  async _write(items, dropped, refused) {
    await this.storage.set({
      [BUFFER_KEY]: items,
      [DROPPED_KEY]: dropped,
      [REFUSED_KEY]: refused,
    });
  }

  /** Persist one closed interval. Returns the new buffer length. */
  async append(interval) {
    const { items, dropped, refused } = await this._read();
    items.push(interval);
    let newDropped = dropped;
    if (items.length > this.maxBuffered) {
      const overflow = items.length - this.maxBuffered;
      items.splice(0, overflow);
      newDropped += overflow;
    }
    await this._write(items, newDropped, refused);
    return items.length;
  }

  async size() {
    return (await this._read()).items.length;
  }

  /** Intervals lost to buffer OVERFLOW. */
  async droppedCount() {
    return (await this._read()).dropped;
  }

  /** Intervals destroyed because the server REFUSED the batch. */
  async refusedCount() {
    return (await this._read()).refused;
  }

  /** Oldest-first peek. Does NOT remove — delivery has to be proven first. */
  async peek(n = this.maxBatch) {
    const { items } = await this._read();
    return items.slice(0, n);
  }

  /** Remove the given client_ids once the server confirms it holds them. */
  async ack(clientIds) {
    const gone = new Set(clientIds);
    const { items, dropped, refused } = await this._read();
    const kept = items.filter((i) => !gone.has(i.client_id));
    await this._write(kept, dropped, refused);
    return kept.length;
  }

  /**
   * Throw away a batch the server refused outright, COUNTING what was
   * destroyed. Separate from `ack` on purpose: ack means "the server has it",
   * this means "nobody will ever have it", and the difference has to reach the
   * options page or the panel reports irreversible loss as a quiet http_400.
   */
  async discardRefused(clientIds) {
    const gone = new Set(clientIds);
    const { items, dropped, refused } = await this._read();
    const kept = items.filter((i) => !gone.has(i.client_id));
    const destroyed = items.length - kept.length;
    await this._write(kept, dropped, refused + destroyed);
    return { remaining: kept.length, destroyed };
  }
}

/**
 * Ship one batch. Returns { sent, delivered, remaining, ok, error?, retryAfterSec? }.
 *
 * A 2xx acks: the server took a position on every row, whether it counted them
 * accepted, duplicate, or rejected-with-a-reason. Otherwise the buffer is KEPT
 * unless the status is in DROP_BATCH_STATUSES — see that constant for why the
 * drop branch is an allowlist rather than a catch-all.
 */
export async function flushOnce({
  buffer,
  endpoint,
  token,
  fetchImpl = fetch,
  timeoutMs = FLUSH_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const batch = await buffer.peek();
  if (batch.length === 0) return { sent: 0, delivered: 0, remaining: 0, ok: true };
  if (!endpoint || !token) {
    return { sent: 0, delivered: 0, remaining: batch.length, ok: false, error: "not_configured" };
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  let res;
  try {
    const request = fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ intervals: batch }),
      signal: controller ? controller.signal : undefined,
    });
    // Abort AND race. The signal is what frees the socket, but a fetch that
    // ignores it would still never settle, and this slot has to be given back
    // either way — the race is what guarantees that.
    res =
      timeoutMs > 0
        ? await Promise.race([
            request,
            new Promise((_, reject) => {
              timer = setTimer(() => {
                if (controller) controller.abort();
                reject(new Error("flush_timeout"));
              }, timeoutMs);
            }),
          ])
        : await request;
  } catch (e) {
    // Offline / DNS / TLS / a server that went quiet. Buffer untouched; next
    // flush retries.
    return { sent: batch.length, delivered: 0, remaining: await buffer.size(), ok: false, error: String(e) };
  } finally {
    if (timer !== null) clearTimer(timer);
  }

  if (res.status === 401 || res.status === 403) {
    // A bad token is a config problem, not a data problem — keep the buffer so
    // fixing the token in options recovers everything.
    return { sent: batch.length, delivered: 0, remaining: await buffer.size(), ok: false, error: "unauthorized" };
  }
  if (!res.ok && DROP_BATCH_STATUSES.has(res.status)) {
    // The server refused this batch SHAPE. Retrying it verbatim will fail
    // identically forever, so drop it — and COUNT the loss, both in the result
    // and in a durable counter. These intervals are gone for good; a flush
    // result that only said `error http_400` rendered that as a bad request
    // rather than as attention that no longer exists anywhere.
    const { remaining, destroyed } = await buffer.discardRefused(
      batch.map((i) => i.client_id)
    );
    return {
      sent: batch.length,
      delivered: 0,
      dropped: destroyed,
      remaining,
      ok: false,
      error: `http_${res.status}`,
    };
  }
  if (!res.ok) {
    // Everything else — 5xx, 429, 404, 408 — keeps the buffer. Retaining data
    // the server never stored is the default; dropping is the exception.
    return {
      sent: batch.length,
      delivered: 0,
      remaining: await buffer.size(),
      ok: false,
      error: `http_${res.status}`,
      retryAfterSec: retryAfterSeconds(res),
    };
  }

  // 2xx: everything in the batch is now the server's problem, whether it
  // counted as accepted, duplicate, or rejected-with-a-reason.
  const remaining = await buffer.ack(batch.map((i) => i.client_id));
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  // A rejected row was ACKED like any other and is now gone from the buffer,
  // so the reason is the only trace it ever existed. Carry the first one up:
  // "sent 200, accepted 0" with no explanation is indistinguishable from a
  // clean flush, and the clock-skew case (every row rejected as `future`)
  // reads as success while the data is permanently lost.
  const rejectedRows = body.rejected || [];
  return {
    sent: batch.length,
    delivered: batch.length,
    accepted: body.accepted,
    duplicates: body.duplicates,
    rejected: rejectedRows.length,
    rejectedReason: rejectedRows[0]?.reason || null,
    remaining,
    ok: true,
  };
}
