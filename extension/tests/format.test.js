/**
 * Popup display formatting.
 *
 * The durations are the whole point of the popup, and three of the rules here
 * are honesty rules rather than styling: a rounded percent must never print 0%
 * for a host that holds real time, a salvaged interval must be labelled as a
 * floor, and unsent intervals must be named so a low total isn't read as a
 * quiet day.
 *
 * Run: cd extension && npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  barPercent,
  dayLabel,
  formatDuration,
  formatHeadline,
  formatPercent,
  formatSessions,
  pendingNote,
  truncatedNote,
} from "../src/format.js";

test("clock-form durations match the shapes in the ranked list", () => {
  assert.equal(formatDuration(4390), "1:13:10"); // the captain's leetcode row
  assert.equal(formatDuration(1718), "28:38"); // hellointerview
  assert.equal(formatDuration(7), "0:07");
  assert.equal(formatDuration(60), "1:00");
  assert.equal(formatDuration(3600), "1:00:00");
});

test("a multi-hour total carries hours, minutes and seconds", () => {
  // 2h 0m 30s — the zero minutes stay: "2h 30s" reads as two and a half hours.
  assert.equal(formatHeadline(7230), "2h 0m 30s");
  assert.equal(formatDuration(7230), "2:00:30");
  // a full working day, well past any single interval the sensor will accept
  assert.equal(formatDuration(8 * 3600 + 7 * 60 + 5), "8:07:05");
  assert.equal(formatHeadline(312), "5m 12s");
  assert.equal(formatHeadline(42), "42s");
  assert.equal(formatHeadline(0), "0s");
});

test("a span crossing midnight formats as one duration, not two days", () => {
  // The server attributes a midnight-crossing interval wholly to its start day
  // (see tests/test_browser_summary.py). The popup's job is to render that
  // single number as a duration — 23:50 → 00:10 is 20 minutes, not "1 day".
  const started = Date.parse("2026-08-08T23:50:00");
  const ended = Date.parse("2026-08-09T00:10:00");
  assert.equal(formatDuration((ended - started) / 1000), "20:00");
  // and a long one that survives midnight still reads in hours
  const long = (Date.parse("2026-08-09T01:30:00") - started) / 1000;
  assert.equal(formatDuration(long), "1:40:00");
  assert.equal(formatHeadline(long), "1h 40m 0s");
});

test("durations floor rather than round, so parts can't exceed the whole", () => {
  assert.equal(formatDuration(59.9), "0:59");
  assert.equal(formatHeadline(59.9), "59s");
  assert.equal(formatDuration(-5), "0:00");
  assert.equal(formatDuration(null), "0:00");
  assert.equal(formatDuration("90"), "1:30");
});

test("session counts pluralise", () => {
  assert.equal(formatSessions(40), "40 sessions");
  assert.equal(formatSessions(1), "1 session");
  assert.equal(formatSessions(0), "0 sessions");
});

test("a host with real time never renders as 0%", () => {
  assert.equal(formatPercent(4390, 7200), "61%");
  assert.equal(formatPercent(1718, 7200), "24%");
  // 3 seconds out of two hours is real attention; "0%" next to "0:03" reads as
  // a rendering bug rather than a small number.
  assert.equal(formatPercent(3, 7200), "<1%");
  assert.equal(formatPercent(0, 7200), "0%");
  assert.equal(formatPercent(10, 0), "0%");
});

test("bar geometry is clamped and unrounded", () => {
  assert.equal(barPercent(50, 100), 50);
  assert.equal(barPercent(3, 7200).toFixed(4), "0.0417");
  assert.equal(barPercent(200, 100), 100);
  assert.equal(barPercent(5, 0), 0);
});

test("day labels are parsed in local time, not UTC", () => {
  // new Date("2026-08-08") is UTC midnight, which renders as Aug 7 anywhere
  // west of Greenwich — the same off-by-a-day the server-side local bucketing
  // exists to avoid, reintroduced at the last step.
  const label = dayLabel("2026-08-08", { today: "2026-08-09T12:00:00" });
  assert.equal(label, new Date(2026, 7, 8, 12).toLocaleDateString(undefined, { weekday: "short" }));
  assert.equal(dayLabel("2026-08-09", { today: "2026-08-09T12:00:00" }), "today");
  assert.equal(dayLabel("nonsense"), "nonsense");
});

test("salvaged intervals are counted and labelled as a floor", () => {
  assert.equal(truncatedNote({ truncated_sessions: 0, truncated_sec: 0 }), null);
  const note = truncatedNote({ truncated_sessions: 2, truncated_sec: 300 });
  assert.match(note, /2 salvaged intervals \(5:00\)/);
  assert.match(note, /floor, not a measurement/);
  assert.match(truncatedNote({ truncated_sessions: 1, truncated_sec: 61 }), /1 salvaged interval \(1:01\)/);
});

test("unsent intervals are named, so a low total isn't read as a quiet day", () => {
  assert.equal(pendingNote({ buffered: 0 }), null);
  assert.equal(pendingNote(null), null);
  assert.match(pendingNote({ buffered: 7, hasToken: true }), /7 intervals not yet sent/);
  assert.match(pendingNote({ buffered: 1, hasToken: true }), /1 interval not yet sent/);
  assert.match(pendingNote({ buffered: 3, hasToken: false }), /no token saved/);
});
