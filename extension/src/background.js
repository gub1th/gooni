/**
 * MV3 service worker — the only file that touches chrome APIs.
 *
 * Everything with real logic in it (interval math, scrubbing, buffering) lives
 * in chrome-free modules next door so it can be tested. This file is wiring:
 * translate chrome events into tracker calls, persist after every one, and run
 * the flush loop.
 *
 * THE MV3 CONSTRAINT that shapes all of it: this worker is killed after ~30s
 * idle and restarted on the next event. Nothing may live only in memory. The
 * open interval is written to chrome.storage.local after every mutation, so a
 * worker that dies mid-interval loses nothing when the next event revives it —
 * and if the whole browser dies, `recoverOrphan()` closes the stranded
 * interval at its last heartbeat instead of reporting an overnight session.
 */

import { FocusTracker } from "./tracker.js";
import { IntervalBuffer, flushOnce, FLUSH_THRESHOLD } from "./buffer.js";
import { scrubUrl } from "./scrub.js";
import { loadConfig, ingestEndpoint, IDLE_DETECTION_SEC } from "./config.js";

const OPEN_KEY = "gooni_open_interval";
const HEARTBEAT_ALARM = "gooni_heartbeat";
const FLUSH_ALARM = "gooni_flush";

const storage = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
};

const buffer = new IntervalBuffer({ storage });

/**
 * Build a tracker with the persisted open interval loaded. Constructed per
 * event rather than held in a module global: the worker may have been torn
 * down since the last event, so storage is the only source of truth.
 */
async function withTracker(fn) {
  const cfg = await loadConfig(storage);
  const pending = [];
  const tracker = new FocusTracker({ onInterval: (i) => pending.push(i) });
  const got = await storage.get([OPEN_KEY]);
  tracker.load(got[OPEN_KEY] || null);

  await fn(tracker, cfg);

  await storage.set({ [OPEN_KEY]: tracker.toJSON() });
  for (const interval of pending) {
    await buffer.append(interval);
  }
  if (pending.length && (await buffer.size()) >= FLUSH_THRESHOLD) {
    await flush();
  }
  return pending;
}

async function flush() {
  const cfg = await loadConfig(storage);
  const res = await flushOnce({
    buffer,
    endpoint: ingestEndpoint(cfg.baseUrl),
    token: cfg.token,
  });
  await storage.set({
    gooni_last_flush: { at: new Date().toISOString(), ...res },
  });
  return res;
}

/** The page that currently has attention, or null if nothing does. */
async function activeAttention() {
  // lastFocusedWindow + active gives the one tab in the one focused window.
  // If no chrome window is focused the query comes back empty — which is
  // exactly right: a background browser is not attention.
  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (!win || !win.focused) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  if (!tab || !tab.url) return null;
  const scrubbed = scrubUrl(tab.url, (await loadConfig(storage)).scrub);
  if (!scrubbed) return null;
  return { ...scrubbed, title: tab.title || null };
}

/**
 * Bring the tracker in line with what is actually focused right now.
 *
 * `staleClose` distinguishes the two ways we learn attention ended. An EVENT
 * (tab switch, idle) tells us the moment it happened, so we close at `at`. A
 * POLL only tells us it has already happened, so we close at the last
 * heartbeat that confirmed attention — see FocusTracker.blurStale.
 */
async function reconcile(at = Date.now(), { staleClose = false } = {}) {
  const page = await activeAttention();
  await withTracker(async (tracker, cfg) => {
    if (!cfg.enabled) {
      tracker.discard();
      return;
    }
    if (!page) {
      if (staleClose) tracker.blurStale();
      else tracker.blur(at);
      return;
    }
    tracker.focus({ ...page, at });
  });
}

// ── chrome event wiring ──────────────────────────────────────────────────────

/**
 * The heartbeat is load-bearing twice over, which is why it runs at the
 * tightest period MV3 allows (30s):
 *   - it is the salvage anchor for an interval the browser dies inside of;
 *   - it is the ONLY reliable detector of Chrome losing the foreground on
 *     macOS, where windows.onFocusChanged simply does not fire for it.
 * So its period is the worst-case error on any interval that ends by walking
 * away from the browser — and the error is an undercount, never an overcount.
 */
const HEARTBEAT_MINUTES = 0.5;

function installAlarms() {
  chrome.idle.setDetectionInterval(IDLE_DETECTION_SEC);
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
}

/**
 * Both boot paths must SALVAGE any open interval before reconciling.
 *
 * `now` at boot proves nothing about the past: the browser may have been dead
 * for sixteen hours. Closing a stranded interval with a plain blur(now) would
 * credit every one of those hours to whatever tab happened to be open — the
 * exact lie chrome.idle exists to prevent. recoverOrphan closes it at the last
 * heartbeat that confirmed attention (and drops it entirely if no heartbeat
 * ever confirmed one), which is the most we can honestly claim.
 */
async function bootSalvage() {
  await withTracker(async (tracker) => {
    tracker.recoverOrphan();
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  installAlarms();
  await bootSalvage();
  await reconcile();
});

chrome.runtime.onStartup.addListener(async () => {
  installAlarms();
  await bootSalvage();
  await flush();
  await reconcile();
});

chrome.tabs.onActivated.addListener(() => reconcile());

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only the active tab's navigation matters; a background tab finishing a
  // load is not a change in attention. Title-only updates still flow through
  // (focus() treats a same-url event as a title refresh, not a new interval).
  if (!tab.active) return;
  if (!changeInfo.url && !changeInfo.title) return;
  reconcile();
});

// Fires when focus moves BETWEEN Chrome windows, and (on Windows/Linux) when
// Chrome loses the foreground. It does NOT fire on macOS when another app
// takes over — the heartbeat poll covers that case. Either way reconcile()
// asks what is focused rather than trusting the event's argument.
chrome.windows.onFocusChanged.addListener(() => reconcile());

chrome.idle.onStateChanged.addListener(async (state) => {
  const at = Date.now();
  if (state === "idle") {
    // Backdate: the idle threshold had already elapsed when this fired.
    await withTracker(async (tracker) => tracker.idle(at, IDLE_DETECTION_SEC * 1000));
  } else if (state === "locked") {
    await withTracker(async (tracker) => tracker.lock(at));
  } else if (state === "active") {
    await reconcile(at);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    // Poll, not event: close a stranded interval at the last CONFIRMED
    // heartbeat rather than at discovery time.
    await reconcile(Date.now(), { staleClose: true });
  } else if (alarm.name === FLUSH_ALARM) {
    await flush();
  }
});

// The options page asks for a flush after saving config, and for status.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "gooni:flush") {
    flush().then(sendResponse);
    return true;
  }
  if (msg?.type === "gooni:status") {
    (async () => {
      const [cfg, size, dropped, got] = await Promise.all([
        loadConfig(storage),
        buffer.size(),
        buffer.droppedCount(),
        storage.get(["gooni_last_flush", OPEN_KEY]),
      ]);
      sendResponse({
        enabled: cfg.enabled,
        baseUrl: cfg.baseUrl,
        hasToken: Boolean(cfg.token),
        buffered: size,
        dropped,
        lastFlush: got.gooni_last_flush || null,
        open: got[OPEN_KEY] || null,
      });
    })();
    return true;
  }
  return false;
});
