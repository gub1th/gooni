/**
 * The sensor loop, the reporter's delivery rules, and the frontmost query.
 *
 * Every OS read is injected, so this runs with no Electron, no osascript and no
 * network. The assertions that carry weight are the ones about NOT recording:
 * idle winning over frontmost, a power event beating a late query, and a batch
 * the server never stored staying in the buffer.
 */

const test = require("node:test");
const assert = require("node:assert");

const { AppFocusTracker } = require("../src/appfocus");
const { AppReporter, describeReporter, parseRetryAfter } = require("../src/appreporter");
const { AppSensor } = require("../src/appsensor");
const { parseFrontmost, isPermissionError, queryFrontmost } = require("../src/frontmost");

const T0 = 1_700_000_000_000;

function memStore(initial = {}) {
  let state = { ...initial };
  return { read: () => state, write: (s) => { state = s; }, peek: () => state };
}

function makeRig({ idle = () => 0, frontmost = ["Cursor"], store = memStore() } = {}) {
  let now = T0;
  const queue = [...frontmost];
  const timers = [];
  let ids = 0;
  const reporter = new AppReporter({
    store,
    getBaseUrl: () => "https://gooni-bot.fly.dev",
    getToken: () => "tok",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ accepted: 0, duplicates: 0, rejected: [], stored_ids: [] }) }),
    now: () => now,
  });
  const sensor = new AppSensor({
    tracker: new AppFocusTracker({ idFactory: () => `id-${++ids}` }),
    reporter,
    queryFrontmost: async () => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return typeof next === "string" ? { app: next } : next;
    },
    getIdleSeconds: idle,
    idleSec: 90,
    now: () => now,
    // No real timers: ticks are driven by hand so the ordering is exact.
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  // Every interval the sensor ever produced. The buffer alone is not enough to
  // assert on: a flush legitimately empties it, so a test about what was
  // RECORDED would silently pass on a sensor that recorded nothing.
  const recorded = [];
  const add = reporter.add.bind(reporter);
  reporter.add = (iv) => { recorded.push(iv); add(iv); };

  return {
    sensor,
    reporter,
    store,
    recorded,
    advance: (ms) => { now += ms; },
    at: () => now,
    push: (v) => queue.push(v),
  };
}

// ── the loop ─────────────────────────────────────────────────────────────────

test("idle wins over frontmost — a machine nobody is at records nothing", async () => {
  let idleSeconds = 0;
  const rig = makeRig({ idle: () => idleSeconds });
  await rig.sensor.start();
  rig.advance(5 * 60_000);
  await rig.sensor.tick(); // five minutes of real work on Cursor
  assert.equal(rig.sensor.status().current, "Cursor");

  // He walked away. Cursor is STILL frontmost — that is the whole trap.
  rig.advance(10 * 60_000);
  idleSeconds = 600;
  await rig.sensor.tick();

  const [closed] = rig.recorded;
  assert.equal(closed.end_reason, "idle");
  assert.equal(
    new Date(closed.ended_at).getTime(),
    rig.at() - 600_000,
    "the interval ended when input stopped, not when we noticed"
  );
  assert.equal(rig.sensor.status().current, null, "nothing is open while he is away");
});

test("an idle read that throws fails CLOSED", async () => {
  const rig = makeRig({ idle: () => { throw new Error("nope"); } });
  await rig.sensor.start();
  await rig.sensor.tick();
  assert.equal(
    rig.sensor.status().current,
    null,
    "an unknown presence must not be treated as presence — that direction invents attention"
  );
});

test("a power event beats a query that resolves after it", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let gated = false;
  let now = T0;
  const reporter = new AppReporter({
    store: memStore(), getBaseUrl: () => "", getToken: () => "", now: () => now,
  });
  const sensor = new AppSensor({
    tracker: new AppFocusTracker({ idFactory: () => "id-1" }),
    reporter,
    queryFrontmost: async () => {
      if (gated) await gate;
      return { app: "Cursor" };
    },
    getIdleSeconds: () => 0,
    now: () => now,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  await sensor.start();
  assert.equal(sensor.status().current, "Cursor");

  gated = true;
  now += 60_000;
  const pending = sensor.tick();
  sensor.onSuspend();   // the lid closed while we were asking
  release();
  await pending;

  assert.equal(
    sensor.status().current,
    null,
    "a stale answer must not reopen an interval for a sleeping machine"
  );
});

test("a missing Accessibility grant is stated, not retried in silence", async () => {
  const said = [];
  let now = T0;
  const sensor = new AppSensor({
    tracker: new AppFocusTracker({}),
    reporter: new AppReporter({ store: memStore(), getBaseUrl: () => "", getToken: () => "", now: () => now }),
    queryFrontmost: async () => ({ app: null, error: "not allowed assistive access", permission: true }),
    getIdleSeconds: () => 0,
    now: () => now,
    setTimer: () => 1,
    clearTimer: () => {},
    log: (t) => said.push(t),
  });
  await sensor.start();
  await sensor.tick();
  await sensor.tick();

  assert.equal(sensor.status().permission, false);
  assert.equal(said.filter((s) => s.includes("NEEDS ACCESSIBILITY")).length, 1,
    "said once — a line repeated every 4s is a line you filter out");
});

test("a crash is salvaged on the next start, a clean stop is not", async () => {
  const store = memStore();
  const first = makeRig({ store });
  await first.sensor.start();
  await first.sensor.tick();
  first.advance(120_000);
  await first.sensor.tick(); // confirms Cursor is still frontmost
  assert.ok(store.peek().open, "the open interval is on disk for the salvage path");

  // No stop() — the process was killed. A fresh sensor over the same store.
  const second = makeRig({ store });
  second.advance(9 * 60 * 60 * 1000);
  await second.sensor.start();
  const salvaged = second.recorded.find((iv) => iv.truncated);
  assert.ok(salvaged, "the orphan is recovered");
  assert.equal(
    new Date(salvaged.ended_at).getTime() - new Date(salvaged.started_at).getTime(),
    120_000,
    "closed at the last observation — not at the relaunch nine hours later"
  );
});

test("stop() closes with a real end time and flushes", async () => {
  const rig = makeRig();
  await rig.sensor.start();
  await rig.sensor.tick();
  rig.advance(60_000);
  await rig.sensor.stop();

  const closed = rig.recorded.find((iv) => iv.end_reason === "shutdown");
  assert.ok(closed, "a clean quit closes the interval");
  assert.equal(closed.truncated, false, "a quit we were present for is a measurement");
  assert.equal(rig.store.peek().open, null, "nothing left to salvage");
});

// ── delivery ─────────────────────────────────────────────────────────────────

function makeReporter({ fetchImpl, store = memStore() } = {}) {
  return new AppReporter({
    store,
    getBaseUrl: () => "https://gooni-bot.fly.dev",
    getToken: () => "tok",
    fetchImpl,
    now: () => T0,
  });
}

const IV = (id) => ({ client_id: id, app: "cursor", started_at: "x", ended_at: "y" });

test("a 2xx acks the whole batch, duplicates included", async () => {
  const reporter = makeReporter({
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ accepted: 1, duplicates: 1, rejected: [], stored_ids: ["a"] }),
    }),
  });
  reporter.add(IV("a"));
  reporter.add(IV("b"));
  const report = await reporter.flush();
  assert.equal(report.status, "ok");
  assert.equal(
    reporter.buffered.length, 0,
    "acking only stored_ids would strand every duplicate forever — duplicates are counted, not named"
  );
});

test("a server error RETAINS; only a permanently-refused body is destroyed", async () => {
  for (const status of [500, 429, 404, 401]) {
    const reporter = makeReporter({ fetchImpl: async () => ({ ok: false, status, headers: { get: () => null } }) });
    reporter.add(IV("a"));
    await reporter.flush();
    assert.equal(reporter.buffered.length, 1, `http ${status} must keep the buffer`);
    assert.equal(reporter.refused, 0);
  }

  const reporter = makeReporter({ fetchImpl: async () => ({ ok: false, status: 422, headers: { get: () => null } }) });
  reporter.add(IV("a"));
  const report = await reporter.flush();
  assert.equal(reporter.buffered.length, 0, "a body refused identically forever can't wedge the buffer");
  assert.equal(reporter.refused, 1, "and the loss is COUNTED, not swallowed as an http error");
  assert.equal(report.status, "refused");
});

test("offline keeps the buffer", async () => {
  const reporter = makeReporter({ fetchImpl: async () => { throw new Error("ENOTFOUND"); } });
  reporter.add(IV("a"));
  const report = await reporter.flush();
  assert.equal(report.status, "error");
  assert.equal(reporter.buffered.length, 1);
});

test("a 200 whose body can't be read is not proof anything committed", async () => {
  const reporter = makeReporter({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }),
  });
  reporter.add(IV("a"));
  await reporter.flush();
  assert.equal(reporter.buffered.length, 1, "client_ids make the redelivery a no-op; guessing does not");
});

test("overflow drops the oldest and counts the loss", () => {
  const reporter = makeReporter({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  reporter.maxBuffered = 3;
  for (const id of ["a", "b", "c", "d", "e"]) reporter.add(IV(id));
  assert.deepEqual(reporter.buffered.map((i) => i.client_id), ["c", "d", "e"]);
  assert.equal(reporter.dropped, 2, "a gap the app admits to is a bug report; a hidden one is a wrong answer");
});

test("concurrent flushes join instead of posting the batch twice", async () => {
  let calls = 0;
  const reporter = makeReporter({
    fetchImpl: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, status: 200, json: async () => ({ stored_ids: ["a"], rejected: [] }) };
    },
  });
  reporter.add(IV("a"));
  const [r1, r2] = await Promise.all([reporter.flush(), reporter.flush()]);
  assert.equal(calls, 1);
  assert.equal(r1, r2);
});

test("Retry-After is honoured and capped", () => {
  assert.equal(parseRetryAfter({ headers: { get: () => "30" } }, T0), 30_000);
  assert.equal(parseRetryAfter({ headers: { get: () => "999999" } }, T0), 15 * 60 * 1000);
  assert.equal(parseRetryAfter({ headers: { get: () => null } }, T0), 0);
});

test("the tray line names the state that never clears on its own", () => {
  assert.match(
    describeReporter({ buffered: 0, dropped: 0, refused: 0 }, { enabled: true, permission: false }),
    /ACCESSIBILITY/
  );
  assert.match(
    describeReporter({ buffered: 0, dropped: 0, refused: 0 }, { enabled: false }),
    /off/
  );
  assert.match(
    describeReporter({ buffered: 12, dropped: 0, refused: 0 }, { enabled: true, permission: true }),
    /12 buffered/
  );
});

// ── the frontmost query ──────────────────────────────────────────────────────

test("frontmost parsing refuses anything that isn't one name", () => {
  assert.equal(parseFrontmost("Google Chrome\n"), "Google Chrome");
  assert.equal(parseFrontmost("  Cursor  "), "Cursor");
  assert.equal(parseFrontmost(""), null);
  assert.equal(parseFrontmost("Cursor\nSlack\n"), null, "a multi-line answer means the script did something else");
});

test("a permission refusal is classified, a transient failure is not", () => {
  assert.equal(isPermissionError("osascript is not allowed assistive access. (-1719)"), true);
  assert.equal(isPermissionError("execution error: Application isn't running. (-600)"), false);
});

test("the query always settles, even when osascript never calls back", async () => {
  const result = await queryFrontmost({ execFileImpl: () => {}, timeoutMs: 10 });
  assert.equal(result.app, null);
  assert.equal(result.error, "timeout", "a wedged System Events must not hold the tick slot forever");
});

test("the query survives an execFile that throws synchronously", async () => {
  const result = await queryFrontmost({
    execFileImpl: () => { throw new Error("EMFILE"); },
    timeoutMs: 50,
  });
  assert.equal(result.app, null);
  assert.equal(result.error, "EMFILE");
});
