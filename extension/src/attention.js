/**
 * "Is the human attending to a page right now, and which one?"
 *
 * This is the single source of truth for that question. It lives here, chrome-
 * free and probe-injected, for two reasons: it is the decision every event path
 * (tab switch, window focus, heartbeat poll, idle transition) funnels through,
 * and it is the decision that has to be unit-testable, because getting it wrong
 * is invisible — it does not crash, it just quietly writes numbers that are not
 * true.
 *
 * THE THING THAT MAKES IDLE LOAD-BEARING HERE: a focused Chrome window is NOT
 * the same claim as an attending human. Walking away from the machine does not
 * unfocus the window, so `windows.getLastFocused().focused` stays true through
 * a two-hour lunch. Asking only that question means the 30s heartbeat poll
 * re-opens an interval on a tracker that `chrome.idle` had just correctly
 * closed, and the machine accrues focus time for the entire time nobody is
 * there — the exact lie chrome.idle was added to prevent, and an overcount the
 * server has no way to detect. So the idle probe is checked FIRST and anything
 * other than "active" means no attention, full stop.
 *
 * Putting it here rather than in the heartbeat handler is the point: every
 * caller inherits the correct answer, and a future caller cannot reintroduce
 * the hole by forgetting to ask.
 */

/** What we report when the idle probe cannot give a trustworthy answer. */
export const IDLE_PROBE_FALLBACK = "idle";

/** How long the probe waits for chrome before assuming the worst. */
export const IDLE_PROBE_TIMEOUT_MS = 2000;

/**
 * Wrap chrome's callback-based `idle.queryState` as a promise that ALWAYS
 * settles, and always settles "idle" when it cannot do better.
 *
 * Two guards, both load-bearing:
 *
 *  - **Fails closed.** A throw, a missing answer, or a non-string answer
 *    reports "idle" — no attention. This sensor's errors are meant to be
 *    undercounts; a probe that guessed "active" would hand back precisely the
 *    overcount it exists to prevent.
 *  - **Always settles.** The probe runs inside the reconcile queue, so a
 *    callback chrome never invokes would leave that queue slot pending and
 *    wedge every later event behind it — a silently dead sensor. The timeout
 *    makes that failure a lost interval instead of a lost day.
 *
 * @param {(seconds:number, cb:(state:string)=>void)=>void} queryState
 * @param {number} detectionSec  seconds of no input before chrome calls it idle
 */
export function makeIdleProbe(queryState, detectionSec, {
  timeoutMs = IDLE_PROBE_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  return () =>
    new Promise((resolve) => {
      let done = false;
      const settle = (state) => {
        if (done) return;
        done = true;
        clearTimer(timer);
        resolve(typeof state === "string" && state ? state : IDLE_PROBE_FALLBACK);
      };
      const timer = setTimer(() => settle(IDLE_PROBE_FALLBACK), timeoutMs);
      try {
        queryState(detectionSec, settle);
      } catch {
        settle(IDLE_PROBE_FALLBACK);
      }
    });
}

/**
 * Resolve what currently holds attention, or null if nothing does.
 *
 * Every probe is injected so the real decision runs in tests with chrome
 * swapped out. Each is expected to fail SOFT (return null/undefined rather than
 * throw); background.js is what adapts chrome's shapes and swallows its errors.
 *
 * @param {object} probes
 * @param {() => Promise<string>} probes.getIdleState  "active" | "idle" | "locked"
 * @param {() => Promise<object|null>} probes.getFocusedWindow
 * @param {(windowId: any) => Promise<object|null>} probes.getActiveTab
 * @param {(url: string) => (object|null|Promise<object|null>)} probes.scrubPage
 * @returns {Promise<{url:string, host:string, path:string, title:string|null}|null>}
 */
export async function resolveAttention({
  getIdleState,
  getFocusedWindow,
  getActiveTab,
  scrubPage,
}) {
  // Cheapest and strongest signal first: if nobody is at the machine, which
  // window Chrome thinks is focused is irrelevant.
  const idleState = await getIdleState();
  if (idleState !== "active") return null;

  const win = await getFocusedWindow();
  if (!win || !win.focused) return null;

  const tab = await getActiveTab(win.id);
  if (!tab || !tab.url) return null;

  const page = await scrubPage(tab.url);
  if (!page) return null;

  return { ...page, title: tab.title || null };
}

/**
 * Apply a resolved attention answer to the tracker.
 *
 * Split out from the chrome wiring so the full reconcile decision — probe,
 * then act — is exercisable as one unit. `staleClose` distinguishes the two
 * ways attention's end is learned: an EVENT knows the moment it happened, so it
 * closes at `at`; a POLL only knows it has already happened, so it closes at
 * the last heartbeat that CONFIRMED attention, making the residual error an
 * undercount rather than a gift of a whole poll period.
 */
export function applyAttention(tracker, page, { at, staleClose = false, enabled = true }) {
  if (!enabled) {
    tracker.discard();
    return;
  }
  if (!page) {
    if (staleClose) tracker.blurStale();
    else tracker.blur(at);
    return;
  }
  tracker.focus({ ...page, at });
}
