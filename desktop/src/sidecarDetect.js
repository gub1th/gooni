/**
 * Auto-detection for the focus-cam sidecar install, plus the camera-index
 * override both the tray's picker and a plain config file go through.
 *
 * The sidecar is not pip-installed — it runs from source, so `cwd` MUST be the
 * focus-cam project directory (`python -m focus_cam.sidecar` only resolves the
 * package when launched from there). Guessing the venv path and getting the cwd
 * wrong is worse than not guessing: it produces a `failed`/`crashlooping` tray
 * state on a fresh install that never had a chance to work, so this derives
 * `cwd` from the SAME path it found the interpreter at rather than asking for
 * it separately — the two can't drift apart.
 *
 * Pure: `existsSync`/`homeDir` are injected so detection is testable without
 * touching the real filesystem or `os.homedir()`, same split every other module
 * in this app uses.
 */

const path = require("node:path");

/** Project dirs to check, relative to the home directory, nearest-first. */
const KNOWN_PROJECT_DIRS = Object.freeze(["Desktop/projects/focus-cam"]);

const VENV_PYTHON_SUFFIX = ".venv/bin/python";

const DEFAULT_ARGS = Object.freeze(["-u", "-m", "focus_cam.sidecar"]);

/** Camera 1 is this Mac's built-in face cam; camera 0 is a Continuity desk cam
 * that misses the face — see the launch brief. Just a starting guess: the
 * tray's camera picker (see cameraList.js) is what actually confirms it. */
const DEFAULT_CAMERA_INDEX = 1;

/**
 * Look for a focus-cam venv under the known project dirs. Returns the first
 * hit as `{ command, args, cwd }`, or `null` if none exist.
 */
function detectSidecar({ existsSync, homeDir, projectDirs = KNOWN_PROJECT_DIRS } = {}) {
  if (typeof existsSync !== "function" || !homeDir) return null;
  for (const rel of projectDirs) {
    const cwd = path.join(homeDir, rel);
    const command = path.join(cwd, VENV_PYTHON_SUFFIX);
    if (existsSync(command)) {
      return {
        command,
        args: [...DEFAULT_ARGS, "--camera", String(DEFAULT_CAMERA_INDEX)],
        cwd,
      };
    }
  }
  return null;
}

/**
 * Fold auto-detection into a configured sidecar block. Only fills `command`/
 * `args`/`cwd` when `command` is EMPTY — a manual config (however it got
 * there) is left byte-for-byte alone, because overwriting a value someone set
 * on purpose is a worse failure than leaving a sidecar unconfigured.
 *
 * Returns `{ sidecar, autoDetected, detectedFrom }` — `autoDetected` is what
 * the tray shows ("Focus cam: auto-detected at …"), and it is `false` both
 * when nothing was found AND when a manual config meant detection never ran.
 */
function resolveSidecarConfig(sidecarConfig, detection) {
  const base = sidecarConfig || {};
  if (String(base.command || "").trim() !== "") {
    return { sidecar: base, autoDetected: false, detectedFrom: null };
  }
  if (!detection) {
    return { sidecar: base, autoDetected: false, detectedFrom: null };
  }
  return {
    sidecar: { ...base, command: detection.command, args: detection.args, cwd: detection.cwd },
    autoDetected: true,
    detectedFrom: detection.cwd,
  };
}

/**
 * Read the effective camera index out of an argv array — the picker needs to
 * know what's currently selected to check the right radio item.
 */
function currentCameraIndex(args, fallback = DEFAULT_CAMERA_INDEX) {
  const list = Array.isArray(args) ? args : [];
  const i = list.indexOf("--camera");
  if (i === -1 || i + 1 >= list.length) return fallback;
  const n = Number(list[i + 1]);
  return Number.isInteger(n) ? n : fallback;
}

/**
 * Return `args` with `--camera N` set to `index` — replacing an existing flag
 * in place (order otherwise unchanged) or appending one. Pure, so a camera
 * switch is a plain data transform the tray and the tests can both exercise
 * without touching the supervisor.
 */
function withCameraIndex(args, index) {
  const list = Array.isArray(args) ? [...args] : [];
  const i = list.indexOf("--camera");
  if (i !== -1 && i + 1 < list.length) {
    list[i + 1] = String(index);
    return list;
  }
  return [...list, "--camera", String(index)];
}

module.exports = {
  KNOWN_PROJECT_DIRS,
  VENV_PYTHON_SUFFIX,
  DEFAULT_ARGS,
  DEFAULT_CAMERA_INDEX,
  detectSidecar,
  resolveSidecarConfig,
  currentCameraIndex,
  withCameraIndex,
};
