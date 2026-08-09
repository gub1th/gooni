/**
 * The attention decision — "is the human here, and on what?"
 *
 * These drive the REAL `resolveAttention` + `applyAttention` + `FocusTracker`,
 * with only chrome's four probes faked. That composition is exactly what
 * background.js's reconcile() runs, so the reconcile loop itself is under test
 * rather than a paraphrase of it.
 *
 * The bug these pin: a focused Chrome window is not an attending human. Walking
 * away does not unfocus the window, so before the idle probe existed the 30s
 * heartbeat re-opened an interval that chrome.idle had just correctly closed,
 * and an idle machine accrued focus time — the exact lie chrome.idle exists to
 * prevent, and one the server cannot detect.
 *
 * Run: cd extension && npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolveAttention, applyAttention, makeIdleProbe } from "../src/attention.js";
import { FocusTracker } from "../src/tracker.js";

const IDLE_DETECTION_MS = 60_000;

/**
 * A fake machine: one focused Chrome window on a page, plus an idle state we
 * drive by hand. `reconcile` is background.js's reconcile, minus chrome and
 * minus the storage round-trip (the tracker is held directly instead).
 */
function machine({ idleState = "active", url = "https://leetcode.com/problems/two-sum/" } = {}) {
  const closed = [];
  let n = 0;
  const tracker = new FocusTracker({
    onInterval: (i) => closed.push(i),
    idFactory: () => `id-${++n}`,
  });
  const state = { idleState, url, focused: true, enabled: true };

  const probes = {
    getIdleState: async () => state.idleState,
    getFocusedWindow: async () => (state.focused ? { id: 1, focused: true } : null),
    getActiveTab: async () => ({ url: state.url, title: "Two Sum" }),
    scrubPage: (raw) => {
      const u = new URL(raw);
      return { url: raw, host: u.hostname, path: u.pathname };
    },
  };

  return {
    state,
    tracker,
    closed,
    async reconcile(at, { staleClose = false } = {}) {
      const page = await resolveAttention(probes);
      applyAttention(tracker, page, { at, staleClose, enabled: state.enabled });
    },
  };
}

test("an idle machine accrues no focus time, however long it sits", async () => {
  const m = machine();

  // Real attention for ten minutes, Chrome focused the whole time with the
  // heartbeat ticking.
  await m.reconcile(0);
  for (let t = 30_000; t <= 600_000; t += 30_000) {
    await m.reconcile(t, { staleClose: true });
  }
  assert.equal(m.closed.length, 0, "one continuous span stays open while attended");

  // He walks away. 60s later chrome.idle fires; the interval closes backdated
  // to when input actually stopped.
  const idleFiredAt = 660_000;
  m.state.idleState = "idle";
  m.tracker.idle(idleFiredAt, IDLE_DETECTION_MS);
  assert.equal(m.closed.length, 1);
  assert.equal(m.closed[0].end_reason, "idle");
  assert.equal(
    m.closed[0].ended_at,
    new Date(idleFiredAt - IDLE_DETECTION_MS).toISOString(),
    "idle close is backdated by the detection interval",
  );

  // A two-hour lunch. Chrome stays focused on the same tab the entire time and
  // the heartbeat keeps firing — this is where the interval used to re-open.
  for (let t = idleFiredAt + 30_000; t <= idleFiredAt + 2 * 60 * 60_000; t += 30_000) {
    await m.reconcile(t, { staleClose: true });
  }

  assert.equal(m.closed.length, 1, "no interval may be opened or emitted while idle");
  assert.equal(m.tracker.toJSON(), null, "nothing is left open across the idle stretch");
});

test("a locked screen is not attention either", async () => {
  const m = machine();
  await m.reconcile(0);
  m.state.idleState = "locked";
  m.tracker.lock(60_000);
  assert.equal(m.closed.length, 1);

  await m.reconcile(90_000, { staleClose: true });
  assert.equal(m.tracker.toJSON(), null, "a heartbeat must not re-open on a locked machine");
});

test("accrual restarts when input resumes, not backdated to the idle stretch", async () => {
  const m = machine();
  m.state.idleState = "idle";

  // Heartbeats through the idle stretch open nothing.
  await m.reconcile(0, { staleClose: true });
  await m.reconcile(30_000, { staleClose: true });
  assert.equal(m.tracker.toJSON(), null);

  // He touches the keyboard: chrome.idle fires "active" and reconcile runs.
  const resumedAt = 3_600_000;
  m.state.idleState = "active";
  await m.reconcile(resumedAt);

  const open = m.tracker.toJSON();
  assert.equal(open.startedAt, resumedAt, "the new span starts when input resumed");

  // Close it and confirm the emitted row covers only the attended minute.
  await m.reconcile(resumedAt + 60_000);
  m.state.focused = false;
  await m.reconcile(resumedAt + 120_000);

  assert.equal(m.closed.length, 1);
  assert.equal(m.closed[0].started_at, new Date(resumedAt).toISOString());
  assert.equal(
    m.closed[0].ended_at,
    new Date(resumedAt + 120_000).toISOString(),
    "only time after the resume is credited",
  );
});

test("a heartbeat that discovers idle closes at the last confirmed beat", async () => {
  // The worker can be asleep when chrome.idle fires, so onStateChanged is not
  // guaranteed. The heartbeat's own idle probe is the backstop, and it must
  // close at the last beat that CONFIRMED attention — an undercount, never a
  // gift of the whole poll period.
  const m = machine();
  await m.reconcile(0);
  await m.reconcile(30_000, { staleClose: true });

  m.state.idleState = "idle";
  await m.reconcile(600_000, { staleClose: true });

  assert.equal(m.closed.length, 1);
  assert.equal(
    m.closed[0].ended_at,
    new Date(30_000).toISOString(),
    "closes at the last confirmed heartbeat, not at discovery",
  );
});

test("anything other than a clear 'active' means no attention", async () => {
  for (const answer of [undefined, null, "", "idle", "locked", "ACTIVE"]) {
    const page = await resolveAttention({
      getIdleState: async () => answer,
      getFocusedWindow: async () => ({ id: 1, focused: true }),
      getActiveTab: async () => ({ url: "https://a.test/", title: "A" }),
      scrubPage: () => ({ url: "https://a.test/", host: "a.test", path: "/" }),
    });
    assert.equal(page, null, `idle answer ${JSON.stringify(answer)} must mean no attention`);
  }
});

test("the idle probe fails closed and always settles", async () => {
  // Failing closed is the honest direction: this sensor's errors are meant to
  // be undercounts, and a probe that guessed "active" would hand back exactly
  // the overcount it exists to prevent.
  const throwing = makeIdleProbe(() => {
    throw new Error("chrome.idle unavailable");
  }, 60);
  assert.equal(await throwing(), "idle", "a throwing probe reports idle");

  for (const answer of [undefined, null, "", 0, {}]) {
    const junk = makeIdleProbe((_s, cb) => cb(answer), 60);
    assert.equal(await junk(), "idle", `probe answer ${JSON.stringify(answer)} → idle`);
  }

  const ok = makeIdleProbe((_s, cb) => cb("active"), 60);
  assert.equal(await ok(), "active", "a real answer is passed through untouched");

  const secs = [];
  await makeIdleProbe((s, cb) => (secs.push(s), cb("active")), 60)();
  assert.deepEqual(secs, [60], "the configured detection interval is what's asked for");
});

test("a callback chrome never invokes cannot wedge the reconcile queue", async () => {
  // The probe runs inside the serialized reconcile slot, so a pending promise
  // would strand every later chrome event behind it — a silently dead sensor.
  // A lost interval is the acceptable failure; a lost day is not.
  let fire = null;
  const timers = new Set();
  const probe = makeIdleProbe(() => {}, 60, {
    timeoutMs: 2000,
    setTimer: (fn) => {
      fire = fn;
      timers.add(fn);
      return fn;
    },
    clearTimer: (t) => timers.delete(t),
  });

  const pending = probe();
  fire();
  assert.equal(await pending, "idle", "the timeout settles it closed");

  // …and a probe that answers in time does not leave its timer armed.
  const answered = makeIdleProbe((_s, cb) => cb("active"), 60, {
    setTimer: (fn) => (timers.add(fn), fn),
    clearTimer: (t) => timers.delete(t),
  });
  timers.clear();
  assert.equal(await answered(), "active");
  assert.equal(timers.size, 0, "a settled probe clears its timeout");
});

test("a late chrome callback cannot overwrite a probe that already timed out", async () => {
  let late = null;
  const probe = makeIdleProbe((_s, cb) => (late = cb), 60, {
    timeoutMs: 1,
    setTimer: (fn) => (setTimeout(fn, 0), fn),
    clearTimer: () => {},
  });
  const first = await probe();
  assert.equal(first, "idle");
  // chrome finally answers, long after we gave up. It must change nothing.
  assert.doesNotThrow(() => late("active"));
});

test("idle outranks a focused window; a blurred window still loses regardless", async () => {
  const probes = (idleState, focused) => ({
    getIdleState: async () => idleState,
    getFocusedWindow: async () => (focused ? { id: 1, focused: true } : { id: 1, focused: false }),
    getActiveTab: async () => ({ url: "https://a.test/", title: "A" }),
    scrubPage: () => ({ url: "https://a.test/", host: "a.test", path: "/" }),
  });

  assert.notEqual(await resolveAttention(probes("active", true)), null);
  assert.equal(await resolveAttention(probes("idle", true)), null, "idle beats a focused window");
  assert.equal(await resolveAttention(probes("active", false)), null);
  assert.equal(await resolveAttention(probes("idle", false)), null);
});

test("an internal page is not attention even when everything else says yes", async () => {
  const page = await resolveAttention({
    getIdleState: async () => "active",
    getFocusedWindow: async () => ({ id: 1, focused: true }),
    getActiveTab: async () => ({ url: "chrome://extensions", title: "Extensions" }),
    scrubPage: () => null,
  });
  assert.equal(page, null);
});

test("sensing paused discards the open interval rather than emitting it", () => {
  const closed = [];
  const tracker = new FocusTracker({ onInterval: (i) => closed.push(i), idFactory: () => "x" });
  tracker.focus({ url: "https://a.test/", host: "a.test", path: "/", title: "A", at: 0 });
  applyAttention(tracker, null, { at: 60_000, enabled: false });
  assert.equal(closed.length, 0);
  assert.equal(tracker.toJSON(), null);
});
