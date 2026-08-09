/**
 * Options page. Two jobs: hold the Gooni connection, and expose the scrub
 * lists so the privacy model can change without a rebuild.
 *
 * The password is exchanged for a bearer token via POST /auth (the same
 * exchange the web app does) and only the token is stored — a stored password
 * would be a second copy of the credential for no benefit.
 */

import { CONFIG_KEYS, DEFAULT_BASE_URL, loadConfig } from "./src/config.js";
import { SCRUB_SUBSTRINGS, SCRUB_EXACT } from "./src/scrub.js";
import { formatLastFlush } from "./src/status.js";

const storage = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
};

const $ = (id) => document.getElementById(id);
const toLines = (arr) => arr.join("\n");
const fromLines = (s) =>
  s
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);

async function render() {
  const cfg = await loadConfig(storage);
  $("baseUrl").value = cfg.baseUrl || DEFAULT_BASE_URL;
  $("enabled").checked = cfg.enabled;
  $("scrubSubstrings").value = toLines(cfg.scrub.substrings);
  $("scrubExact").value = toLines(cfg.scrub.exact);
  await renderStatus();
}

async function renderStatus() {
  const s = await chrome.runtime.sendMessage({ type: "gooni:status" });
  if (!s) {
    $("status").textContent = "service worker not responding";
    return;
  }
  const lines = [
    `sensing:   ${s.enabled ? "on" : "paused"}`,
    `endpoint:  ${s.baseUrl}/browser/intervals`,
    `token:     ${s.hasToken ? "set" : "MISSING — save your password"}`,
    `buffered:  ${s.buffered} interval(s) awaiting delivery`,
    `dropped:   ${s.dropped} (buffer overflow — only after a very long outage)`,
    `open now:  ${s.open ? `${s.open.host} since ${new Date(s.open.startedAt).toLocaleTimeString()}` : "nothing focused"}`,
  ];
  lines.push(...formatLastFlush(s.lastFlush));
  $("status").textContent = lines.join("\n");
}

/** Exchange the password for a bearer token, mirroring the web app's /auth call. */
async function fetchToken(baseUrl, password) {
  const res = await fetch(`${baseUrl}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(`auth failed (${res.status})`);
  const body = await res.json();
  if (!body.token) throw new Error("auth returned no token");
  return body.token;
}

$("save").addEventListener("click", async () => {
  const baseUrl = $("baseUrl").value.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
  const password = $("password").value;
  $("saveMsg").textContent = "saving…";

  // A base URL outside the manifest's declared hosts needs its permission
  // granted at runtime, or the service worker's fetch is blocked by CORS.
  try {
    const origin = new URL(baseUrl).origin + "/*";
    const granted = await chrome.permissions.contains({ origins: [origin] });
    if (!granted) {
      const ok = await chrome.permissions.request({ origins: [origin] });
      if (!ok) {
        $("saveMsg").textContent = `permission for ${origin} denied — cannot deliver intervals there`;
        return;
      }
    }
  } catch {
    $("saveMsg").textContent = "that base URL is not a valid origin";
    return;
  }

  const patch = {
    [CONFIG_KEYS.baseUrl]: baseUrl,
    [CONFIG_KEYS.enabled]: $("enabled").checked,
    [CONFIG_KEYS.scrubSubstrings]: fromLines($("scrubSubstrings").value),
    [CONFIG_KEYS.scrubExact]: fromLines($("scrubExact").value),
  };

  if (password) {
    try {
      patch[CONFIG_KEYS.token] = await fetchToken(baseUrl, password);
    } catch (e) {
      $("saveMsg").textContent = `settings NOT saved: ${e.message}`;
      return;
    }
  }

  await storage.set(patch);
  $("password").value = "";
  $("saveMsg").textContent = "saved";
  await renderStatus();
});

$("resetScrub").addEventListener("click", () => {
  $("scrubSubstrings").value = toLines(SCRUB_SUBSTRINGS);
  $("scrubExact").value = toLines(SCRUB_EXACT);
  $("saveMsg").textContent = "defaults restored in the form — press Save to apply";
});

$("refresh").addEventListener("click", renderStatus);

$("flush").addEventListener("click", async () => {
  $("status").textContent = "flushing…";
  await chrome.runtime.sendMessage({ type: "gooni:flush" });
  await renderStatus();
});

render();
