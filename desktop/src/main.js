/**
 * Electron main — the only file in this app that touches electron APIs.
 *
 * Everything with a decision in it (config merge, sidecar lifecycle, menu
 * wording, reply extraction) lives in the modules next door so it can be tested
 * without launching a window. This file is wiring, and deliberately dull.
 *
 * What it owns:
 *   - one window on the deployed Gooni frontend, forced onto the deployed
 *     backend via the preload (see preload-app.js);
 *   - a menu-bar presence that always states the worst thing that is true;
 *   - a global hotkey that summons a capture overlay, not just a window;
 *   - the focus-cam sidecar's whole lifetime, including a clean stop on quit.
 */

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell, nativeImage, screen, dialog, powerMonitor } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");

const configModule = require("./config");
const { SidecarSupervisor, describe, isUnhealthy } = require("./sidecar");
const { buildMenuTemplate, summarize } = require("./traymenu");
const { GooniApi } = require("./api");
const tokenModule = require("./token");
const { AppFocusTracker } = require("./appfocus");
const { AppReporter } = require("./appreporter");
const { AppSensor } = require("./appsensor");
const { queryFrontmost } = require("./frontmost");

const SIDECAR_LOG = "sidecar.log";
const APP_SENSOR_STATE = "app-sensor.json";
const APP_SENSOR_OPEN = "app-sensor-open.json";

let config = configModule.defaults();
let configPath = "";
let tray = null;
let mainWindow = null;
let captureWindow = null;
let sidecar = null;
let appSensor = null;
let api = null;
let harvestedToken = "";
let quitting = false;
let logStream = null;

const userDataDir = () => app.getPath("userData");
const sidecarLogPath = () => path.join(app.getPath("logs"), SIDECAR_LOG);

// ── config ───────────────────────────────────────────────────────────────────

function loadConfig({ announceErrors = true } = {}) {
  const result = configModule.load(userDataDir(), process.env);
  config = result.config;
  configPath = result.path;
  if (!result.existed) {
    // Write the resolved config on first run so the file you are told to edit
    // actually exists, with the real defaults in it rather than a blank object.
    try {
      configModule.save(userDataDir(), config);
    } catch (e) {
      console.error("[gooni] could not write config:", e.message);
    }
  }
  if (result.error && announceErrors) {
    // A config file that failed to parse must not silently become defaults.
    dialog.showErrorBox(
      "Gooni: config file could not be read",
      `${result.path}\n\n${result.error.message}\n\nRunning on defaults (backend ${config.apiUrl}) until it is fixed.`
    );
  }
  return result;
}

function currentToken() {
  return tokenModule.resolveToken(config, harvestedToken);
}

// ── sidecar ──────────────────────────────────────────────────────────────────

function openLogStream() {
  try {
    fs.mkdirSync(app.getPath("logs"), { recursive: true });
    logStream = fs.createWriteStream(sidecarLogPath(), { flags: "a" });
  } catch (e) {
    console.error("[gooni] no sidecar log file:", e.message);
    logStream = null;
  }
}

function canExecute(command) {
  // Only a preflight for absolute/relative paths. A bare name is resolved by
  // PATH at spawn time, and guessing at PATH here would reject valid commands.
  if (!command.includes("/")) return true;
  try {
    fs.accessSync(command, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function createSidecar() {
  sidecar = new SidecarSupervisor({
    spawnImpl: spawn,
    canExecute,
    onEvent: (status) => {
      refreshTray();
      if (isUnhealthy(status.state)) console.warn(`[gooni] ${describe(status)}`);
    },
    onLine: (line) => {
      if (!logStream) return;
      logStream.write(`${new Date(line.at).toISOString()} ${line.stream === "stderr" ? "ERR" : "out"} ${line.text}\n`);
    },
  });
  sidecar.configure(config.sidecar);
  sidecar.start();
}

// ── frontmost-app sensor ─────────────────────────────────────────────────────

/**
 * A durable JSON file under userData.
 *
 * Rather than anything cleverer: each holds a small whole-rewritten document,
 * which is exactly what the extension's chrome.storage.local is. A read failure
 * falls back to empty — a corrupt file must not stop the sensor from sensing
 * (the reporter's own counters are what admit the loss).
 *
 * TWO of them, and the split is the point: the buffer changes only when rows
 * are added or delivered, while the open-interval anchor is rewritten on every
 * poll. See AppReporter's header for why sharing one file made a long outage
 * write the whole backlog to disk every few seconds.
 */
function jsonStore(name) {
  const file = path.join(userDataDir(), name);
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return {};
      }
    },
    write(state) {
      try {
        fs.mkdirSync(userDataDir(), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
      } catch (e) {
        console.error(`[gooni] could not persist ${name}:`, e.message);
      }
    },
  };
}

function createAppSensor() {
  const reporter = new AppReporter({
    store: jsonStore(APP_SENSOR_STATE),
    openStore: jsonStore(APP_SENSOR_OPEN),
    getBaseUrl: () => config.apiUrl,
    getToken: () => currentToken().token,
  });
  appSensor = new AppSensor({
    tracker: new AppFocusTracker({}),
    reporter,
    queryFrontmost: () => queryFrontmost({ execFileImpl: execFile }),
    // Seconds since the last keyboard/mouse input, machine-wide. This is the
    // whole reason a frontmost-app poll doesn't credit lunch to whatever was on
    // screen — see AppSensor's header.
    getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    idleSec: config.appSensor.idleSec,
    pollMs: config.appSensor.pollMs,
    flushMs: config.appSensor.flushMs,
    onStatus: () => refreshTray(),
    log: (text) => console.log(`[gooni] app sensor: ${text}`),
  });

  if (config.appSensor.enabled) appSensor.start();
}

/**
 * Sleep and lock are the two ways attention ends that no poll can observe after
 * the fact. Both are delivered BEFORE the machine goes away, so the interval
 * closes with a real end time instead of being salvaged on the next launch.
 *
 * Registered ONCE and dispatched through the module-level `appSensor`, not from
 * inside createAppSensor — a config reload builds a new sensor, and re-adding
 * listeners each time would leave every previous one attached, firing suspend
 * at a sensor that has already stopped.
 */
function registerPowerEvents() {
  powerMonitor.on("suspend", () => appSensor?.onSuspend());
  powerMonitor.on("lock-screen", () => appSensor?.onLock());
  powerMonitor.on("resume", () => appSensor?.onResume());
  powerMonitor.on("unlock-screen", () => appSensor?.onResume());
}

// ── windows ──────────────────────────────────────────────────────────────────

function appPreloadArgs() {
  return [`--gooni-api-url=${config.apiUrl}`];
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(__dirname, "preload-app.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: appPreloadArgs(),
    },
  });

  mainWindow.loadURL(config.appUrl);

  // A window that fails to load must SAY so. A blank black rectangle is the
  // desktop equivalent of a buffer filling against a backend that is down.
  mainWindow.webContents.on("did-finish-load", () => {
    const url = mainWindow.webContents.getURL();
    if (!url.startsWith("data:")) console.log(`[gooni] window loaded ${url}`);
  });

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (code === -3) return; // aborted (a navigation superseded this one)
    console.error(`[gooni] window FAILED to load ${url}: ${desc} (${code})`);
    const html = failurePage({ url: url || config.appUrl, desc, code, configPath });
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });

  mainWindow.on("close", (e) => {
    // Menu-bar app: closing the window hides it, quitting is explicit. Without
    // this, closing the window would also end the sidecar's supervision.
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
  });

  // Anything that isn't the app opens in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function failurePage({ url, desc, code, configPath: cfgPath }) {
  return `<!doctype html><meta charset="utf-8"><style>
    body{background:#0b0f0d;color:#f4f5f4;font:14px -apple-system,system-ui,sans-serif;
         margin:0;display:flex;align-items:center;justify-content:center;height:100vh}
    .box{max-width:520px;padding:28px;line-height:1.55}
    h1{font-size:16px;margin:0 0 10px;font-weight:600}
    code{background:rgba(244,245,244,.08);padding:2px 5px;border-radius:4px;font-size:12px}
    p{color:rgba(244,245,244,.66)}
    button{font:inherit;margin-top:16px;padding:7px 14px;border-radius:8px;cursor:pointer;
           background:rgba(244,245,244,.1);color:inherit;border:1px solid rgba(244,245,244,.18)}
  </style><div class="box">
    <h1>Couldn't load the Gooni frontend</h1>
    <p><code>${escapeHtml(url)}</code> — ${escapeHtml(desc)} (${code})</p>
    <p>The shell is still running and the focus-cam sidecar is still supervised;
       only this window failed. Set <code>appUrl</code> in <code>${escapeHtml(cfgPath)}</code>
       if the frontend lives somewhere else.</p>
    <!-- Navigate to the app URL, NOT location.reload() — this page is a data:
         URL, so reloading it would just redraw the error. -->
    <button data-url="${escapeHtml(url)}" onclick="location.href=this.dataset.url">Retry</button>
  </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function showMain() {
  if (!mainWindow) createMainWindow();
  mainWindow.show();
  mainWindow.focus();
}

// ── capture overlay ──────────────────────────────────────────────────────────

/**
 * The capture window is the shell's OWN page, not a route in the web app.
 *
 * The hotkey has to bring up capture *directly* — an ambient assistant you can
 * talk to mid-thought is the whole point — and a hidden, pre-loaded local page
 * appears instantly, where navigating a remote SPA to a capture route would
 * cost a page load at exactly the moment the thought is fragile. It sends over
 * IPC to the main process, which posts to the same conversation endpoint the
 * ambient wave uses, so nothing about the pipeline is bypassed.
 */
function createCaptureWindow() {
  captureWindow = new BrowserWindow({
    width: 620,
    height: 190,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-capture.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // A frameless overlay has no visible devtools, so a renderer error would be
  // completely silent — the window would just stop responding to Enter. Errors
  // are forwarded to the main log instead.
  captureWindow.webContents.on("console-message", (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[gooni] capture renderer: ${message} (${source}:${line})`);
  });
  captureWindow.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error(`[gooni] capture overlay FAILED to load: ${desc} (${code})`);
  });

  captureWindow.setAlwaysOnTop(true, "floating");
  // Summonable from a full-screen space — otherwise the hotkey silently does
  // nothing exactly when you are heads-down in something else.
  captureWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  captureWindow.loadFile(path.join(__dirname, "..", "renderer", "capture.html"));

  captureWindow.on("blur", () => {
    if (config.hideCaptureOnBlur && captureWindow?.isVisible()) hideCapture();
  });
  captureWindow.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    hideCapture();
  });
}

function positionCapture() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width, height } = display.workArea;
  const [w, h] = captureWindow.getSize();
  // Upper third of whichever screen you are looking at, not screen 1's centre.
  captureWindow.setPosition(
    Math.round(x + (width - w) / 2),
    Math.round(y + Math.min(height * 0.28, height - h))
  );
}

function showCapture() {
  if (!captureWindow) createCaptureWindow();
  positionCapture();
  // The hotkey fires while some OTHER app is frontmost, which is the entire
  // point. On macOS, showing and focusing a window of a background app does not
  // give it keyboard focus — the keystrokes would keep going to the app you were
  // in. Activating the app first is what makes typing land in the box.
  if (process.platform === "darwin") app.focus({ steal: true });
  captureWindow.show();
  captureWindow.focus();
  captureWindow.webContents.send("capture:opened", captureState());
  console.log(`[gooni] capture overlay shown (token=${currentToken().source})`);
}

/**
 * `--capture` summons the overlay instead of the window.
 *
 * Honoured on first launch and on `second-instance`, which makes
 * `open -a Gooni --args --capture` a second way in — useful for binding capture
 * from Raycast/Alfred/Shortcuts when the built-in accelerator is already taken
 * by something else.
 */
function wantsCapture(argv) {
  return (argv || []).includes("--capture");
}

function hideCapture() {
  if (!captureWindow) return;
  captureWindow.webContents.send("capture:closed");
  captureWindow.hide();
}

function toggleCapture() {
  if (captureWindow?.isVisible()) hideCapture();
  else showCapture();
}

function captureState() {
  const { source } = currentToken();
  return {
    apiUrl: config.apiUrl,
    signedIn: source !== "none",
    tokenSource: source,
  };
}

// ── tray ─────────────────────────────────────────────────────────────────────

function trayImage() {
  const file = path.join(__dirname, "..", "assets", "trayTemplate.png");
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return nativeImage.createEmpty();
  img.setTemplateImage(true);
  return img;
}

function refreshTray() {
  if (!tray) return;
  const status = sidecar ? sidecar.status() : { state: "stopped", restarts: 0 };
  const { source } = currentToken();
  const sensorStatus = appSensor ? appSensor.status() : null;
  const summary = summarize({ config, sidecar: status, tokenSource: source, appSensor: sensorStatus });

  const template = buildMenuTemplate({
    config,
    sidecar: status,
    tokenSource: source,
    appSensor: sensorStatus,
    // Unpackaged, the OS registration is deliberately skipped (see
    // applyLaunchAtLogin), so the checkbox reflects the stored preference —
    // otherwise it would silently uncheck itself every dev run.
    launchAtLogin: app.isPackaged ? app.getLoginItemSettings().openAtLogin : config.launchAtLogin,
    handlers: {
      open: showMain,
      capture: showCapture,
      startSidecar: () => {
        sidecar.configure(config.sidecar);
        sidecar.start();
      },
      stopSidecar: () => sidecar.stop(),
      restartSidecar: () => sidecar.restart(),
      openSidecarLog: () => {
        const file = sidecarLogPath();
        if (fs.existsSync(file)) shell.openPath(file);
        else dialog.showErrorBox("No sidecar log yet", `Nothing has been written to ${file}.`);
      },
      toggleLaunchAtLogin: (item) => setLaunchAtLogin(item.checked),
      openConfig: () => shell.openPath(configPath),
      reloadConfig: () => reloadConfig().catch((e) => console.error("[gooni] reload failed:", e?.message)),
      quit: () => app.quit(),
    },
  });

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(summary.text);
  // The menu-bar title is the always-visible surface, so it carries the alarm.
  // Silent when healthy — an ambient app that decorates the menu bar at rest is
  // noise; one that says nothing while its sidecar is dead is a lie.
  tray.setTitle(summary.ok ? "" : " ⚠");
}

/**
 * Launch-at-login, but never from an unpackaged run.
 *
 * `npm start` runs node_modules/.bin/electron, so registering a login item here
 * would put *Electron* — not Gooni — in the user's login items, pointed at a
 * path inside a checkout that may not exist tomorrow. The preference is still
 * remembered in config; only the OS-level registration waits for a real build.
 */
function applyLaunchAtLogin(enabled) {
  if (!app.isPackaged) {
    console.warn("[gooni] launch-at-login is a no-op in an unpackaged run (would register Electron, not Gooni)");
    return;
  }
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true });
}

function setLaunchAtLogin(enabled) {
  applyLaunchAtLogin(enabled);
  config.launchAtLogin = Boolean(enabled);
  try {
    configModule.save(userDataDir(), config);
  } catch (e) {
    console.error("[gooni] could not persist launchAtLogin:", e.message);
  }
  refreshTray();
}

// ── hotkey ───────────────────────────────────────────────────────────────────

function registerHotkey() {
  globalShortcut.unregisterAll();
  if (!config.hotkey) return true;
  const ok = globalShortcut.register(config.hotkey, toggleCapture);
  if (!ok) {
    // Another app already owns the combination. Silence here would be the worst
    // outcome: the highest-value feature would appear to be installed and do
    // nothing when pressed.
    dialog.showErrorBox(
      "Gooni: capture hotkey unavailable",
      `${config.hotkey} is already claimed by another app.\n\nPick a different "hotkey" in ${configPath} and use Reload config.`
    );
  }
  return ok;
}

function sameSidecar(a, b) {
  return (
    a.enabled === b.enabled &&
    a.command === b.command &&
    a.cwd === b.cwd &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    JSON.stringify(a.env) === JSON.stringify(b.env)
  );
}

async function reloadConfig() {
  const before = config;
  loadConfig();
  registerHotkey();

  // `configure()` only stores; a running child keeps its old command until it is
  // replaced. Restart ONLY when the sidecar config actually changed — a reload
  // that tore down the camera process every time would make the menu item
  // something you learn not to press.
  sidecar.configure(config.sidecar);
  if (!sameSidecar(before.sidecar, config.sidecar)) {
    await sidecar.restart();
  }

  // The sensor reads its cadence at construction, so a changed knob needs a new
  // one. Stopping FLUSHES first, so a reload can't strand buffered attention.
  if (JSON.stringify(before.appSensor) !== JSON.stringify(config.appSensor)) {
    await appSensor?.stop();
    createAppSensor();
  }

  if (mainWindow && (before.apiUrl !== config.apiUrl || before.appUrl !== config.appUrl)) {
    // `additionalArguments` is fixed at window creation, and that is how the
    // preload learns the API base — so a changed apiUrl needs a NEW window, not
    // a reload. Reloading would silently keep talking to the old backend.
    const wasVisible = mainWindow.isVisible();
    const stale = mainWindow;
    mainWindow = null;
    stale.destroy();
    createMainWindow();
    if (wasVisible) showMain();
  }
  refreshTray();
}

// ── ipc ──────────────────────────────────────────────────────────────────────

function registerIpc() {
  ipcMain.on("gooni:token", (_e, token) => {
    const value = String(token || "").trim();
    if (!value || value === harvestedToken) return;
    harvestedToken = value;
    try {
      tokenModule.saveHarvested(userDataDir(), value);
    } catch (e) {
      console.error("[gooni] could not persist token:", e.message);
    }
    refreshTray();
  });

  ipcMain.handle("capture:state", () => captureState());

  ipcMain.handle("capture:send", async (_e, text) => {
    try {
      const { reply } = await api.capture(text);
      return { ok: true, reply };
    } catch (e) {
      if (e.code === "not_authenticated") {
        return {
          ok: false,
          error: "Not signed in — open Gooni and sign in once, then try again.",
          code: e.code,
        };
      }
      return { ok: false, error: e.message, code: e.code || "error" };
    }
  });

  ipcMain.on("capture:hide", () => hideCapture());
  ipcMain.on("capture:open-app", () => {
    hideCapture();
    showMain();
  });
  ipcMain.on("capture:resize", (_e, height) => {
    if (!captureWindow) return;
    const [w] = captureWindow.getSize();
    captureWindow.setSize(w, Math.max(150, Math.min(560, Math.round(height))));
  });
}

// ── lifecycle ────────────────────────────────────────────────────────────────

// One instance, or two supervisors fight over one camera.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => (wantsCapture(argv) ? showCapture() : showMain()));

  app.whenReady().then(() => {
    loadConfig();
    harvestedToken = tokenModule.loadHarvested(userDataDir());
    openLogStream();

    api = new GooniApi({
      getBaseUrl: () => config.apiUrl,
      getToken: () => currentToken().token,
    });

    registerIpc();
    createSidecar();
    registerPowerEvents();
    createAppSensor();
    createMainWindow();
    createCaptureWindow();

    tray = new Tray(trayImage());
    tray.setToolTip("Gooni");
    refreshTray();
    // Left-click on macOS opens the menu rather than doing nothing.
    tray.on("click", () => tray.popUpContextMenu());

    const hotkeyOk = registerHotkey();
    applyLaunchAtLogin(config.launchAtLogin);

    // One boot line that states what this process actually is. The shell's whole
    // premise is which backend it talks to, so that had better be greppable.
    console.log(
      `[gooni] backend=${config.apiUrl} app=${config.appUrl} hotkey=${config.hotkey}${
        hotkeyOk ? "" : " (UNAVAILABLE)"
      } token=${currentToken().source} ${describe(sidecar.status())} app-sensor=${
        config.appSensor.enabled ? `on (${config.appSensor.pollMs}ms)` : "off"
      }`
    );

    // Hidden at login, visible when you launched it yourself.
    if (wantsCapture(process.argv)) showCapture();
    else if (!app.getLoginItemSettings().wasOpenedAtLogin) showMain();

    // Tray states like `backoff` change on a timer with no event to hang off.
    setInterval(refreshTray, 5_000).unref?.();
  });

  app.on("window-all-closed", () => {
    // Menu-bar app. Closing every window is not quitting — the sidecar has to
    // keep being supervised.
  });

  app.on("activate", () => showMain());

  // The sidecar is spawned DETACHED (so stop() can signal its whole tree), which
  // means it does not die with us. A `killall`, a logout, or a terminal Ctrl-C
  // during `npm start` would therefore leave a camera-holding orphan — the exact
  // thing the supervisor exists to prevent. Route those into the normal quit.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      console.log(`[gooni] ${signal} — shutting down`);
      app.quit();
    });
  }

  app.on("before-quit", async (e) => {
    if (quitting) return;
    // The sidecar holds the camera. Quitting without waiting for it to die is
    // how you end up with a privacy light on and nothing owning the process.
    e.preventDefault();
    quitting = true;
    globalShortcut.unregisterAll();
    try {
      // Close the open interval with a REAL end time and hand over the buffer.
      // Skipping this is what turns every clean quit into a salvaged, truncated
      // row on the next launch.
      await appSensor?.stop();
    } catch (err) {
      console.error("[gooni] app sensor stop failed:", err?.message);
    }
    try {
      await sidecar?.stop();
    } catch (err) {
      console.error("[gooni] sidecar stop failed:", err?.message);
    }
    logStream?.end();
    app.quit();
  });
}
