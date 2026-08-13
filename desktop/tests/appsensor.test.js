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

function memStore(initial = {}, { losses = 0 } = {}) {
  let state = { ...initial };
  let writes = 0;
  return {
    read: () => state,
    write: (s) => { state = s; writes += 1; },
    losses: () => losses,
    peek: () => state,
    writes: () => writes,
  };
}

const POLL_MS = 4000;

function makeRig({
  idle = () => 0,
  frontmost = ["Cursor"],
  store = memStore(),
  openStore = memStore(),
} = {}) {
  let now = T0;
  const queue = [...frontmost];
  const timers = [];
  let ids = 0;
  const reporter = new AppReporter({
    store,
    openStore,
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
    pollMs: POLL_MS,
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
    openStore,
    recorded,
    advance: (ms) => { now += ms; },
    at: () => now,
    push: (v) => queue.push(v),
    /** What every later query answers, from now on. */
    setFrontmost: (v) => { queue.splice(0, queue.length, v); },
    /**
     * Elapsed time WITH the sensor polling through it, one tick per poll period
     * — a stretch of ordinary use. `advance()` alone is the opposite claim: time
     * passing with nobody observing, which the sensor now treats as a lapse
     * rather than as continuity.
     */
    async run(ms) {
      for (let left = ms; left > 0; left -= POLL_MS) {
        now += Math.min(POLL_MS, left);
        await sensor.tick();
      }
    },
  };
}

// ── the loop ─────────────────────────────────────────────────────────────────

test("idle wins over frontmost — a machine nobody is at records nothing", async () => {
  let idleSeconds = 0;
  const rig = makeRig({ idle: () => idleSeconds });
  await rig.sensor.start();
  await rig.run(5 * 60_000); // five minutes of real work on Cursor
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

/**
 * A wedged System Events (or an Accessibility grant revoked mid-session) is an
 * UNOBSERVED stretch, not a long focus session. It can persist for hours, so the
 * sensor must not sit on a stale open interval waiting for some later real event
 * to close it — that event would credit the whole outage to whatever was
 * frontmost when the sensor went blind.
 */
test("a query that keeps failing closes the interval instead of accruing it", async () => {
  const wedged = { app: null, error: "timeout" };
  const rig = makeRig({ frontmost: ["Cursor"] });
  await rig.sensor.start(); // 09:00 — Cursor frontmost
  await rig.run(60_000); // a minute of polling that kept answering
  rig.setFrontmost(wedged); // System Events stops answering from here

  rig.advance(4000);
  await rig.sensor.tick(); // first failure
  assert.equal(
    rig.recorded.length,
    0,
    "one failed query is a hiccup, not blindness — closing on it would chop every real session"
  );

  rig.advance(2 * 60 * 60 * 1000); // two hours of a wedged osascript
  await rig.sensor.tick();

  const [closed] = rig.recorded;
  assert.ok(closed, "the sensor does not sit on a stale open interval");
  assert.equal(closed.end_reason, "unobserved");
  assert.equal(closed.truncated, true);
  assert.equal(
    new Date(closed.ended_at).getTime() - new Date(closed.started_at).getTime(),
    60_000,
    "only the observed minute is credited, not the two blind hours"
  );
  assert.equal(rig.sensor.status().current, null);
  assert.equal(rig.openStore.peek().open, null, "and it cannot also be salvaged as an orphan");

  // When the query recovers, the new interval starts at the recovery: the blind
  // stretch belongs to nobody, and is not handed to Chrome either.
  rig.setFrontmost("Google Chrome");
  rig.advance(4000);
  await rig.sensor.tick();
  assert.equal(rig.sensor.status().current, "Google Chrome");
  assert.equal(rig.recorded.length, 1);
});

/**
 * The same lie through a different door: the QUERY keeps answering, but the
 * POLLING stops. The machine sleeps at 18:00 with Cursor frontmost and
 * `suspend` never lands (SIGSTOP, a forward clock jump, a wedged main process);
 * ticks resume at 09:00 with Cursor STILL frontmost and the human back at the
 * keyboard, so idle is small and the query answers normally.
 *
 * `focus`'s same-app branch is deliberately continuity-preserving, so nothing
 * there can catch this — the staleness question has to be asked before it.
 */
test("a gap in POLLING is not absorbed as continuity by the same app", async () => {
  const rig = makeRig({ frontmost: ["Cursor"] });
  await rig.sensor.start(); // 17:59
  await rig.run(60_000); // 18:00 — the last confirmed observation

  rig.advance(15 * 60 * 60 * 1000); // the machine went away and came back
  await rig.sensor.tick(); // 09:00 — Cursor still frontmost, human present

  const [closed] = rig.recorded;
  assert.ok(closed, "the overnight gap must not be absorbed into the open interval");
  assert.equal(closed.end_reason, "unobserved");
  assert.equal(closed.truncated, true);
  assert.equal(
    new Date(closed.ended_at).getTime() - new Date(closed.started_at).getTime(),
    60_000,
    "only the observed minute is credited — the 6h cap would have emitted six hours"
  );

  // ...and the app being frontmost NOW is a fresh interval starting now.
  assert.equal(rig.sensor.status().current, "Cursor");
  await rig.run(60_000);
  await rig.sensor.stop({ flush: false });
  const reopened = rig.recorded[1];
  assert.equal(reopened.end_reason, "shutdown");
  assert.equal(reopened.truncated, false, "a clean quit we were present for is a measurement");
  assert.equal(
    new Date(reopened.started_at).getTime(),
    rig.at() - 60_000,
    "it starts at the observation that reopened it, not back before the gap"
  );
});

test("ordinary polling keeps one interval open — no slivers", async () => {
  const rig = makeRig({ frontmost: ["Cursor"] });
  await rig.sensor.start();
  await rig.run(80_000);
  assert.equal(
    rig.recorded.length,
    0,
    "an hour of real work must not become poll-length slivers"
  );
  await rig.sensor.stop({ flush: false });
  const [closed] = rig.recorded;
  assert.equal(closed.truncated, false, "and it is a measurement, not a flagged row");
  assert.equal(new Date(closed.ended_at).getTime() - new Date(closed.started_at).getTime(), 80_000);
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
  const openStore = memStore();
  const first = makeRig({ store, openStore });
  await first.sensor.start();
  await first.run(120_000); // two minutes of polling confirming Cursor
  assert.ok(openStore.peek().open, "the open interval is on disk for the salvage path");

  // No stop() — the process was killed. A fresh sensor over the same stores.
  const second = makeRig({ store, openStore });
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
  await rig.run(60_000); // a minute of polling that kept confirming Cursor
  await rig.sensor.stop();

  const closed = rig.recorded.find((iv) => iv.end_reason === "shutdown");
  assert.ok(closed, "a clean quit closes the interval");
  assert.equal(closed.truncated, false, "a quit we were present for is a measurement");
  assert.equal(rig.openStore.peek().open, null, "nothing left to salvage");
});

test("a tick that only moves the anchor does not rewrite the interval buffer", async () => {
  const rig = makeRig();
  await rig.sensor.start();
  // A day-long outage: the buffer is heavy and nothing is draining it.
  for (let i = 0; i < 50; i += 1) rig.reporter.add(IV(`old-${i}`));
  const bufferWrites = rig.store.writes();

  rig.advance(60_000);
  await rig.sensor.tick();
  rig.advance(60_000);
  await rig.sensor.tick();

  assert.equal(
    rig.store.writes(),
    bufferWrites,
    "the backlog is not re-serialised every poll — that is a megabyte of JSON " +
      "written synchronously on the main process every few seconds"
  );
  assert.ok(rig.openStore.peek().open, "the salvage anchor is still persisted");
  assert.equal(
    new Date(rig.openStore.peek().open.lastSeenAt).getTime(),
    rig.at(),
    "and it is FRESH — a stale anchor credits everything up to the crash"
  );
});

test("an unchanged anchor never touches the disk", async () => {
  const rig = makeRig({ idle: () => 600 });
  await rig.sensor.start();
  const writes = rig.openStore.writes();
  // Idle overnight: every tick calls setOpen with the same empty tracker.
  for (let i = 0; i < 20; i += 1) {
    rig.advance(4000);
    await rig.sensor.tick();
  }
  assert.equal(rig.openStore.writes(), writes, "a byte-identical write is not a write");
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

test("a refused batch destroys what it SENT, not whatever sits in those slots now", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const reporter = makeReporter({
    fetchImpl: async () => {
      await gate;
      return { ok: false, status: 422, headers: { get: () => null } };
    },
  });
  reporter.maxBuffered = 3;
  for (const id of ["a", "b", "c"]) reporter.add(IV(id));

  const pending = reporter.flush();
  // A long outage with a full buffer: new intervals arrive mid-request and
  // overflow splices the FRONT, shifting every index the batch was read at.
  reporter.add(IV("d"));
  reporter.add(IV("e"));
  release();
  const report = await pending;

  assert.deepEqual(
    reporter.buffered.map((i) => i.client_id),
    ["d", "e"],
    "the rows that were never sent survive; a positional slice would have eaten them"
  );
  // a and b were already gone to overflow and are counted THERE. Only c was
  // still held, so only c is a refusal loss — counting the whole batch would
  // book the same two intervals as lost twice.
  assert.equal(report.destroyed, 1, "the destroyed count is what actually left");
  assert.equal(reporter.refused, 1);
  assert.equal(reporter.dropped, 2);
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

test("a lost state file is counted apart from the other two losses", () => {
  // The stores own the number (jsonstore.js counts the quarantined documents);
  // the reporter reads it and never writes one back.
  const store = memStore({}, { losses: 1 });
  const reporter = new AppReporter({
    store,
    openStore: memStore({}, { losses: 2 }),
    getBaseUrl: () => "https://gooni-bot.fly.dev",
    getToken: () => "tok",
    now: () => T0,
  });

  assert.equal(reporter.corrupted, 3, "either file can be the one that was lost");
  assert.equal(reporter.dropped, 0, "a lost file is not a buffer overflow");
  assert.equal(reporter.refused, 0, "and it is not a server refusal either");
  assert.equal(reporter.status().corrupted, 3);

  reporter.add(IV("a"));
  assert.equal(
    store.peek().corrupted, undefined,
    "a persisted total would be a second opinion about a number the disk already owns"
  );
});

test("a store that reports no losses contributes none", () => {
  const reporter = new AppReporter({
    store: memStore(),
    openStore: memStore(),
    getBaseUrl: () => "https://gooni-bot.fly.dev",
    getToken: () => "tok",
    now: () => T0,
  });
  assert.equal(reporter.corrupted, 0);
});

test("the tray says a state file was lost, and keeps saying it", () => {
  assert.match(
    describeReporter({ buffered: 0, dropped: 0, refused: 0, corrupted: 2 }, { enabled: true, permission: true }),
    /state lost 2×/
  );
  assert.doesNotMatch(
    describeReporter({ buffered: 0, dropped: 0, refused: 0, corrupted: 0 }, { enabled: true, permission: true }),
    /state lost/
  );
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
