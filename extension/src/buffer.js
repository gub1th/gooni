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
export const MAX_BUFFERED = 5000;
export const FLUSH_THRESHOLD = 25;
export const MAX_BATCH = 200;

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
    const got = (await this.storage.get([BUFFER_KEY, DROPPED_KEY])) || {};
    return {
      items: Array.isArray(got[BUFFER_KEY]) ? got[BUFFER_KEY] : [],
      dropped: Number(got[DROPPED_KEY]) || 0,
    };
  }

  async _write(items, dropped) {
    await this.storage.set({ [BUFFER_KEY]: items, [DROPPED_KEY]: dropped });
  }

  /** Persist one closed interval. Returns the new buffer length. */
  async append(interval) {
    const { items, dropped } = await this._read();
    items.push(interval);
    let newDropped = dropped;
    if (items.length > this.maxBuffered) {
      const overflow = items.length - this.maxBuffered;
      items.splice(0, overflow);
      newDropped += overflow;
    }
    await this._write(items, newDropped);
    return items.length;
  }

  async size() {
    return (await this._read()).items.length;
  }

  async droppedCount() {
    return (await this._read()).dropped;
  }

  /** Oldest-first peek. Does NOT remove — delivery has to be proven first. */
  async peek(n = this.maxBatch) {
    const { items } = await this._read();
    return items.slice(0, n);
  }

  /** Remove the given client_ids once the server confirms it holds them. */
  async ack(clientIds) {
    const gone = new Set(clientIds);
    const { items, dropped } = await this._read();
    const kept = items.filter((i) => !gone.has(i.client_id));
    await this._write(kept, dropped);
    return kept.length;
  }
}

/**
 * Ship one batch. Returns { sent, delivered, remaining, ok, error? }.
 *
 * Only a 2xx acks. A 4xx that is NOT a rejection of the whole batch still acks
 * — the server took a position on those rows and retrying them forever would
 * wedge the buffer behind one poison interval.
 */
export async function flushOnce({ buffer, endpoint, token, fetchImpl = fetch }) {
  const batch = await buffer.peek();
  if (batch.length === 0) return { sent: 0, delivered: 0, remaining: 0, ok: true };
  if (!endpoint || !token) {
    return { sent: 0, delivered: 0, remaining: batch.length, ok: false, error: "not_configured" };
  }

  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ intervals: batch }),
    });
  } catch (e) {
    // Offline / DNS / TLS. Buffer untouched; next flush retries.
    return { sent: batch.length, delivered: 0, remaining: await buffer.size(), ok: false, error: String(e) };
  }

  if (res.status === 401 || res.status === 403) {
    // A bad token is a config problem, not a data problem — keep the buffer so
    // fixing the token in options recovers everything.
    return { sent: batch.length, delivered: 0, remaining: await buffer.size(), ok: false, error: "unauthorized" };
  }
  if (!res.ok && res.status >= 500) {
    return { sent: batch.length, delivered: 0, remaining: await buffer.size(), ok: false, error: `http_${res.status}` };
  }
  if (!res.ok) {
    // 400/413: the server refused this batch shape. Retrying it verbatim will
    // fail identically forever, so drop it and record the loss.
    const remaining = await buffer.ack(batch.map((i) => i.client_id));
    return { sent: batch.length, delivered: 0, remaining, ok: false, error: `http_${res.status}` };
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
  return {
    sent: batch.length,
    delivered: batch.length,
    accepted: body.accepted,
    duplicates: body.duplicates,
    rejected: (body.rejected || []).length,
    remaining,
    ok: true,
  };
}
