const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SidecarSupervisor,
  STATES,
  backoffDelay,
  describe,
  isUnhealthy,
  MAX_BACKOFF_MS,
} = require("../src/sidecar");
const { makeClock, makeSpawn, makeKills } = require("./helpers");

function build(sidecarConfig, overrides = {}) {
  const clock = makeClock();
  const spawner = makeSpawn();
  const killer = makeKills();
  const events = [];
  const sup = new SidecarSupervisor({
    spawnImpl: spawner.spawnImpl,
    killImpl: killer.killImpl,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onEvent: (s) => events.push(s.state),
    ...overrides,
  });
  sup.configure(sidecarConfig);
  return { sup, clock, spawner, killer, events };
}

const CFG = { enabled: true, command: "/usr/bin/python3", args: ["sidecar.py"], cwd: "", env: {} };

test("no command is UNCONFIGURED, not a quiet no-op", () => {
  const { sup, spawner } = build({ ...CFG, command: "" });
  const status = sup.start();
  assert.equal(status.state, STATES.UNCONFIGURED);
  assert.equal(spawner.calls.length, 0);
  assert.ok(isUnhealthy(status.state), "unconfigured must reach the tray as a problem");
  assert.match(describe(status), /NOT CONFIGURED/);
});

test("disabled is distinct from unconfigured", () => {
  const { sup } = build({ ...CFG, enabled: false });
  assert.equal(sup.start().state, STATES.DISABLED);
  assert.equal(isUnhealthy(STATES.DISABLED), false, "off on purpose is not a problem");
});

test("a path that is not executable FAILS with the path, instead of crash-looping on ENOENT", () => {
  const { sup, spawner } = build(CFG, { canExecute: () => false });
  const status = sup.start();
  assert.equal(status.state, STATES.FAILED);
  assert.match(status.lastError, /\/usr\/bin\/python3/);
  assert.equal(spawner.calls.length, 0);
});

test("spawns detached so stop() can take the whole process tree down", () => {
  const { sup, spawner } = build(CFG);
  sup.start();
  assert.equal(spawner.calls[0].command, "/usr/bin/python3");
  assert.deepEqual(spawner.calls[0].args, ["sidecar.py"]);
  assert.equal(spawner.calls[0].options.detached, true);
  assert.equal(sup.status().state, STATES.RUNNING);
});

test("an unexpected exit backs off and restarts", () => {
  const { sup, clock, spawner } = build(CFG);
  sup.start();
  spawner.last().exit(1, null);

  assert.equal(sup.status().state, STATES.BACKOFF);
  assert.equal(spawner.calls.length, 1, "restart is scheduled, not immediate");

  clock.advance(1000);
  assert.equal(spawner.calls.length, 2);
  assert.equal(sup.status().state, STATES.RUNNING);
  assert.equal(sup.status().restarts, 1);
});

test("a run that stayed up resets the ladder — one death is not a loop", () => {
  const { sup, clock, spawner } = build(CFG, { healthyUptimeMs: 30_000 });
  sup.start();
  clock.advance(60_000);
  spawner.last().exit(1, null);
  assert.equal(sup.status().consecutiveFailures, 1);
  assert.equal(sup.status().state, STATES.BACKOFF);

  clock.advance(1000);
  clock.advance(60_000);
  spawner.last().exit(1, null);
  assert.equal(sup.status().consecutiveFailures, 1, "each long run is counted fresh");
});

test("repeated fast exits stop claiming health, but keep retrying", () => {
  const { sup, clock, spawner } = build(CFG, { maxFastCrashes: 3 });
  sup.start();
  // Each cycle: die immediately, then advance EXACTLY the scheduled delay, so
  // the restarted process gets no uptime and the runs stay "fast".
  const cycle = () => {
    spawner.last().exit(1, null);
    clock.advance(sup.status().retryInMs);
  };
  cycle();
  assert.equal(sup.status().state, STATES.RUNNING);
  cycle();
  assert.equal(sup.status().state, STATES.RUNNING, "two quick deaths is still a hiccup");
  spawner.last().exit(1, null);
  assert.equal(sup.status().state, STATES.CRASHLOOPING, "the third stops claiming health");
  assert.ok(isUnhealthy(STATES.CRASHLOOPING));

  // Still retrying: a transient cause (unplugged camera, machine just woke)
  // deserves recovery even after the badge turns bad.
  const before = spawner.calls.length;
  clock.advance(MAX_BACKOFF_MS);
  assert.equal(spawner.calls.length, before + 1);
});

test("backoff is exponential and capped", () => {
  assert.equal(backoffDelay(1), 1000);
  assert.equal(backoffDelay(2), 2000);
  assert.equal(backoffDelay(3), 4000);
  assert.equal(backoffDelay(99), MAX_BACKOFF_MS);
});

test("stop() SIGTERMs the process GROUP and resolves only once the child is gone", async () => {
  const { sup, spawner, killer } = build(CFG);
  sup.start();
  const pid = spawner.last().pid;

  let resolved = false;
  const stopping = sup.stop().then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assert.equal(resolved, false, "quit must WAIT — an orphan holds the camera");
  assert.deepEqual(killer.signals, [{ pid: -pid, sig: "SIGTERM" }]);

  spawner.last().exit(0, "SIGTERM");
  await stopping;
  assert.equal(resolved, true);
  assert.equal(sup.status().state, STATES.STOPPED);
});

test("a child that ignores SIGTERM is SIGKILLed after the grace period", async () => {
  const { sup, clock, spawner, killer } = build(CFG, { stopGraceMs: 5000 });
  sup.start();
  const pid = spawner.last().pid;
  const stopping = sup.stop();

  clock.advance(5000);
  assert.deepEqual(killer.signals.map((s) => s.sig), ["SIGTERM", "SIGKILL"]);
  assert.ok(killer.signals.every((s) => s.pid === -pid), "group, not bare pid");

  spawner.last().exit(null, "SIGKILL");
  await stopping;
});

test("a deliberate stop is not counted as a failure and cancels a pending restart", async () => {
  const { sup, clock, spawner } = build(CFG);
  sup.start();
  spawner.last().exit(1, null);
  assert.equal(sup.status().state, STATES.BACKOFF);

  await sup.stop();
  assert.equal(sup.status().state, STATES.STOPPED);
  clock.advance(MAX_BACKOFF_MS);
  assert.equal(spawner.calls.length, 1, "the scheduled restart must not fire after a stop");
});

test("stop() on a process that was never started still resolves", async () => {
  const { sup } = build({ ...CFG, command: "" });
  sup.start();
  await sup.stop();
  assert.equal(sup.status().state, STATES.UNCONFIGURED, "stop must not erase the loud state");
});

test("start() twice does not fork a second camera owner", () => {
  const { sup, spawner } = build(CFG);
  sup.start();
  sup.start();
  assert.equal(spawner.calls.length, 1);
});

test("child output is captured, stderr marked", () => {
  const { sup, spawner } = build(CFG);
  sup.start();
  spawner.last().stdout.emit("data", "session started\n");
  spawner.last().stderr.emit("data", "camera busy\n");
  const text = sup.log.toText();
  assert.match(text, /session started/);
  assert.match(text, /! camera busy/);
  assert.match(text, /\[shell] started: \/usr\/bin\/python3 sidecar\.py/);
});
