/**
 * Shell configuration.
 *
 * THE decision this file encodes: **the shell points at the DEPLOYED backend.**
 * Gooni is meant to be ambient, and ambient requires always-on. A local backend
 * only exists while `dev.sh` is running, so a shell defaulted at localhost is a
 * shell that captures nothing for most of the day — the same silent-failure
 * shape the browser extension's `DEFAULT_BASE_URL` had (see extension/README).
 * localhost stays available, but you have to ask for it.
 *
 * Everything here is pure (no electron, no fs) except `load`/`save`, so the
 * merge + normalisation rules are unit-testable — same split the extension uses
 * to keep chrome out of its logic modules.
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = Object.freeze({
  /** The Gooni backend. Deployed, on purpose. See the file header. */
  apiUrl: "https://gooni-bot.fly.dev",
  /** The web frontend the shell window loads. */
  appUrl: "https://gooni.vercel.app",
  /** Global capture hotkey. Electron accelerator syntax. */
  hotkey: "CommandOrControl+Shift+Space",
  launchAtLogin: true,
  /** Capture is a summoned overlay: clicking away should dismiss it. */
  hideCaptureOnBlur: true,
  /**
   * Bearer token for the shell's own API calls (the capture window posts from
   * the MAIN process, where there is no CORS to satisfy). Normally left empty
   * and harvested from the web app's localStorage after you sign in once —
   * see token.js. `authPassword` is the escape hatch: the backend derives its
   * token as sha256(password) (app/common.py::_expected_token), so the shell
   * can too, without a round trip.
   */
  token: "",
  authPassword: "",
  /**
   * The focus-cam sidecar. It is NOT in this repo — it's a separately-built
   * local macOS daemon (mediapipe etc.) that talks to Gooni over the contract
   * in docs/focus_cam_contract.md. So the shell cannot guess how to launch it;
   * it supervises whatever command you name here.
   *
   * `command` empty => UNCONFIGURED, which the tray says out loud. It never
   * silently means "no sidecar today".
   */
  sidecar: Object.freeze({
    enabled: true,
    command: "",
    args: [],
    cwd: "",
    env: {},
  }),
  /**
   * The frontmost-app sensor — the OS half of "what did I actually do today".
   *
   * ON by default, for the same reason the browser extension's `enabled`
   * defaults on and its `baseUrl` defaults to the deployed backend: an
   * installed sensor that senses nothing until someone visits a settings screen
   * is the same lost data with a better excuse. It records an application NAME
   * and a duration — not window titles, not keystrokes, not content — and
   * everything it produces is visible in Gooni's own log.
   *
   * `pollMs` is the cadence of the frontmost query (one `osascript` spawn
   * each; see frontmost.js for that tradeoff). `idleSec` is how long without
   * input before attention is considered gone — an interval that ends by
   * walking away is closed BACKDATED by this amount, so a larger value is not
   * "more forgiving", it is more guesswork.
   */
  appSensor: Object.freeze({
    enabled: true,
    pollMs: 4000,
    idleSec: 90,
    flushMs: 60_000,
  }),
});

const ENV_KEYS = Object.freeze({
  GOONI_API_URL: "apiUrl",
  GOONI_APP_URL: "appUrl",
  GOONI_HOTKEY: "hotkey",
  GOONI_TOKEN: "token",
  GOONI_AUTH_PASSWORD: "authPassword",
});

const CONFIG_FILENAME = "config.json";

function defaults() {
  return {
    ...DEFAULTS,
    sidecar: { ...DEFAULTS.sidecar, args: [], env: {} },
    appSensor: { ...DEFAULTS.appSensor },
  };
}

/**
 * Clamp a numeric knob, falling back to the default on anything unusable.
 *
 * Bounded rather than trusted because these are hand-edited and each one has a
 * range where it stops being the thing it is named: a 100ms poll spawns
 * `osascript` ten times a second forever, and a 2-second idle threshold closes
 * an interval every time you stop to read something.
 */
function clampNumber(raw, { min, max, fallback }) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function stripTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

/**
 * null/undefined are dropped BEFORE stringifying: `String(null)` is `"null"`,
 * which is a non-empty string and would survive the filter to be handed to
 * spawn as a literal argv entry.
 */
function asStringArray(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v) => v !== null && v !== undefined)
    .map((v) => String(v))
    .filter((v) => v.length > 0);
}

function asStringMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    out[String(k)] = String(v);
  }
  return out;
}

/**
 * Merge file config and environment over the defaults.
 *
 * Precedence: env > file > default. Env wins because it is the thing you reach
 * for when you are deliberately pointing one launch somewhere else (`GOONI_API_URL=
 * http://localhost:8000 npm start`), and a launch-time override that a stale
 * config file could quietly beat would be worse than no override.
 *
 * Unknown keys in the file are DROPPED rather than passed through: the config
 * is small and hand-edited, and silently carrying a typo'd key makes the file
 * look like it configured something it did not.
 */
function mergeConfig(fileConfig = {}, env = {}) {
  const base = defaults();
  const file = fileConfig && typeof fileConfig === "object" ? fileConfig : {};

  const merged = {
    apiUrl: file.apiUrl ?? base.apiUrl,
    appUrl: file.appUrl ?? base.appUrl,
    hotkey: file.hotkey ?? base.hotkey,
    launchAtLogin: file.launchAtLogin ?? base.launchAtLogin,
    hideCaptureOnBlur: file.hideCaptureOnBlur ?? base.hideCaptureOnBlur,
    token: file.token ?? base.token,
    authPassword: file.authPassword ?? base.authPassword,
    sidecar: {
      enabled: file.sidecar?.enabled ?? base.sidecar.enabled,
      command: file.sidecar?.command ?? base.sidecar.command,
      args: asStringArray(file.sidecar?.args),
      cwd: file.sidecar?.cwd ?? base.sidecar.cwd,
      env: asStringMap(file.sidecar?.env),
    },
    appSensor: {
      enabled: file.appSensor?.enabled ?? base.appSensor.enabled,
      pollMs: clampNumber(file.appSensor?.pollMs ?? base.appSensor.pollMs, {
        min: 1000,
        max: 60_000,
        fallback: base.appSensor.pollMs,
      }),
      idleSec: clampNumber(file.appSensor?.idleSec ?? base.appSensor.idleSec, {
        min: 30,
        max: 3600,
        fallback: base.appSensor.idleSec,
      }),
      flushMs: clampNumber(file.appSensor?.flushMs ?? base.appSensor.flushMs, {
        min: 5000,
        max: 30 * 60_000,
        fallback: base.appSensor.flushMs,
      }),
    },
  };

  for (const [envKey, cfgKey] of Object.entries(ENV_KEYS)) {
    const value = env[envKey];
    if (typeof value === "string" && value.trim() !== "") merged[cfgKey] = value.trim();
  }
  const sidecarCmd = env.GOONI_SIDECAR_CMD;
  if (typeof sidecarCmd === "string" && sidecarCmd.trim() !== "") {
    merged.sidecar.command = sidecarCmd.trim();
  }

  merged.apiUrl = stripTrailingSlash(merged.apiUrl) || DEFAULTS.apiUrl;
  merged.appUrl = stripTrailingSlash(merged.appUrl) || DEFAULTS.appUrl;
  merged.launchAtLogin = Boolean(merged.launchAtLogin);
  merged.hideCaptureOnBlur = Boolean(merged.hideCaptureOnBlur);
  merged.sidecar.enabled = Boolean(merged.sidecar.enabled);
  merged.appSensor.enabled = Boolean(merged.appSensor.enabled);
  merged.sidecar.command = String(merged.sidecar.command || "").trim();
  merged.sidecar.cwd = String(merged.sidecar.cwd || "").trim();
  merged.token = String(merged.token || "").trim();
  merged.authPassword = String(merged.authPassword || "");

  return merged;
}

/**
 * True when the config still points at a backend that only exists while a dev
 * server is running. Surfaced in the tray so "the shell is up but nothing lands"
 * has a visible cause rather than being something you deduce.
 */
function isLocalBackend(apiUrl) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(String(apiUrl || ""));
}

function configPath(userDataDir) {
  return path.join(userDataDir, CONFIG_FILENAME);
}

/**
 * Read + merge. A malformed file does NOT fall through to defaults silently:
 * the parse error is returned alongside the (default) config so the caller can
 * say so. Booting a shell on defaults because a config file had a trailing
 * comma, and never mentioning it, is exactly the failure this project keeps
 * fighting.
 */
function load(userDataDir, env = process.env) {
  const file = configPath(userDataDir);
  let raw = null;
  let error = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e && e.code !== "ENOENT") error = e;
    raw = null;
  }
  return { config: mergeConfig(raw || {}, env), path: file, existed: raw !== null, error };
}

function save(userDataDir, config) {
  const file = configPath(userDataDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}

module.exports = {
  DEFAULTS,
  ENV_KEYS,
  CONFIG_FILENAME,
  defaults,
  mergeConfig,
  isLocalBackend,
  configPath,
  load,
  save,
};
