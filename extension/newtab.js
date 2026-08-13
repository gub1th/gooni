/**
 * New tab page glue. Everything with a decision in it lives in src/newtab.js;
 * this file is the chrome half — read the configured app URL, point the iframe
 * at it, and decide nothing on its own.
 *
 * Note the sensing path is not touched anywhere here. This is a new surface
 * next to the popup, not a change to what the extension records — and the
 * framed app is on its own origin, so it is recorded exactly like any other
 * tab, which is correct: time spent on the ambient home is real browser time.
 */

import { loadConfig } from "./src/config.js";
import {
  LOAD_TIMEOUT_MS,
  frameBlockedBy,
  frameFailure,
  normalizeAppUrl,
  resolveAppUrl,
} from "./src/newtab.js";

const storage = { get: (keys) => chrome.storage.local.get(keys) };
const $ = (id) => document.getElementById(id);

let timer = null;

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

/**
 * Called once the frame reports a load. Two things can be true at that point:
 * the app painted, or Chrome painted its blocked-frame error page and fired
 * `load` for it. Only the headers can tell them apart, so ask — but stay silent
 * if we can't read them (no host permission for a custom URL), because a failed
 * probe is not evidence of a failed frame.
 */
async function verifyFramed(url) {
  // Asked FIRST rather than letting the fetch fail: without the host
  // permission the request is a CORS failure, and Chrome logs those to the
  // console whatever the caller does with the rejection. A local dev frontend
  // would print a scary red error on every single tab open, about a probe that
  // is allowed to come back unknown.
  let allowed = false;
  try {
    allowed = await chrome.permissions.contains({
      origins: [new URL(url).origin + "/*"],
    });
  } catch {
    return;
  }
  if (!allowed) return;

  let res;
  try {
    res = await fetch(url, { method: "GET", cache: "no-store" });
  } catch {
    return;
  }
  const blocked = frameBlockedBy(res.headers);
  if (blocked) showFailure({ reason: "blocked", url, note: blocked });
}

/**
 * Reachability, run alongside the frame load rather than after it.
 *
 * It has to be alongside, because the frame's own `load` event fires for
 * Chrome's "refused to connect" page exactly as it does for the app — so a
 * dead frontend clears the timeout, tells us nothing, and leaves the tab
 * showing Chrome's error page instead of ours. Chrome's page is not a blank
 * tab, but it names neither Gooni nor the setting you have to change, and it
 * offers no way to reach the options page.
 *
 * `no-cors` on purpose: an opaque response still proves something answered, so
 * a missing host permission can't masquerade as an outage.
 */
async function probeReachable(url) {
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}

async function mount() {
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
  timer = setTimeout(() => showFailure({ reason: "timeout", url }), LOAD_TIMEOUT_MS);

  frame.addEventListener(
    "load",
    () => {
      clearTimeout(timer);
      verifyFramed(url);
    },
    { once: true },
  );

  frame.src = url;

  if (!(await probeReachable(url))) {
    clearTimeout(timer);
    showFailure({ reason: "unreachable", url });
  }
}

$("retry").addEventListener("click", () => mount());
$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

mount();
