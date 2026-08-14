/**
 * The menu-bar menu, as data.
 *
 * Built as a plain template (no electron import) so the wording — which is the
 * feature — is testable, the same reason extension/src/status.js is DOM-free.
 * The menu is the ONLY always-visible surface this app has, so it is where
 * every "this is not actually working" state has to appear:
 *
 *   - a sidecar that is unconfigured, failed or crash-looping;
 *   - a backend pointed at localhost (fine while dev.sh runs, silent death
 *     otherwise — the exact trap the extension's default had);
 *   - no token, which means the capture hotkey cannot deliver anything;
 *   - a frontmost-app sensor macOS is refusing Accessibility to, which never
 *     clears on its own and otherwise looks exactly like a quiet day.
 *
 * None of those are errors the app can fix by itself, so none of them are
 * allowed to be quiet.
 */

const { describe, isUnhealthy, STATES } = require("./sidecar");
const { describeReporter } = require("./appreporter");
const { isLocalBackend } = require("./config");

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || "");
  }
}

/**
 * The one-line summary the tray tooltip carries, and the title of the first
 * (disabled) menu row. Worst news wins — a tooltip that says "Gooni" while the
 * sidecar crash-loops is a tooltip that lies.
 */
function summarize({ config, sidecar, tokenSource, appSensor = null }) {
  const problems = [];
  if (isUnhealthy(sidecar.state)) problems.push(describe(sidecar));
  // Only the permission refusal reaches the HEADLINE. A buffered backlog is
  // normal (the machine was offline), and a permanent tray warning is one you
  // stop reading — the same rule the extension's badge follows. A missing
  // Accessibility grant is different: it never clears, and until it does the
  // sensor records nothing while looking installed.
  if (config.appSensor?.enabled && appSensor?.permission === false) {
    problems.push("App sensor: no Accessibility permission — grant it in System Settings");
  }
  if (tokenSource === "none") problems.push("Not signed in — capture can't send");
  if (isLocalBackend(config.apiUrl)) problems.push(`Backend is local (${hostOf(config.apiUrl)})`);
  if (problems.length) return { ok: false, text: problems[0], problems };
  return { ok: true, text: `Gooni — ${hostOf(config.apiUrl)}`, problems: [] };
}

function buildMenuTemplate({ config, sidecar, tokenSource, appSensor = null, launchAtLogin, handlers = {} }) {
  const summary = summarize({ config, sidecar, tokenSource, appSensor });
  const items = [];

  items.push({ id: "summary", label: summary.text, enabled: false });
  // Every problem, not just the headline one — three quiet failures stacked is
  // the realistic case (fresh install: no sidecar, no token, default backend).
  for (const p of summary.problems.slice(1)) {
    items.push({ id: `problem:${p}`, label: `⚠ ${p}`, enabled: false });
  }
  items.push({ type: "separator" });

  items.push({ id: "open", label: "Open Gooni", click: handlers.open });
  items.push({
    id: "capture",
    label: "Quick capture",
    accelerator: config.hotkey,
    click: handlers.capture,
  });
  items.push({ type: "separator" });

  const sidecarItems = [];
  sidecarItems.push({ id: "sidecar:state", label: describe(sidecar), enabled: false });
  if (sidecar.command) {
    sidecarItems.push({ id: "sidecar:command", label: sidecar.command, enabled: false });
  }
  if (sidecar.restarts > 0) {
    sidecarItems.push({
      id: "sidecar:restarts",
      label: `restarted ${sidecar.restarts}×${sidecar.lastExit ? ` · last exit ${sidecar.lastExit.code ?? sidecar.lastExit.signal}` : ""}`,
      enabled: false,
    });
  }
  sidecarItems.push({ type: "separator" });
  const canStart = sidecar.state !== STATES.RUNNING && sidecar.state !== STATES.STARTING;
  sidecarItems.push({ id: "sidecar:start", label: "Start", enabled: canStart, click: handlers.startSidecar });
  sidecarItems.push({ id: "sidecar:stop", label: "Stop", enabled: !canStart, click: handlers.stopSidecar });
  sidecarItems.push({ id: "sidecar:restart", label: "Restart", click: handlers.restartSidecar });
  sidecarItems.push({ id: "sidecar:log", label: "Open log…", click: handlers.openSidecarLog });

  items.push({
    id: "sidecar",
    // The submenu label repeats the state because a submenu you have to open to
    // learn something is a submenu that hides it.
    label: `Focus cam — ${shortState(sidecar)}`,
    submenu: sidecarItems,
  });
  // The app sensor's own row, stating what it is currently doing. It sits
  // outside the summary because most of what it has to say ("31 buffered")
  // is information, not a problem — and information belongs where you look for
  // it, not in the always-visible alarm.
  if (appSensor) {
    items.push({
      id: "appSensor",
      label: describeReporter(appSensor, {
        enabled: Boolean(config.appSensor?.enabled),
        permission: appSensor.permission,
      }),
      enabled: false,
    });
    if (appSensor.current) {
      items.push({ id: "appSensor:current", label: `  now: ${appSensor.current}`, enabled: false });
    }
    items.push({ type: "separator" });
  }

  items.push({
    id: "launchAtLogin",
    label: "Launch at login",
    type: "checkbox",
    checked: Boolean(launchAtLogin),
    click: handlers.toggleLaunchAtLogin,
  });
  items.push({ id: "config", label: "Open config file…", click: handlers.openConfig });
  items.push({ id: "reload", label: "Reload config", click: handlers.reloadConfig });
  items.push({ type: "separator" });
  items.push({ id: "quit", label: "Quit Gooni", click: handlers.quit });

  return items;
}

function shortState(sidecar) {
  switch (sidecar.state) {
    case STATES.RUNNING:
      return "running";
    case STATES.UNCONFIGURED:
      return "not configured";
    case STATES.CRASHLOOPING:
      return "crash looping";
    case STATES.FAILED:
      return "failed";
    case STATES.BACKOFF:
      return "restarting";
    case STATES.DISABLED:
      return "off";
    case STATES.STARTING:
      return "starting";
    default:
      return "stopped";
  }
}

module.exports = { buildMenuTemplate, summarize, shortState, hostOf };
