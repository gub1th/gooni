/**
 * New tab page glue. Everything with a decision in it lives in src/newtab.js;
 * this file is the chrome half — read the configured app URL, point the iframe
 * at it, and decide nothing on its own.
 *
 * The sensing path is not touched anywhere here, and one consequence is worth
 * stating plainly rather than leaving to be rediscovered: a new tab parked on
 * the ambient home records NO interval. The sensor reads the ACTIVE TAB's URL,
 * which on this surface is `chrome-extension://<id>/newtab.html`, and the
 * scrubber drops every non-http(s) scheme. The iframe's inner origin is never
 * seen by it. So time spent here is real browser time that the sensor is blind
 * to — a gap, not a feature, and not one this branch fixes, because what the
 * extension records is deliberately out of bounds for it.
 */

import { loadConfig } from "./src/config.js";
import {
  IFRAME_ALLOW,
  LOAD_TIMEOUT_MS,
  frameBlockedBy,
  frameFailure,
  normalizeAppUrl,
  probeVerdict,
  resolveAppUrl,
} from "./src/newtab.js";

const storage = { get: (keys) => chrome.storage.local.get(keys) };
const $ = (id) => document.getElementById(id);

/**
 * How long an unreachable verdict waits for the frame to prove it wrong.
 *
 * The probe can finish before a cached paint does, so "not painted yet" at the
 * instant the probe fails is not the same claim as "not painting at all".
 */
const PAINT_GRACE_MS = 1500;

let timer = null;
/** Bumped per mount, so a slow probe from a previous attempt can't rule on this one. */
let mountToken = 0;
let framePainted = false;

function showFailure(spec) {
  const f = frameFailure(spec);
  $("failureTitle").textContent = f.title;
  $("failureDetail").textContent = f.detail;
  $("failureUrl").textContent = f.url;
  $("failure").classList.add("shown");
  // The frame is emptied rather than left behind the panel: a half-rendered
  // Chrome error page under our own message is two contradictory explanations
  // on one screen.
  $("app").removeAttribute("src");
}

function clearFailure() {
  $("failure").classList.remove("shown");
}

/** Resolve true as soon as the frame reports a load, or false after `ms`. */
function waitForPaint(frame, ms) {
  if (framePainted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const settle = (painted) => {
      clearTimeout(graceTimer);
      frame.removeEventListener("load", onLoad);
      resolve(painted);
    };
    const onLoad = () => settle(true);
    const graceTimer = setTimeout(() => settle(framePainted), ms);
    frame.addEventListener("load", onLoad);
  });
}

/**
 * Ask the app two questions in ONE request where we're allowed to: is anything
 * answering, and do its headers forbid framing.
 *
 * Asking about the host permission FIRST rather than letting the fetch fail:
 * without it the request is a CORS failure, and Chrome logs those to the
 * console whatever the caller does with the rejection. A local dev frontend
 * would print a scary red error on every single tab open, about a probe that is
 * allowed to come back unknown.
 *
 * The fallback is `no-cors`, which answers only the first question — an opaque
 * response still proves something answered, so a missing host permission can't
 * masquerade as an outage. `blocked` stays null there, which is the honest
 * answer: a probe we couldn't read is not evidence of a failed frame.
 *
 * `HEAD` because the headers are the whole payload we want; a served body is
 * downloaded once already, by the frame.
 */
async function probeApp(url) {
  let readable = false;
  try {
    readable = await chrome.permissions.contains({
      origins: [new URL(url).origin + "/*"],
    });
  } catch {
    readable = false;
  }

  if (readable) {
    try {
      const res = await fetch(url, { method: "HEAD", cache: "no-store" });
      return { reachable: true, blocked: frameBlockedBy(res.headers) };
    } catch {
      return { reachable: false, blocked: null };
    }
  }

  try {
    await fetch(url, { mode: "no-cors", cache: "no-store" });
    return { reachable: true, blocked: null };
  } catch {
    return { reachable: false, blocked: null };
  }
}

async function mount() {
  const token = ++mountToken;
  framePainted = false;

  const cfg = await loadConfig(storage);

  // A saved-but-unusable value is reported with what was actually typed, not
  // quietly replaced by the default — otherwise the tab frames something the
  // user didn't ask for and the bad setting stays invisible forever.
  if (cfg.appUrl && !normalizeAppUrl(cfg.appUrl)) {
    showFailure({ reason: "invalid", url: cfg.appUrl });
    return;
  }

  const url = resolveAppUrl(cfg);
  const frame = $("app");
  clearFailure();

  clearTimeout(timer);
  // The timeout only catches a STALL — a load that neither paints nor errors.
  // Everything else is settled by the probe below.
  timer = setTimeout(() => {
    if (token === mountToken) showFailure({ reason: "timeout", url });
  }, LOAD_TIMEOUT_MS);

  frame.addEventListener(
    "load",
    () => {
      if (token !== mountToken) return;
      clearTimeout(timer);
      framePainted = true;
    },
    { once: true },
  );

  // Set BEFORE the src: `allow` is read at navigation, so a delegation applied
  // afterwards grants the already-loading document nothing. One owner for the
  // permission list — the page reads the constant the test guards, rather than
  // repeating it as an HTML literal that can drift away from it silently.
  frame.setAttribute("allow", IFRAME_ALLOW);
  frame.src = url;

  // Alongside the frame load, not after it: the frame's own `load` event fires
  // for Chrome's "refused to connect" page exactly as it does for the app, so a
  // dead frontend clears the timeout, tells us nothing, and leaves the tab
  // showing Chrome's error page instead of ours. Chrome's page is not a blank
  // tab, but it names neither Gooni nor the setting you have to change, and it
  // offers no way to reach the options page.
  const probe = await probeApp(url);
  if (token !== mountToken) return;

  if (!probe.reachable && !probe.blocked) {
    // Give a cached paint the chance to settle it before we call it dead.
    await waitForPaint(frame, PAINT_GRACE_MS);
    if (token !== mountToken) return;
  }

  const verdict = probeVerdict({ ...probe, framePainted });
  if (!verdict) return;
  clearTimeout(timer);
  showFailure({ reason: verdict, url, note: probe.blocked || undefined });
}

/**
 * Nothing above may reject unhandled. `loadConfig` awaits chrome.storage, which
 * fails outright when the extension context is invalidated mid-reload — and an
 * unhandled rejection there means the iframe never gets a src, leaving exactly
 * the black rectangle with no message and no Retry that this page exists to
 * make impossible.
 */
function mountSafely() {
  mount().catch(() => showFailure({ reason: "config", url: "" }));
}

$("retry").addEventListener("click", mountSafely);
$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

mountSafely();
