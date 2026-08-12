const test = require("node:test");
const assert = require("node:assert/strict");

const { buildMenuTemplate, summarize } = require("../src/traymenu");
const { STATES } = require("../src/sidecar");

const HEALTHY = { state: STATES.RUNNING, pid: 42, restarts: 0, command: "/opt/cam" };
const DEPLOYED = { apiUrl: "https://gooni-bot.fly.dev", hotkey: "Alt+Space" };

function ids(items) {
  return items.map((i) => i.id).filter(Boolean);
}

test("healthy is quiet — an ambient app that decorates the menu bar at rest is noise", () => {
  const s = summarize({ config: DEPLOYED, sidecar: HEALTHY, tokenSource: "harvested" });
  assert.equal(s.ok, true);
  assert.deepEqual(s.problems, []);
  assert.match(s.text, /gooni-bot\.fly\.dev/);
});

test("a crash-looping sidecar cannot hide behind a friendly tooltip", () => {
  const s = summarize({
    config: DEPLOYED,
    sidecar: { ...HEALTHY, state: STATES.CRASHLOOPING, consecutiveFailures: 6 },
    tokenSource: "harvested",
  });
  assert.equal(s.ok, false);
  assert.match(s.text, /CRASH LOOPING/);
});

test("an unconfigured sidecar is a problem, not a blank", () => {
  const s = summarize({
    config: DEPLOYED,
    sidecar: { ...HEALTHY, state: STATES.UNCONFIGURED },
    tokenSource: "harvested",
  });
  assert.equal(s.ok, false);
  assert.match(s.text, /NOT CONFIGURED/);
});

test("a localhost backend is called out — it is the extension's old trap, one layer up", () => {
  const s = summarize({
    config: { ...DEPLOYED, apiUrl: "http://localhost:8000" },
    sidecar: HEALTHY,
    tokenSource: "harvested",
  });
  assert.equal(s.ok, false);
  assert.match(s.text, /Backend is local/);
});

test("no token is called out — capture would silently have nowhere to send", () => {
  const s = summarize({ config: DEPLOYED, sidecar: HEALTHY, tokenSource: "none" });
  assert.equal(s.ok, false);
  assert.match(s.text, /Not signed in/);
});

test("EVERY problem is listed, not just the headline — a fresh install has three", () => {
  const items = buildMenuTemplate({
    config: { ...DEPLOYED, apiUrl: "http://localhost:8000" },
    sidecar: { ...HEALTHY, state: STATES.UNCONFIGURED },
    tokenSource: "none",
    launchAtLogin: false,
    handlers: {},
  });
  const warnings = items.filter((i) => typeof i.label === "string" && i.label.startsWith("⚠"));
  assert.equal(warnings.length, 2, "headline + the other two");
  const all = items.map((i) => i.label).join(" | ");
  assert.match(all, /NOT CONFIGURED/);
  assert.match(all, /Not signed in/);
  assert.match(all, /Backend is local/);
});

test("the menu always offers the things you came for", () => {
  const items = buildMenuTemplate({
    config: DEPLOYED,
    sidecar: HEALTHY,
    tokenSource: "harvested",
    launchAtLogin: true,
    handlers: {},
  });
  for (const id of ["open", "capture", "sidecar", "launchAtLogin", "config", "quit"]) {
    assert.ok(ids(items).includes(id), `missing ${id}`);
  }
  const capture = items.find((i) => i.id === "capture");
  assert.equal(capture.accelerator, "Alt+Space", "the menu must show the hotkey actually bound");
  assert.equal(items.find((i) => i.id === "launchAtLogin").checked, true);
});

test("the sidecar submenu label repeats the state — a submenu you must open to learn something hides it", () => {
  const items = buildMenuTemplate({
    config: DEPLOYED,
    sidecar: { ...HEALTHY, state: STATES.UNCONFIGURED },
    tokenSource: "harvested",
    launchAtLogin: false,
    handlers: {},
  });
  assert.match(items.find((i) => i.id === "sidecar").label, /not configured/);
});

test("Start/Stop reflect whether it is actually up", () => {
  const running = buildMenuTemplate({
    config: DEPLOYED, sidecar: HEALTHY, tokenSource: "harvested", launchAtLogin: false, handlers: {},
  }).find((i) => i.id === "sidecar").submenu;
  assert.equal(running.find((i) => i.id === "sidecar:start").enabled, false);
  assert.equal(running.find((i) => i.id === "sidecar:stop").enabled, true);

  const stopped = buildMenuTemplate({
    config: DEPLOYED,
    sidecar: { ...HEALTHY, state: STATES.STOPPED },
    tokenSource: "harvested",
    launchAtLogin: false,
    handlers: {},
  }).find((i) => i.id === "sidecar").submenu;
  assert.equal(stopped.find((i) => i.id === "sidecar:start").enabled, true);
  assert.equal(stopped.find((i) => i.id === "sidecar:stop").enabled, false);
});
