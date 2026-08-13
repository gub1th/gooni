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
  clean.tracker.seen(T0 + 30_000);
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
    const closed = tracker[method](T0 + 45_000);
    assert.equal(closed.end_reason, reason);
    assert.equal(closed.truncated, false);
    assert.equal(new Date(closed.ended_at).getTime(), T0 + 45_000);
  }
});

test("discard drops the open interval without emitting", () => {
  const { tracker, emitted } = makeTracker();
  tracker.focus({ app: "Cursor", at: T0 });
  tracker.discard();
  assert.equal(tracker.toJSON(), null);
  assert.deepEqual(emitted, []);
});
