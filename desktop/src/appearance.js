/**
 * The shell's copy of "which theme is the app in".
 *
 * The shell needs the answer BEFORE the web app can give it. A BrowserWindow's
 * `backgroundColor` is fixed at construction and is what the OS paints for the
 * frames between the window appearing and the page's first paint — so a shell
 * that waits to be told renders a black rectangle in front of a light app (or
 * the reverse) on every single launch. There is no way to ask the page: it does
 * not exist yet.
 *
 * So the theme is HARVESTED and remembered, exactly like the token: the app
 * window's preload reads `gooni_theme` out of localStorage and reports it, and
 * the next launch opens on the ground the app is actually going to paint. First
 * ever launch has nothing to remember and falls back to the frontend's own
 * default (light — see useGooniThemeStore).
 *
 * Unlike the token this is a PREFERENCE, not a credential: plain 0644, and a
 * missing or unreadable file is simply "no opinion yet", never an error. The
 * worst case it can produce is one badly-coloured frame.
 *
 * The two void colours MUST match `AMBIENT_PALETTES` in
 * frontend/src/stores/useGooniThemeStore.ts. Duplicating them is unavoidable —
 * this value is needed in a different process, before any frontend code runs —
 * so the pointer is here rather than the drift being silent.
 */

const fs = require("node:fs");
const path = require("node:path");

const APPEARANCE_FILENAME = "appearance.json";

const THEMES = Object.freeze(["light", "dark"]);
const DEFAULT_THEME = "light";

/** The ambient void, per theme. Mirrors AMBIENT_PALETTES[theme].void. */
const VOID_COLOR = Object.freeze({
  dark: "#000000",
  light: "#f7f6f2",
});

/**
 * Anything that is not a theme name becomes the default.
 *
 * The value arrives from `localStorage`, where the frontend stores it
 * JSON-encoded (`"dark"`, quotes included) via LocalStorageService — so the
 * quotes are stripped here rather than at the two call sites, and a bare
 * `dark` written by hand still works.
 */
function normalizeTheme(raw) {
  const text = String(raw ?? "").trim().replace(/^"(.*)"$/, "$1").toLowerCase();
  return THEMES.includes(text) ? text : DEFAULT_THEME;
}

function voidColor(theme) {
  return VOID_COLOR[normalizeTheme(theme)];
}

function appearancePath(userDataDir) {
  return path.join(userDataDir, APPEARANCE_FILENAME);
}

function loadTheme(userDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(appearancePath(userDataDir), "utf8"));
    return normalizeTheme(raw?.theme);
  } catch {
    return DEFAULT_THEME;
  }
}

function saveTheme(userDataDir, theme) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(
    appearancePath(userDataDir),
    `${JSON.stringify({ theme: normalizeTheme(theme) }, null, 2)}\n`,
    "utf8"
  );
}

module.exports = {
  APPEARANCE_FILENAME,
  DEFAULT_THEME,
  THEMES,
  VOID_COLOR,
  normalizeTheme,
  voidColor,
  appearancePath,
  loadTheme,
  saveTheme,
};
