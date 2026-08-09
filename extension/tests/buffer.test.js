/**
 * Buffer-persistence + delivery net. A fake chrome.storage.local (a plain
 * object) stands in for the real one, so "survives a browser restart" is
 * testable: build a NEW IntervalBuffer over the same store and read it back.
 *
 * Run: cd extension && npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  IntervalBuffer,
  flushOnce,
  retryAfterSeconds,
  BUFFER_KEY,
  MAX_RETRY_AFTER_SEC,
} from "../src/buffer.js";

/** Stand-in for chrome.storage.local: survives across IntervalBuffer instances. */
function fakeStorage(initial = {}) {
  // JSON round-trip on every write, like the real thing — catches anything
  // that only works because an in-memory object reference was shared.
  let data = JSON.parse(JSON.stringify(initial));
  return {
    _dump: () => data,
    async get(keys) {
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = data[k];
      return JSON.parse(JSON.stringify(out));
    },
    async set(items) {
      data = JSON.parse(JSON.stringify({ ...data, ...items }));
    },
  };
}

const interval = (id, host = "leetcode.com") => ({
  client_id: id,
  host,
  path: "/problems/two-sum/",
  url: `https://${host}/problems/two-sum/`,
  title: "Two Sum",
  started_at: "2026-08-08T17:00:00.000Z",
  ended_at: "2026-08-08T17:01:00.000Z",
  end_reason: "tab_change",
  truncated: false,
});

test("buffered intervals survive a browser restart", async () => {
  const storage = fakeStorage();
  const buf = new IntervalBuffer({ storage });
  await buf.append(interval("a"));
  await buf.append(interval("b"));

  // Browser dies. New process, new objects, same storage.
  const revived = new IntervalBuffer({ storage });
  assert.equal(await revived.size(), 2);
  assert.deepEqual((await revived.peek()).map((i) => i.client_id), ["a", "b"]);
});

test("nothing is removed until the server confirms it", async () => {
  const storage = fakeStorage();
  const buf = new IntervalBuffer({ storage });
  await buf.append(interval("a"));
  await buf.append(interval("b"));

  const offline = async () => {
    throw new Error("net::ERR_INTERNET_DISCONNECTED");
  };
  const res = await flushOnce({
    buffer: buf,
    endpoint: "http://localhost:8000/browser/intervals",
    token: "t",
    fetchImpl: offline,
  });
  assert.equal(res.ok, false);
  assert.equal(await buf.size(), 2, "offline flush must not lose the buffer");
});

test("a 5xx keeps the buffer; a 2xx clears exactly what was sent", async () => {
  const storage = fakeStorage();
  const buf = new IntervalBuffer({ storage });
  await buf.append(interval("a"));

  const boom = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await flushOnce({ buffer: buf, endpoint: "e", token: "t", fetchImpl: boom });
  assert.equal(await buf.size(), 1);

  let body = null;
  const ok = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ accepted: 1, duplicates: 0, rejected: [] }) };
  };
  const res = await flushOnce({ buffer: buf, endpoint: "e", token: "t", fetchImpl: ok });
  assert.equal(res.ok, true);
  assert.equal(body.intervals.length, 1);
  assert.equal(await buf.size(), 0);
});

test("intervals appended during a flush are not lost by the ack", async () => {
  const storage = fakeStorage();
  const buf = new IntervalBuffer({ storage });
  await buf.append(interval("a"));

  const slow = async () => {
    // A new interval closes while the request is in flight.
    await buf.append(interval("b"));
    return { ok: true, status: 200, json: async () => ({ accepted: 1 }) };
  };
  await flushOnce({ buffer: buf, endpoint: "e", token: "t", fetchImpl: slow });

  // ack() removes by id, not by count, so "b" is still queued.
  assert.deepEqual((await buf.peek()).map((i) => i.client_id), ["b"]);
});

test("a 401 keeps the buffer so fixing the token recovers everything", async () => {
  const storage = fakeStorage();
  const buf = new IntervalBuffer({ storage });
  await buf.append(interval("a"));
  const unauthorized = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const res = await flushOnce({ buffer: buf, endpoint: "e", token: "bad", fetchImpl: unauthorized });
  assert.equal(res.error, "unauthorized");
  assert.equal(await buf.size(), 1);
});

test("only a permanently-broken batch shape is dropped", async () => {
  // 400/413/422 all mean "this body will be refused identically forever", so
  // retrying wedges the buffer behind one poison batch.
  for (const status of [400, 413, 422]) {
    const storage = fakeStorage();
    const buf = new IntervalBuffer({ storage });
    await buf.append(interval("a"));
    const bad = async () => ({ ok: false, status, json: async () => ({}) });
    await flushOnce({ buffer: buf, endpoint: "e", token: "t", fetchImpl: bad });
    assert.equal(await buf.size(), 0, `status ${status} should drop the batch`);
  }
});

test("a 429 keeps the buffer — the server stored nothing", async () => {
  const storage = fakeStorage();
  const buf = new IntervalBuffer({ storage });
  await buf.append(interval("a"));
  await buf.append(interval("b"));

  // Gooni's rate limiter (300/min per IP, shared with the SPA's polling
  // surfaces) answers a burst this way. Dropping here destroys real
  // measurements for a condition that clears in seconds.
  const limited = async () => ({
    ok: false,
    status: 429,
    headers: { get: (h) => (h === "Retry-After" ? "30" : null) },
    json: async () => ({}),
  });
  const res = await flushOnce({ buffer: buf, endpoint: "e", token: "t", fetchImpl: limited });

  assert.equal(res.ok, false);
  assert.equal(res.delivered, 0);
  assert.equal(await buf.size(), 2, "a rate-limited flush must not eat the buffer");
  assert.equal(res.retryAfterSec, 30, "Retry-After is surfaced so the caller can back off");

  // …and the same intervals go out again on the next flush, unchanged ids.
  let sent = null;
  const ok = async (_url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ accepted: 2 }) };
  };
  await flushOnce({ buffer: buf, endpoint: "e", token: "t", fetchImpl: ok });
  assert.deepEqual(sent.intervals.map((i) => i.client_id), ["a", "b"]);
  assert.equal(await buf.size(), 0);
});

test("a server that never answers times out, keeps the buffer, and gives the slot back", async () => {
  const storage = fakeStorage();
  const buf = new IntervalBuffer({ storage });
  await buf.append(interval("a"));
  await buf.append(interval("b"));

  // A hung dev process or a captive-portal proxy: the connection is accepted
  // and then nothing comes back, ever. Every flush runs inside the one-slot
  // serial queue, so without a bound this holds the slot and every later tab
  // switch, blur and heartbeat queues behind it — a silently dead sensor.
  let aborted = false;
  const neverAnswers = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("AbortError"));
      });
    });

  const res = await flushOnce({
    buffer: buf,
    endpoint: "e",
    token: "t",
    fetchImpl: neverAnswers,
    timeoutMs: 5,
  });

  assert.equal(res.ok, false);
  assert.equal(res.delivered, 0);
  assert.equal(aborted, true, "the in-flight request must actually be aborted");
  assert.equal(await buf.size(), 2, "a timed-out flush must not lose the buffer");

  // The retry goes out with the SAME ids, so a batch the server did store but
  // whose response was lost dedups instead of double-counting.
  let sent = null;
  const ok = async (_url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ accepted: 2 }) };
  };
  await flushOnce({ buffer: buf, endpoint: "e", token: "t", fetchImpl: ok });
  assert.deepEqual(sent.intervals.map((i) => i.client_id), ["a", "b"]);
  assert.equal(await buf.size(), 0);
});

test("a fetch that ignores the abort signal still gives the slot back", async () => {
  // The signal is what frees the socket; the race is what guarantees the queue
  // slot comes back. An impl that never settles and never honours abort proves
  // the second is not leaning on the first.
  const storage = fakeStorage();
  const buf = new IntervalBuffer({ storage });
  await buf.append(interval("a"));

  const res = await flushOnce({
    buffer: buf,
    endpoint: "e",
    token: "t",
    fetchImpl: () => new Promise(() => {}),
    timeoutMs: 5,
  });

  assert.equal(res.ok, false);
  assert.match(res.error, /flush_timeout/);
  assert.equal(await buf.size(), 1);
});

test("a 404 keeps the buffer so fixing baseUrl recovers the backlog", async () => {
  const storage = fakeStorage();
  const buf = new IntervalBuffer({ storage });
  await buf.append(interval("a"));

  // A stale Fly host or the wrong dev port. That is a config mistake, and the
  // buffer is the only reason fixing it doesn't start from empty.
  const missing = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const res = await flushOnce({ buffer: buf, endpoint: "e", token: "t", fetchImpl: missing });
  assert.equal(res.error, "http_404");
  assert.equal(await buf.size(), 1);
});

test("Retry-After is read in both header forms and never wedges us", () => {
  const now = Date.UTC(2026, 7, 8, 17, 0, 0);
  const withHeader = (v) => ({ headers: { get: () => v } });

  assert.equal(retryAfterSeconds(withHeader("30"), now), 30);
  // HTTP-date form.
  assert.equal(retryAfterSeconds(withHeader("Sat, 08 Aug 2026 17:00:45 GMT"), now), 45);
  // A date already past means "go now", not a negative delay.
  assert.equal(retryAfterSeconds(withHeader("Sat, 08 Aug 2026 16:00:00 GMT"), now), 0);
  // An absurd or hostile value is capped rather than parking the sensor.
  assert.equal(retryAfterSeconds(withHeader("999999"), now), MAX_RETRY_AFTER_SEC);
  assert.equal(retryAfterSeconds(withHeader("soon"), now), null);
  assert.equal(retryAfterSeconds(withHeader(null), now), null);
  // Responses from a fetch impl that models no headers at all.
  assert.equal(retryAfterSeconds({}, now), null);
});

test("an unconfigured extension keeps buffering rather than dropping", async () => {
  const storage = fakeStorage();
  const buf = new IntervalBuffer({ storage });
  await buf.append(interval("a"));
  const res = await flushOnce({ buffer: buf, endpoint: "", token: "", fetchImpl: async () => { throw new Error("never"); } });
  assert.equal(res.error, "not_configured");
  assert.equal(await buf.size(), 1);
});

test("buffer overflow drops the OLDEST and counts the loss", async () => {
  const storage = fakeStorage();
  const buf = new IntervalBuffer({ storage, maxBuffered: 3 });
  for (const id of ["a", "b", "c", "d", "e"]) await buf.append(interval(id));
  assert.deepEqual((await buf.peek()).map((i) => i.client_id), ["c", "d", "e"]);
  assert.equal(await buf.droppedCount(), 2, "the gap is admitted, not hidden");
});

test("a batch is capped so one flush can't post the whole backlog", async () => {
  const storage = fakeStorage();
  const buf = new IntervalBuffer({ storage, maxBatch: 2 });
  for (const id of ["a", "b", "c"]) await buf.append(interval(id));
  assert.deepEqual((await buf.peek()).map((i) => i.client_id), ["a", "b"]);
});

test("a corrupt buffer key degrades to empty rather than throwing", async () => {
  const storage = fakeStorage({ [BUFFER_KEY]: "not an array" });
  const buf = new IntervalBuffer({ storage });
  assert.equal(await buf.size(), 0);
  await buf.append(interval("a"));
  assert.equal(await buf.size(), 1);
});
