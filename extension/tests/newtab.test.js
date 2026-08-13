import test from "node:test";
import assert from "node:assert/strict";

import {
  IFRAME_ALLOW,
  frameBlockedBy,
  frameFailure,
  normalizeAppUrl,
  resolveAppUrl,
} from "../src/newtab.js";
import { DEFAULT_APP_URL, CONFIG_KEYS, loadConfig } from "../src/config.js";

/** Headers-like shim: node's Headers would work, but this keeps the test literal. */
const headers = (map) => ({
  get: (name) => {
    const hit = Object.entries(map).find(
      ([k]) => k.toLowerCase() === name.toLowerCase(),
    );
    return hit ? hit[1] : null;
  },
});

test("the app URL default matches the desktop shell's appUrl — one answer to where Gooni lives", () => {
  assert.equal(DEFAULT_APP_URL, "https://gooni.vercel.app");
});

test("the app URL is a SEPARATE key from the backend base URL — different hosts", () => {
  assert.notEqual(CONFIG_KEYS.appUrl, CONFIG_KEYS.baseUrl);
});

test("loadConfig defaults appUrl and strips a trailing slash", async () => {
  const empty = await loadConfig({ get: async () => ({}) });
  assert.equal(empty.appUrl, DEFAULT_APP_URL);

  const set = await loadConfig({
    get: async () => ({ [CONFIG_KEYS.appUrl]: "http://localhost:5173/" }),
  });
  assert.equal(set.appUrl, "http://localhost:5173");
});

test("the mic is delegated to the frame — voice-first is the app's default mode", () => {
  // A cross-origin iframe gets no microphone unless the embedder hands it one,
  // so without this the ambient wave renders and never hears anything.
  assert.match(IFRAME_ALLOW, /\bmicrophone\b/);
  // Gooni speaks its replies back; autoplay is the other half of voice.
  assert.match(IFRAME_ALLOW, /\bautoplay\b/);
  // The camera belongs to the focus-cam sidecar, not to a framed tab.
  assert.doesNotMatch(IFRAME_ALLOW, /\bcamera\b/);
});

test("normalizeAppUrl rejects what an iframe cannot load, rather than repairing it", () => {
  assert.equal(normalizeAppUrl("localhost:5173"), null); // no scheme
  assert.equal(normalizeAppUrl("chrome://newtab"), null);
  assert.equal(normalizeAppUrl("file:///tmp/index.html"), null);
  assert.equal(normalizeAppUrl(""), null);
  assert.equal(normalizeAppUrl(null), null);
  assert.equal(normalizeAppUrl("  http://localhost:5173/  "), "http://localhost:5173");
  assert.equal(normalizeAppUrl("https://gooni.vercel.app/?view=log"), "https://gooni.vercel.app/?view=log");
});

test("an unusable saved URL falls back for framing but is still reported verbatim", () => {
  // resolveAppUrl guarantees the tab always has something to try...
  assert.equal(resolveAppUrl({ appUrl: "localhost:5173" }), DEFAULT_APP_URL);
  assert.equal(resolveAppUrl({}), DEFAULT_APP_URL);
  // ...while the failure text quotes what was actually typed, because that IS
  // the diagnosis. Silently framing the default would hide the bad setting.
  const f = frameFailure({ reason: "invalid", url: "localhost:5173" });
  assert.equal(f.url, "localhost:5173");
  assert.match(f.title, /isn't a URL/i);
});

test("every failure names the URL it tried — 'couldn't load' alone is unactionable", () => {
  for (const reason of ["invalid", "unreachable", "timeout", "blocked"]) {
    const f = frameFailure({ reason, url: "http://localhost:5173" });
    assert.equal(f.url, "http://localhost:5173");
    assert.ok(f.title && f.detail, `${reason} needs both a title and a detail`);
  }
});

test("an unknown reason still produces a message — never a blank tab", () => {
  const f = frameFailure({ reason: "something-new", url: "https://x.test" });
  assert.ok(f.title);
  assert.equal(f.url, "https://x.test");
});

test("a missing URL says so instead of rendering an empty line", () => {
  assert.equal(frameFailure({ reason: "unreachable", url: "" }).url, "(no URL configured)");
});

test("frame-blocking headers are read off the response, since the frame's load event can't see them", () => {
  // Chrome fires `load` for its own blocked-frame error page, so the timeout
  // never fires and the tab is blank. Headers are the only tell.
  assert.match(frameBlockedBy(headers({ "X-Frame-Options": "DENY" })), /x-frame-options/i);
  assert.match(frameBlockedBy(headers({ "x-frame-options": "SameOrigin" })), /sameorigin/i);
  assert.match(
    frameBlockedBy(headers({ "content-security-policy": "default-src 'self'; frame-ancestors 'self'" })),
    /frame-ancestors/i,
  );
});

test("headers that permit framing report nothing — today's frontend must not trip this", () => {
  assert.equal(frameBlockedBy(headers({})), null);
  assert.equal(frameBlockedBy(headers({ "content-security-policy": "default-src 'self'" })), null);
  assert.equal(
    frameBlockedBy(headers({ "content-security-policy": "frame-ancestors *" })),
    null,
  );
  // An unreadable probe (no host permission for a custom URL) is UNKNOWN, and
  // unknown must stay silent: a failed probe is not evidence of a failed frame.
  assert.equal(frameBlockedBy(null), null);
});

test("a blocked frame quotes the directive — the header is the thing you go and change", () => {
  const blocked = frameBlockedBy(headers({ "X-Frame-Options": "DENY" }));
  const f = frameFailure({ reason: "blocked", url: DEFAULT_APP_URL, note: blocked });
  assert.match(f.detail, /x-frame-options/i);
});
