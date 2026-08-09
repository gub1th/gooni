/**
 * Buffer-persistence + delivery net. A fake chrome.storage.local (a plain
 * object) stands in for the real one, so "survives a browser restart" is
 * testable: build a NEW IntervalBuffer over the same store and read it back.
 *
 * Run: cd extension && npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { IntervalBuffer, flushOnce, BUFFER_KEY } from "../src/buffer.js";

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

test("a 400 drops the poison batch instead of wedging the buffer forever", async () => {
  const storage = fakeStorage();
  const buf = new IntervalBuffer({ storage });
  await buf.append(interval("a"));
  const bad = async () => ({ ok: false, status: 400, json: async () => ({}) });
  await flushOnce({ buffer: buf, endpoint: "e", token: "t", fetchImpl: bad });
  assert.equal(await buf.size(), 0);
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
