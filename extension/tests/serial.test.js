/**
 * The storage read-modify-write mutex.
 *
 * chrome fires extension listeners back-to-back without awaiting them, so two
 * handlers interleave across their awaits. The storage fake here makes that
 * concrete: get() and set() each yield to the microtask queue, exactly like the
 * real chrome.storage.local, so an unserialized read → decide → write loses
 * updates deterministically.
 *
 * Run: cd extension && npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createSerializer } from "../src/serial.js";
import { IntervalBuffer } from "../src/buffer.js";
import { FocusTracker } from "../src/tracker.js";

/** chrome.storage.local, including the fact that every call is async. */
function slowStorage(initial = {}) {
  let data = JSON.parse(JSON.stringify(initial));
  return {
    async get(keys) {
      await Promise.resolve();
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = data[k];
      return JSON.parse(JSON.stringify(out));
    },
    async set(items) {
      await Promise.resolve();
      data = JSON.parse(JSON.stringify({ ...data, ...items }));
    },
  };
}

const interval = (id) => ({
  client_id: id,
  host: "leetcode.com",
  path: "/problems/two-sum/",
  url: "https://leetcode.com/problems/two-sum/",
  title: "Two Sum",
  started_at: "2026-08-08T17:00:00.000Z",
  ended_at: "2026-08-08T17:01:00.000Z",
  end_reason: "tab_change",
  truncated: false,
});

test("concurrent buffer appends lose one; serialized appends do not", async () => {
  // The control case: this is the bug, reproduced.
  const racy = new IntervalBuffer({ storage: slowStorage() });
  await Promise.all([racy.append(interval("a")), racy.append(interval("b"))]);
  assert.equal(await racy.size(), 1, "control: an unserialized append is lost");

  const serial = createSerializer();
  const buf = new IntervalBuffer({ storage: slowStorage() });
  await Promise.all([
    serial(() => buf.append(interval("a"))),
    serial(() => buf.append(interval("b"))),
  ]);
  assert.deepEqual(
    (await buf.peek()).map((i) => i.client_id),
    ["a", "b"],
    "serialized appends both land, in call order",
  );
});

test("concurrent reconciles close one span once, not twice", async () => {
  // Switching tabs delivers tabs.onActivated and tabs.onUpdated in the same
  // tick. Interleaved, both read the SAME open interval and both close it —
  // two client_ids for one span, which the server cannot dedup because the ids
  // differ by construction. That is a straight overcount of attention.
  const OPEN_KEY = "gooni_open_interval";
  let n = 0;
  const idFactory = () => `id-${++n}`;

  async function scenario(wrap) {
    const storage = slowStorage();
    const closed = [];
    // An interval is already open on the old tab.
    const seed = new FocusTracker({ idFactory });
    seed.focus({ url: "https://a.test/", host: "a.test", path: "/", title: "A", at: 1_000 });
    await storage.set({ [OPEN_KEY]: seed.toJSON() });

    const reconcile = async () => {
      const tracker = new FocusTracker({ onInterval: (i) => closed.push(i), idFactory });
      const got = await storage.get([OPEN_KEY]);
      tracker.load(got[OPEN_KEY] || null);
      tracker.focus({ url: "https://b.test/", host: "b.test", path: "/", title: "B", at: 60_000 });
      await storage.set({ [OPEN_KEY]: tracker.toJSON() });
    };

    await Promise.all([wrap(reconcile), wrap(reconcile)]);
    return closed;
  }

  const racy = await scenario((fn) => fn());
  assert.equal(racy.length, 2, "control: the interleave closes the same span twice");
  assert.equal(racy[0].started_at, racy[1].started_at, "control: same span, two ids");
  assert.notEqual(racy[0].client_id, racy[1].client_id, "control: undedupable by the server");

  const serial = createSerializer();
  const clean = await scenario((fn) => serial(fn));
  assert.equal(clean.length, 1, "serialized: one span closes exactly once");
  assert.equal(clean[0].host, "a.test");
});

test("a task that throws does not wedge the queue", async () => {
  // A handler that blows up must not strand every later chrome event behind it
  // — and its rejection still has to reach its own caller, not vanish.
  const serial = createSerializer();
  const order = [];

  const boom = serial(async () => {
    order.push("boom");
    throw new Error("handler failed");
  });
  const after = serial(async () => {
    order.push("after");
    return "ok";
  });

  await assert.rejects(boom, /handler failed/);
  assert.equal(await after, "ok");
  assert.deepEqual(order, ["boom", "after"]);
});

test("calls run strictly in the order they were made", async () => {
  const serial = createSerializer();
  const order = [];
  const task = (label, ticks) =>
    serial(async () => {
      for (let i = 0; i < ticks; i++) await Promise.resolve();
      order.push(label);
    });

  // The first task yields the most, so anything unserialized would finish out
  // of order.
  await Promise.all([task("first", 5), task("second", 2), task("third", 0)]);
  assert.deepEqual(order, ["first", "second", "third"]);
});
