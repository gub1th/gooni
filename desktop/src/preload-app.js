/**
 * Preload for the window that loads the Gooni web frontend.
 *
 * Three jobs. The first two are about the ONE decision this shell makes — that
 * it talks to the DEPLOYED backend:
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
 *  3. **Say that this IS the shell.** `__GOONI_DESKTOP__` is how the frontend
 *     knows to draw the things only a desktop window needs — chiefly the
 *     window-drag region, without which a `titleBarStyle: hiddenInset` window
 *     cannot be moved at all (the web content covers the whole title bar, so
 *     the OS has nothing left to drag by). It must be a POSITIVE signal from
 *     the shell rather than a user-agent sniff: the same deployed bundle also
 *     runs in a normal tab and inside the extension's new-tab frame, where a
 *     drag region would be meaningless and the mistake would be silent.
 *     It also carries the theme the shell OPENED on, so the page can tell
 *     whether the remembered ground matched (see appearance.js).
 *
 * The preload runs in an isolated JS world but shares the page's DOM and
 * storage, which is exactly the access needed and no more.
 */

const { contextBridge, ipcRenderer } = require("electron");

const FLAG = "--gooni-api-url=";
const THEME_FLAG = "--gooni-theme=";
const arg = (prefix) => (process.argv.find((a) => a.startsWith(prefix)) || "").slice(prefix.length);
const apiUrl = arg(FLAG);

if (apiUrl) {
  contextBridge.exposeInMainWorld("__GOONI_API_URL__", apiUrl);
}

contextBridge.exposeInMainWorld("__GOONI_DESKTOP__", {
  platform: process.platform,
  /** the theme the window's backgroundColor was painted from, this launch */
  openedTheme: arg(THEME_FLAG) || null,
});

const TOKEN_KEY = "gooni_token";
const THEME_KEY = "gooni_theme";
let lastSent = "";
let lastTheme = "";

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

/**
 * The theme rides the SAME poll as the token rather than a storage event:
 * `localStorage` only fires `storage` in OTHER documents, so a theme flipped in
 * this very window — the only way it is ever flipped here — would never be
 * reported. Cheap: one read, and a send only when the value actually moves.
 */
function reportTheme() {
  try {
    const theme = window.localStorage.getItem(THEME_KEY);
    if (theme && theme !== lastTheme) {
      lastTheme = theme;
      ipcRenderer.send("gooni:theme", theme);
    }
  } catch {
    // as above — an error page has no storage, and no theme to report.
  }
}

function report() {
  reportToken();
  reportTheme();
}

window.addEventListener("DOMContentLoaded", report);
// Sign-in happens after load, so one read at DOMContentLoaded would miss the
// first ever login — the exact case that matters most.
window.addEventListener("focus", report);
setInterval(report, 5_000);
