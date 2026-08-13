import test from "node:test";
import assert from "node:assert/strict";

import {
  IFRAME_ALLOW,
  frameBlockedBy,
  frameFailure,
  normalizeAppUrl,
  probeVerdict,
  resolveAppUrl,
  stallVerdict,
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
  // The CUSTOM DOMAIN, not the Vercel project URL that also serves Gooni: a
  // project URL changes when the project is renamed or moved, and this default
  // is baked into an unpacked extension nobody re-installs.
  assert.equal(DEFAULT_APP_URL, "https://gubith.com");
  // And specifically NOT gooni.vercel.app, which is an unrelated third party's
  // project — the default this repo carried in four places until 2026-08-13.
  assert.doesNotMatch(DEFAULT_APP_URL, /gooni\.vercel\.app/);
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
  assert.equal(normalizeAppUrl("https://gubith.com/?view=log"), "https://gubith.com/?view=log");
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

test("a second CSP header still blocks — Headers.get joins duplicates with a comma", () => {
  // Two Content-Security-Policy headers arrive as one comma-joined string, so
  // the blocking directive opens the SECOND policy and is at the start of no
  // ";"-delimited piece. Missing it puts Chrome's blocked-frame page on screen
  // instead of the sentence this function exists to produce.
  assert.match(
    frameBlockedBy(
      headers({
        "content-security-policy":
          "default-src 'self'; img-src *, frame-ancestors 'self'; script-src 'self'",
      }),
    ),
    /frame-ancestors/i,
  );
  // Every policy applies, so the strictest wins: a permissive one cannot vouch
  // for a stricter one that follows it.
  assert.match(
    frameBlockedBy(
      headers({ "content-security-policy": "frame-ancestors *, frame-ancestors 'self'" }),
    ),
    /frame-ancestors 'self'/i,
  );
  // ...and a directive that merely starts with the same letters is not it.
  assert.equal(
    frameBlockedBy(headers({ "content-security-policy": "frame-ancestors-legacy 'self'" })),
    null,
  );
  // A bare `frame-ancestors` names no source at all — that denies everyone.
  assert.match(
    frameBlockedBy(headers({ "content-security-policy": "frame-ancestors" })),
    /frame-ancestors/i,
  );
});

test("a painted frame outranks an unreachable probe — never tear down a working app", () => {
  // The probe races the load by design and can lose a fight it had no business
  // entering (frame served from cache, probe hits a dropped network). Acting on
  // that would replace a surface the user may be typing into with an error.
  assert.equal(probeVerdict({ reachable: false, blocked: null, framePainted: true }), null);
  assert.equal(
    probeVerdict({ reachable: false, blocked: null, framePainted: false }),
    "unreachable",
  );
  assert.equal(probeVerdict({ reachable: true, blocked: null, framePainted: false }), null);
});

test("a blocked frame is the one verdict a painted frame cannot overrule", () => {
  // Chrome fires `load` for its own blocked-frame error page, so "painted" here
  // means the opposite of working.
  assert.equal(
    probeVerdict({ reachable: true, blocked: "X-Frame-Options: deny", framePainted: true }),
    "blocked",
  );
});

test("the stall timeout stands down once the probe found something answering", () => {
  // The regression: the timer is armed before either the frame or the probe has
  // spoken, and a reachable probe produces no verdict — so it used to fire 12s
  // later and empty the iframe under an app that had painted but whose `load`
  // was still waiting on one hung subresource, taking the capture box's
  // contents with it.
  assert.equal(stallVerdict({ reachable: true, blocked: null, framePainted: false }), null);
  // The same rule probeVerdict enforces, on the other path.
  assert.equal(stallVerdict({ reachable: false, blocked: null, framePainted: true }), null);
  // Still armed while nothing has settled it — a load that neither paints nor
  // errors is exactly what the timeout is for.
  assert.equal(stallVerdict({ reachable: false, blocked: null, framePainted: false }), "timeout");
  // A probe that hasn't answered yet is not an answer.
  assert.equal(stallVerdict({ framePainted: false }), "timeout");
  assert.equal(stallVerdict({}), "timeout");
});

test("a blocked frame is worded by the probe, not by the stall timeout", () => {
  // "didn't finish loading" over a frame Chrome refused to embed is the wrong
  // sentence, not a second opinion — and `load` fires for the blocked page, so
  // the two would otherwise contradict each other on screen.
  assert.equal(
    stallVerdict({ reachable: true, blocked: "X-Frame-Options: deny", framePainted: true }),
    null,
  );
  assert.equal(
    stallVerdict({ reachable: false, blocked: "X-Frame-Options: deny", framePainted: false }),
    null,
  );
});

test("unreadable settings say so rather than naming a URL that was never tried", () => {
  // chrome.storage can reject mid-reload; the page must still speak.
  const f = frameFailure({ reason: "config", url: "" });
  assert.match(f.title, /settings/i);
  assert.ok(f.detail);
  assert.equal(f.url, "(no URL configured)");
});
