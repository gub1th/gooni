const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeConfig, defaults, isLocalBackend, DEFAULTS } = require("../src/config");

test("THE decision: the default backend is the deployed one, not localhost", () => {
  const cfg = mergeConfig({}, {});
  assert.equal(cfg.apiUrl, "https://gooni-bot.fly.dev");
  assert.equal(
    isLocalBackend(cfg.apiUrl),
    false,
    "a shell defaulted at localhost captures nothing whenever dev.sh is not running"
  );
});

test("env beats file beats default", () => {
  const fromFile = mergeConfig({ apiUrl: "https://staging.example" }, {});
  assert.equal(fromFile.apiUrl, "https://staging.example");

  const fromEnv = mergeConfig(
    { apiUrl: "https://staging.example" },
    { GOONI_API_URL: "http://localhost:8000" }
  );
  assert.equal(fromEnv.apiUrl, "http://localhost:8000", "a launch-time override must win");
});

test("blank env values do not blank the config", () => {
  const cfg = mergeConfig({ apiUrl: "https://staging.example" }, { GOONI_API_URL: "  " });
  assert.equal(cfg.apiUrl, "https://staging.example");
});

test("trailing slashes are stripped so path joins can't double up", () => {
  const cfg = mergeConfig({ apiUrl: "https://gooni-bot.fly.dev///" }, {});
  assert.equal(cfg.apiUrl, "https://gooni-bot.fly.dev");
});

test("a url emptied to nothing falls back rather than producing a broken base", () => {
  const cfg = mergeConfig({ apiUrl: "" }, {});
  assert.equal(cfg.apiUrl, DEFAULTS.apiUrl);
});

test("unknown keys are dropped, not carried through", () => {
  const cfg = mergeConfig({ apiURL: "https://typo.example", nonsense: 1 }, {});
  assert.equal(cfg.apiUrl, DEFAULTS.apiUrl, "a typo'd key must not look like it configured something");
  assert.equal("nonsense" in cfg, false);
});

test("sidecar defaults to enabled-but-unconfigured, which the tray says out loud", () => {
  const cfg = mergeConfig({}, {});
  assert.equal(cfg.sidecar.enabled, true);
  assert.equal(cfg.sidecar.command, "");
  assert.deepEqual(cfg.sidecar.args, []);
});

test("sidecar args/env are coerced to the shapes spawn needs", () => {
  const cfg = mergeConfig(
    { sidecar: { command: "python3", args: ["a", 7, null, ""], env: { PORT: 8001, X: null } } },
    {}
  );
  assert.deepEqual(cfg.sidecar.args, ["a", "7"]);
  assert.deepEqual(cfg.sidecar.env, { PORT: "8001" });
});

test("GOONI_SIDECAR_CMD overrides the command", () => {
  const cfg = mergeConfig({ sidecar: { command: "python3" } }, { GOONI_SIDECAR_CMD: "/opt/cam" });
  assert.equal(cfg.sidecar.command, "/opt/cam");
});

test("isLocalBackend recognises the shapes dev.sh actually produces", () => {
  for (const url of [
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "https://localhost",
    "http://[::1]:8000",
  ]) {
    assert.equal(isLocalBackend(url), true, url);
  }
  for (const url of ["https://gooni-bot.fly.dev", "https://localhost.example.com"]) {
    assert.equal(isLocalBackend(url), false, url);
  }
});

test("defaults() hands back a fresh object each time", () => {
  const a = defaults();
  a.sidecar.args.push("mutated");
  assert.deepEqual(defaults().sidecar.args, []);
});

test("the app sensor is ON by default, like the browser extension", () => {
  // An installed sensor that senses nothing until someone visits a settings
  // screen is the same lost data with a better excuse — the reasoning the
  // extension's `enabled` and `DEFAULT_BASE_URL` already encode.
  const cfg = mergeConfig({}, {});
  assert.equal(cfg.appSensor.enabled, true);
  assert.equal(typeof cfg.appSensor.pollMs, "number");
});

test("app-sensor knobs are clamped, not trusted", () => {
  // Hand-edited numbers, each with a range where it stops being the thing it is
  // named: a 100ms poll spawns osascript ten times a second forever, and a
  // 2-second idle threshold closes an interval every time you stop to read.
  const fast = mergeConfig({ appSensor: { pollMs: 5, idleSec: 2, flushMs: 1 } }, {});
  assert.equal(fast.appSensor.pollMs, 1000);
  assert.equal(fast.appSensor.idleSec, 30);
  assert.equal(fast.appSensor.flushMs, 5000);

  const junk = mergeConfig({ appSensor: { pollMs: "soon" } }, {});
  assert.equal(junk.appSensor.pollMs, 4000, "unusable falls back to the default");
});
