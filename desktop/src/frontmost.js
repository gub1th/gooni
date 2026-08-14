/**
 * "Which macOS app is frontmost right now?"
 *
 * Electron has no API for this — `app.focus`/`BrowserWindow` only know about
 * OUR windows, and the whole point of this sensor is the other 23 hours. Three
 * mechanisms were available:
 *
 *   1. a maintained npm package (`active-win` and friends) — a prebuilt native
 *      addon, so it would also be a new dependency AND a compiled artifact that
 *      has to match the Electron ABI on every upgrade;
 *   2. a small native helper of our own — the fastest and the most code, plus a
 *      second unsigned binary for macOS to forget the permission grant of;
 *   3. a scripted query — `osascript` asking System Events, spawned per poll.
 *
 * This is (3), and the tradeoff is stated rather than hidden: it costs a process
 * spawn every POLL_MS and a few tens of milliseconds of CPU per spawn, which is
 * real but unnoticeable at a multi-second cadence, and it buys ZERO new
 * dependencies, no compiled artifact, and no second thing to codesign later.
 * The precision it gives up does not matter here: the row this feeds is
 * "opened X after five minutes away", so being a few seconds late to notice a
 * switch changes nothing about the output.
 *
 * It needs macOS **Accessibility** permission. The build is unsigned, so the
 * grant is tied to a binary identity that changes on every rebuild — a
 * re-prompt after rebuilding is expected and documented, not a bug (see
 * desktop/README.md).
 *
 * No electron import, so the parsing and the failure classification are
 * unit-testable with an injected exec.
 */

/**
 * `System Events` is the accessibility bridge; `frontmost is true` is how it
 * names the app the human is actually looking at. `name of` gives the display
 * name ("Google Chrome"), which is what a human recognises — the bundle id
 * would be stable but unreadable, and this is a display label.
 */
const FRONTMOST_SCRIPT =
  'tell application "System Events" to get name of first application process whose frontmost is true';

/** Longest we wait on one query. See `queryFrontmost`. */
const QUERY_TIMEOUT_MS = 3000;

/**
 * True when the error text is macOS refusing us the Accessibility grant rather
 * than something transient.
 *
 * Worth distinguishing because the two need opposite responses: a transient
 * failure should be retried silently forever, while a permission failure will
 * NEVER clear on its own and has to be said out loud — otherwise the sensor
 * spends its life politely retrying and reporting nothing, which is exactly the
 * shape of quiet failure this app keeps having to fix.
 */
function isPermissionError(text) {
  const s = String(text || "").toLowerCase();
  return (
    s.includes("not allowed assistive") ||
    s.includes("not authorized") ||
    s.includes("-1743") ||
    s.includes("assistive access") ||
    s.includes("accessibility")
  );
}

/** osascript prints the name and a newline; anything else is not an app name. */
function parseFrontmost(stdout) {
  const name = String(stdout || "").trim();
  if (!name) return null;
  // A multi-line answer means the script didn't do what we think it did.
  // Guessing at the first line would silently record whatever that was.
  if (name.includes("\n")) return null;
  return name;
}

/**
 * Ask once. Resolves `{app}` or `{app: null, error, permission}` — it NEVER
 * rejects, because this runs on a timer inside the serialized reconcile and a
 * rejection there would have to be caught at every call site anyway.
 *
 * Bounded by `timeoutMs` for the same reason the extension bounds its idle
 * probe and its flush: everything in the sensor's critical path has to settle,
 * or one wedged System Events (which does happen — it is a scriptable app like
 * any other) would stall every later tick and produce a dead sensor with
 * nothing erroring.
 */
function queryFrontmost({ execFileImpl, timeoutMs = QUERY_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(
      () => done({ app: null, error: "timeout", permission: false }),
      timeoutMs
    );
    try {
      execFileImpl("osascript", ["-e", FRONTMOST_SCRIPT], { timeout: timeoutMs }, (err, stdout, stderr) => {
        clearTimeout(timer);
        if (err) {
          const text = String(stderr || err.message || "");
          done({ app: null, error: text.trim() || "osascript failed", permission: isPermissionError(text) });
          return;
        }
        const app = parseFrontmost(stdout);
        done(app ? { app } : { app: null, error: "no frontmost app", permission: false });
      });
    } catch (e) {
      clearTimeout(timer);
      done({ app: null, error: e.message, permission: false });
    }
  });
}

module.exports = {
  FRONTMOST_SCRIPT,
  QUERY_TIMEOUT_MS,
  isPermissionError,
  parseFrontmost,
  queryFrontmost,
};
