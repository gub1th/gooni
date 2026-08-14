/**
 * The frontmost-app interval state machine.
 *
 * Duration math is the whole product, so every assertion here is about a number
 * that would otherwise be quietly wrong. The three that matter most:
 *
 *   - a poll that re-observes the same app must NOT chop the interval, or every
 *     duration becomes a measurement of the poll cadence;
 *   - idle is BACKDATED, or every walk-away overcounts by the idle threshold;
 *   - a salvaged interval closes at its last confirmed observation and says so,
 *     or quitting at 6pm and launching at 9am reports a fifteen-hour session.
 */

const test = require("node:test");
const assert = require("node:assert");

const { AppFocusTracker, MAX_INTERVAL_MS } = require("../src/appfocus");

const T0 = 1_700_000_000_000;

function makeTracker(over = {}) {
  const emitted = [];
  let n = 0;
  const tracker = new AppFocusTracker({
    onInterval: (iv) => emitted.push(iv),
    idFactory: () => `id-${++n}`,
    ...over,
  });
  return { tracker, emitted };
}

test("re-observing the same app refreshes rather than closing", () => {
  const { tracker, emitted } = makeTracker();
  tracker.focus({ app: "Cursor", at: T0 });
  tracker.focus({ app: "Cursor", at: T0 + 4000 });
  tracker.focus({ app: "Cursor", at: T0 + 8000 });
  assert.deepEqual(emitted, [], "a poll seeing the same app must not emit anything");

  const closed = tracker.focus({ app: "Slack", at: T0 + 12_000 });
  assert.equal(closed.app, "Cursor");
  assert.equal(closed.end_reason, "app_change");
  assert.equal(
    new Date(closed.ended_at).getTime() - new Date(closed.started_at).getTime(),
    12_000,
    "the interval is the whole stretch, not one poll period"
  );
});

test("a sub-threshold visit is dropped as switch noise", () => {
  const { tracker, emitted } = makeTracker({ minDurationMs: 2000 });
  tracker.focus({ app: "Cursor", at: T0 });
  tracker.focus({ app: "Finder", at: T0 + 500 }); // cmd-tab flick
  tracker.focus({ app: "Slack", at: T0 + 900 });
  assert.deepEqual(emitted, [], "flicking through apps is not attention");
});

test("idle closes BACKDATED by the reported idle time", () => {
  const { tracker } = makeTracker();
  tracker.focus({ app: "Cursor", at: T0 });
  // Ten minutes of real work: the poll confirms Cursor every few seconds right
  // up until input stops, which is what makes the backdated end an OBSERVED
  // moment rather than an unobserved gap.
  tracker.seen(T0 + 510_000);
  const closed = tracker.idle(T0 + 600_000, 90_000);
  assert.equal(closed.end_reason, "idle");
  assert.equal(
    new Date(closed.ended_at).getTime(),
    T0 + 600_000 - 90_000,
    "the idle period had already elapsed — crediting it is a systematic overcount"
  );
  assert.equal(closed.truncated, false, "a normal idle close is a measurement");
});

test("an interval that was idle for its whole length emits nothing", () => {
  // Backdating clamps to the start, so the span collapses to zero — and a
  // zero-length interval is exactly what it looks like: attention that never
  // happened. Emitting it anyway would put a phantom `opened X` in the log for
  // an app that was merely on screen while nobody was at the machine.
  const { tracker, emitted } = makeTracker();
  tracker.focus({ app: "Cursor", at: T0 });
  assert.equal(tracker.idle(T0 + 100_000, 500_000), null);
  assert.deepEqual(emitted, []);
});

test("a clean quit is NOT truncated; a crash is", () => {
  const clean = makeTracker();
  clean.tracker.focus({ app: "Cursor", at: T0 });
  clean.tracker.seen(T0 + 58_000); // the poll was still confirming when he quit
  const quit = clean.tracker.shutdown(T0 + 60_000);
  assert.equal(quit.end_reason, "shutdown");
  assert.equal(quit.truncated, false);
  assert.equal(new Date(quit.ended_at).getTime(), T0 + 60_000);

  // Now the same session, killed. The snapshot is all that survives.
  const crashed = makeTracker();
  crashed.tracker.focus({ app: "Cursor", at: T0 });
  crashed.tracker.seen(T0 + 30_000);
  const snapshot = JSON.parse(JSON.stringify(crashed.tracker.toJSON()));

  const next = makeTracker();
  next.tracker.load(snapshot);
  const salvaged = next.tracker.recoverOrphan();
  assert.equal(salvaged.end_reason, "truncated");
  assert.equal(salvaged.truncated, true);
  assert.equal(
    new Date(salvaged.ended_at).getTime(),
    T0 + 30_000,
    "closed at the last confirmed observation, NOT at the next launch"
  );
});

test("an overnight orphan cannot become a multi-hour span", () => {
  // The realistic disaster: the shell died at 18:00 with Cursor frontmost and
  // is launched at 09:00 the next day. `lastSeenAt` is the only honest anchor.
  const { tracker } = makeTracker();
  tracker.load({ app: "Cursor", title: null, startedAt: T0, lastSeenAt: T0 + 120_000 });
  const salvaged = tracker.recoverOrphan();
  const span = new Date(salvaged.ended_at).getTime() - new Date(salvaged.started_at).getTime();
  assert.equal(span, 120_000);
});

test("a span past the hard cap falls back to the last observation, then clamps", () => {
  // Observation stopped at +7h (the machine was suspended without telling us)
  // and the close lands at +9h. Neither number is attention, so the close
  // prefers what we can prove and then hard-clamps what is left.
  const seen = makeTracker();
  seen.tracker.load({
    app: "Cursor", title: null, startedAt: T0, lastSeenAt: T0 + 7 * 60 * 60 * 1000,
  });
  const clamped = seen.tracker.suspend(T0 + 9 * 60 * 60 * 1000);
  assert.equal(
    new Date(clamped.ended_at).getTime() - T0,
    MAX_INTERVAL_MS,
    "nine hours of sleep must not be credited as nine hours of attention"
  );
  assert.equal(clamped.truncated, true, "a clamped span must say it is a floor");

  // And when there is no observation past the start at all, there is nothing to
  // report — dropping beats inventing a six-hour session out of a suspend.
  const blind = makeTracker();
  blind.tracker.load({ app: "Cursor", title: null, startedAt: T0, lastSeenAt: T0 });
  assert.equal(blind.tracker.suspend(T0 + 9 * 60 * 60 * 1000), null);
  assert.deepEqual(blind.emitted, []);
});

test("suspend and lock close with a real end time", () => {
  for (const [method, reason] of [["suspend", "suspended"], ["lock", "locked"]]) {
    const { tracker } = makeTracker();
    tracker.focus({ app: "Cursor", at: T0 });
    tracker.seen(T0 + 44_000); // observation was current when the event landed
    const closed = tracker[method](T0 + 45_000);
    assert.equal(closed.end_reason, reason);
    assert.equal(closed.truncated, false);
    assert.equal(new Date(closed.ended_at).getTime(), T0 + 45_000);
  }
});

/**
 * The hole the 6h cap could never catch: the frontmost query fails (System
 * Events wedged, or Accessibility revoked mid-session), so `lastSeenAt` stops
 * advancing while the interval keeps accruing. A close arriving after that gap
 * used to emit the whole unobserved stretch as a CLEAN measurement — the same
 * class of lie the salvage path exists to prevent, through a different door.
 */
test("an unobserved stretch closes at the last confirmed moment and says so", () => {
  const { tracker } = makeTracker({ observationGapMs: 20_000 });
  tracker.focus({ app: "Cursor", at: T0 });
  tracker.seen(T0 + 60_000); // 09:01 — the last query that answered

  // Two hours of Chrome later, the query recovers.
  const closed = tracker.focus({ app: "Google Chrome", at: T0 + 2 * 60 * 60 * 1000 });
  assert.equal(closed.app, "Cursor");
  assert.equal(
    new Date(closed.ended_at).getTime(),
    T0 + 60_000,
    "two blind hours must not be credited to whatever was frontmost when it broke"
  );
  assert.equal(closed.truncated, true, "and the row has to say it is a floor");
});

test("`unobserved` closes an interval the sensor can no longer see", () => {
  const { tracker } = makeTracker({ observationGapMs: 20_000 });
  tracker.focus({ app: "Cursor", at: T0 });
  tracker.seen(T0 + 30_000);

  const closed = tracker.unobserved();
  assert.equal(closed.end_reason, "unobserved");
  assert.equal(closed.truncated, true);
  assert.equal(new Date(closed.ended_at).getTime(), T0 + 30_000);
  assert.equal(tracker.toJSON(), null, "and nothing is left to salvage twice");
});

test("the clamp is DOWNWARD only — an end inside the tolerance is untouched", () => {
  const { tracker } = makeTracker({ observationGapMs: 20_000 });
  tracker.focus({ app: "Cursor", at: T0 });
  tracker.seen(T0 + 40_000);
  // A close BEFORE the last observation (idle backdating does this) must keep
  // its own earlier end rather than being pulled forward to `lastSeenAt`.
  const closed = tracker.idle(T0 + 40_000, 10_000);
  assert.equal(new Date(closed.ended_at).getTime(), T0 + 30_000);
  assert.equal(closed.truncated, false);
});

test("discard drops the open interval without emitting", () => {
  const { tracker, emitted } = makeTracker();
  tracker.focus({ app: "Cursor", at: T0 });
  tracker.discard();
  assert.equal(tracker.toJSON(), null);
  assert.deepEqual(emitted, []);
});
