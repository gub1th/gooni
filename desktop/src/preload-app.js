/**
 * Preload for the window that loads the Gooni web frontend.
 *
 * Two jobs, both about the ONE decision this shell makes — that it talks to the
 * DEPLOYED backend:
 *
 *  1. **Force the API base.** `frontend/src/services/api.ts` bakes
 *     `VITE_API_URL` at build time, so a frontend built without it (or built
 *     for a different environment) would fall through to `http://localhost:8000`
 *     inside the shell and fail silently for most of the day. Exposing
 *     `__GOONI_API_URL__` before any page script runs makes the shell's config
 *     the authority regardless of what the bundle was built with.
 *
 *  2. **Harvest the token.** The web app writes `gooni_token` to localStorage
 *     after `POST /auth`. Reading it here means signing in once in the window
 *     also signs in the capture hotkey, which posts from the main process (no
 *     CORS) — rather than asking for the password a second time.
 *
 * The preload runs in an isolated JS world but shares the page's DOM and
 * storage, which is exactly the access needed and no more.
 */

const { contextBridge, ipcRenderer } = require("electron");

const FLAG = "--gooni-api-url=";
const apiUrl = (process.argv.find((a) => a.startsWith(FLAG)) || "").slice(FLAG.length);

if (apiUrl) {
  contextBridge.exposeInMainWorld("__GOONI_API_URL__", apiUrl);
}

const TOKEN_KEY = "gooni_token";
let lastSent = "";

function reportToken() {
  try {
    const token = window.localStorage.getItem(TOKEN_KEY);
    if (token && token !== lastSent) {
      lastSent = token;
      ipcRenderer.send("gooni:token", token);
    }
  } catch {
    // localStorage can be unavailable on an error page. Nothing to report.
  }
}

window.addEventListener("DOMContentLoaded", reportToken);
// Sign-in happens after load, so one read at DOMContentLoaded would miss the
// first ever login — the exact case that matters most.
window.addEventListener("focus", reportToken);
setInterval(reportToken, 5_000);
