/**
 * The options page's last-flush report.
 *
 * A rejected interval is acked and deleted from the buffer exactly like an
 * accepted one, so this panel is the only place that loss is ever visible.
 * These assert the rendered lines — the panel's text is the whole contract.
 *
 * Run: cd extension && npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { formatLastFlush } from "../src/status.js";

const at = "2026-08-08T17:00:00.000Z";
const render = (f) => formatLastFlush(f, { formatTime: () => "5:00:00 PM" }).join("\n");

test("a clean flush reports no loss", () => {
  const out = render({ at, sent: 12, accepted: 12, duplicates: 0, rejected: 0 });
  assert.match(out, /sent 12, accepted 12, duplicates 0, rejected 0/);
  assert.doesNotMatch(out, /⚠/, "a clean flush must not raise a warning");
  assert.equal(out.split("\n").length, 1);
});

test("a clock-skewed machine losing every row is legible, not a success line", () => {
  // The reachable no-bug case: a clock >5min fast makes the server reject every
  // row as `future`. Before this, the panel read "sent 200, accepted 0" with no
  // error and nothing else — permanent loss rendered as a healthy flush.
  const out = render({
    at,
    sent: 200,
    accepted: 0,
    duplicates: 0,
    rejected: 200,
    rejectedReason: "future",
  });

  assert.match(out, /rejected 200/, "the count is stated");
  assert.match(out, /⚠/, "an all-rejected batch is visually distinct");
  assert.match(out, /EVERY interval in that batch was REJECTED and discarded/);
  assert.match(out, /future/, "the reason is carried through");
  assert.match(out, /clock is ahead of the server/, "and translated into the actual fix");

  const clean = render({ at, sent: 200, accepted: 200, duplicates: 0, rejected: 0 });
  assert.notEqual(out, clean, "total loss must not render like a clean flush");
});

test("a partial rejection is flagged but not called a total loss", () => {
  const out = render({
    at,
    sent: 10,
    accepted: 7,
    duplicates: 1,
    rejected: 2,
    rejectedReason: "too_short",
  });
  assert.match(out, /⚠ 2 interval\(s\) were rejected and discarded \(too_short\)/);
  assert.doesNotMatch(out, /EVERY/);
});

test("rows that all landed as duplicates are a replay, not a loss", () => {
  // accepted 0 alone does NOT mean loss — a redelivered batch is the healthy
  // idempotency path and must not be dressed up as a catastrophe.
  const out = render({ at, sent: 5, accepted: 0, duplicates: 5, rejected: 0 });
  assert.doesNotMatch(out, /⚠/);
});

test("a rejection with an unrecognised reason still surfaces the count", () => {
  const out = render({ at, sent: 3, accepted: 0, duplicates: 0, rejected: 3, rejectedReason: "wat" });
  assert.match(out, /EVERY interval in that batch was REJECTED and discarded \(wat\)/);
});

test("a transport error is still reported alongside the counts", () => {
  const out = render({ at, sent: 4, accepted: 0, duplicates: 0, rejected: 0, error: "http_503" });
  assert.match(out, /error http_503/);
  assert.doesNotMatch(out, /⚠/, "a retained batch is not a loss");
});

test("a batch the server refused outright reads as destruction, not as an error code", () => {
  // 400/413/422 delete the batch from the buffer without it ever being stored.
  // Rendering that as a bare `error http_413` reads like something to retry,
  // when in fact the attention no longer exists anywhere.
  const out = render({
    at,
    sent: 40,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    dropped: 40,
    error: "http_413",
  });
  assert.match(out, /destroyed 40/, "the count is stated on the summary line");
  assert.match(out, /⚠/, "irreversible loss is visually distinct");
  assert.match(out, /40 interval\(s\) were DESTROYED/);
  assert.match(out, /can never be redelivered/);
  assert.match(out, /http_413/, "the status that caused it is carried through");

  const retained = render({ at, sent: 40, accepted: 0, duplicates: 0, rejected: 0, error: "http_503" });
  assert.notEqual(out, retained, "destruction must not render like a retained batch");
});

test("a flush with no destruction says nothing about it", () => {
  const out = render({ at, sent: 5, accepted: 5, duplicates: 0, rejected: 0, dropped: 0 });
  assert.doesNotMatch(out, /destroyed/i);
  assert.doesNotMatch(out, /⚠/);
});

test("no flush yet renders nothing rather than zeroes", () => {
  assert.deepEqual(formatLastFlush(null), []);
  assert.deepEqual(formatLastFlush(undefined), []);
});

test("a missing or unparseable timestamp does not produce 'Invalid Date'", () => {
  assert.match(formatLastFlush({ sent: 1, accepted: 1 }).join("\n"), /unknown time/);
  assert.match(formatLastFlush({ at: "not a date", sent: 1 }).join("\n"), /unknown time/);
});
