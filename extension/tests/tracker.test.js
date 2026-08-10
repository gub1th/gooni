/**
 * Interval-closing + idle net. Fake clock, injected id factory — the whole
 * point is that duration math is checkable without a browser.
 *
 * Run: cd extension && npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { FocusTracker, MAX_INTERVAL_MS } from "../src/tracker.js";

const T0 = Date.UTC(2026, 7, 8, 17, 0, 0);
const page = (host, path = "/", extra = {}) => ({
  url: `https://${host}${path}`,
  host,
  path,
  title: `${host} page`,
  ...extra,
});

function make() {
  const emitted = [];
  let n = 0;
  const tracker = new FocusTracker({
    onInterval: (i) => emitted.push(i),
    idFactory: () => `id-${++n}`,
  });
  return { tracker, emitted };
}

const secs = (i) =>
  (Date.parse(i.ended_at) - Date.parse(i.started_at)) / 1000;

test("switching tabs closes the previous interval with its real duration", () => {
  const { tracker, emitted } = make();
  tracker.focus({ ...page("leetcode.com", "/problems/two-sum/"), at: T0 });
  tracker.focus({ ...page("news.ycombinator.com"), at: T0 + 90_000 });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].host, "leetcode.com");
  assert.equal(emitted[0].path, "/problems/two-sum/");
  assert.equal(emitted[0].end_reason, "tab_change");
  assert.equal(secs(emitted[0]), 90);
  // The new interval is open, not yet emitted.
  assert.equal(tracker.open.host, "news.ycombinator.com");
});

test("navigating within a host closes with url_change, not tab_change", () => {
  const { tracker, emitted } = make();
  tracker.focus({ ...page("leetcode.com", "/problems/two-sum/"), at: T0 });
  tracker.focus({ ...page("leetcode.com", "/problems/three-sum/"), at: T0 + 60_000 });
  assert.equal(emitted[0].end_reason, "url_change");
});

test("a repeated focus event for the same url does not chop the interval", () => {
  const { tracker, emitted } = make();
  tracker.focus({ ...page("leetcode.com", "/problems/two-sum/"), at: T0 });
  tracker.focus({ ...page("leetcode.com", "/problems/two-sum/"), at: T0 + 10_000 });
  tracker.focus({ ...page("leetcode.com", "/problems/two-sum/"), at: T0 + 20_000 });
  assert.equal(emitted.length, 0);
  tracker.blur(T0 + 30_000);
  assert.equal(emitted.length, 1);
  assert.equal(secs(emitted[0]), 30);
});

test("a backgrounded window produces no further focus time", () => {
  const { tracker, emitted } = make();
  tracker.focus({ ...page("leetcode.com"), at: T0 });
  tracker.blur(T0 + 30_000);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].end_reason, "window_blur");
  assert.equal(secs(emitted[0]), 30);

  // Nothing is open, so time spent in another app accrues to nothing.
  assert.equal(tracker.open, null);
  assert.equal(tracker.blur(T0 + 3_600_000), null);
  assert.equal(emitted.length, 1);
});

test("a poll that DISCOVERS the blur closes at the last confirmed heartbeat", () => {
  // macOS never fires windows.onFocusChanged when another app takes the
  // foreground, so the 30s heartbeat poll is what notices. Crediting the
  // browser with the time between the last confirmed heartbeat and the poll
  // that found the window unfocused would be a silent overcount on every
  // alt-tab away.
  const { tracker, emitted } = make();
  tracker.focus({ ...page("leetcode.com"), at: T0 });
  tracker.heartbeat(T0 + 30_000);
  tracker.heartbeat(T0 + 60_000);
  // He alt-tabbed somewhere in the next 30s; the poll at T0+90s finds it gone.
  tracker.blurStale();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].end_reason, "window_blur");
  assert.equal(secs(emitted[0]), 60, "closed at the last CONFIRMED attention");
});

test("blurStale on nothing open is a no-op", () => {
  const { tracker, emitted } = make();
  assert.equal(tracker.blurStale(), null);
  assert.equal(emitted.length, 0);
});

test("idle is BACKDATED by the detection interval", () => {
  const { tracker, emitted } = make();
  tracker.focus({ ...page("leetcode.com"), at: T0 });
  // Focused at T0, chrome reports idle at T0+300s having waited 60s for it.
  tracker.idle(T0 + 300_000, 60_000);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].end_reason, "idle");
  // 300s elapsed but the last 60 were provably not attention.
  assert.equal(secs(emitted[0]), 240);
});

test("idle backdating never runs an interval backwards", () => {
  const { tracker, emitted } = make();
  tracker.focus({ ...page("leetcode.com"), at: T0 });
  // Idle fires 10s in, with a 60s detection window (a resumed-from-sleep
  // machine can do this). The interval must clamp to zero, not go negative.
  tracker.idle(T0 + 10_000, 60_000);
  assert.equal(emitted.length, 0, "a zero-length interval is dropped, not negative");
});

test("an idle machine accrues nothing", () => {
  const { tracker, emitted } = make();
  tracker.focus({ ...page("leetcode.com"), at: T0 });
  tracker.idle(T0 + 120_000, 60_000);
  emitted.length = 0;
  // Eight hours pass with the machine idle and the tab still open.
  assert.equal(tracker.heartbeat(T0 + 8 * 3600_000), undefined);
  assert.equal(tracker.open, null);
  assert.equal(emitted.length, 0);
});

test("lock closes immediately without backdating", () => {
  const { tracker, emitted } = make();
  tracker.focus({ ...page("leetcode.com"), at: T0 });
  tracker.lock(T0 + 45_000);
  assert.equal(emitted[0].end_reason, "locked");
  assert.equal(secs(emitted[0]), 45);
});

test("sub-second switch noise is dropped", () => {
  const { tracker, emitted } = make();
  tracker.focus({ ...page("a.com"), at: T0 });
  tracker.focus({ ...page("b.com"), at: T0 + 400 });
  assert.equal(emitted.length, 0);
});

test("an orphaned interval closes at its last heartbeat, not at restart", () => {
  const { tracker, emitted } = make();
  tracker.focus({ ...page("leetcode.com"), at: T0 });
  tracker.heartbeat(T0 + 60_000);
  tracker.heartbeat(T0 + 120_000);

  // Browser is killed. A snapshot round-trips through storage; the worker
  // comes back sixteen hours later.
  const snapshot = JSON.parse(JSON.stringify(tracker.toJSON()));
  const revived = new FocusTracker({ onInterval: (i) => emitted.push(i), idFactory: () => "id-r" });
  revived.load(snapshot);
  revived.recoverOrphan();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].truncated, true);
  assert.equal(emitted[0].end_reason, "truncated");
  assert.equal(secs(emitted[0]), 120, "salvaged at the heartbeat, not at restart");
});

test("a 16-hour close with no heartbeat reports nothing, not 16 hours", () => {
  const { tracker, emitted } = make();
  tracker.focus({ ...page("leetcode.com"), at: T0 });
  // Lid closed: the process is suspended, so no heartbeat ever ran. Sixteen
  // hours later the machine wakes and the window blurs. The last moment we
  // can PROVE attention is the moment focus started, so nothing is emitted —
  // the heartbeat runs every minute while an interval is open, so a span with
  // zero heartbeats was under a minute of real attention anyway.
  tracker.blur(T0 + 16 * 3600_000);
  assert.equal(emitted.length, 0);
});

test("a heartbeat run past the cap is clamped and flagged, never emitted raw", () => {
  const { tracker, emitted } = make();
  tracker.focus({ ...page("leetcode.com"), at: T0 });
  // A pathological clock (NTP jump, VM restore) drags the heartbeat far past
  // the cap. Clamp and flag rather than emit an impossible span.
  tracker.heartbeat(T0 + 20 * 3600_000);
  tracker.blur(T0 + 20 * 3600_000);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].truncated, true);
  assert.equal(
    Date.parse(emitted[0].ended_at) - Date.parse(emitted[0].started_at),
    MAX_INTERVAL_MS,
    "clamped to the cap"
  );
});

test("every emitted interval carries a distinct stable client_id", () => {
  const { tracker, emitted } = make();
  tracker.focus({ ...page("a.com"), at: T0 });
  tracker.focus({ ...page("b.com"), at: T0 + 10_000 });
  tracker.blur(T0 + 20_000);
  assert.deepEqual(
    emitted.map((i) => i.client_id),
    ["id-1", "id-2"]
  );
});
