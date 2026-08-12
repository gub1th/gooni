/**
 * The HORIZON is pass 10's whole design, so it is the thing under test.
 *
 * An UP NEXT that is always visible is a status bar, and a status bar stops
 * being read — the same failure that got the grindstone line deleted. These
 * pin the four ways a candidate is rejected, because every one of them is a
 * way the notch could quietly become furniture again.
 */
import { expect, test } from "vitest";
import type { CalendarEvent } from "../../services/api";
import { pickUpNext, UP_NEXT_HORIZON_MS } from "./upNext";

const NOW = new Date("2026-08-12T14:00:00Z").getTime();

function ev(over: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    summary: "standup",
    start: null,
    end: null,
    all_day: false,
    ...over,
  };
}

function inMins(m: number): string {
  return new Date(NOW + m * 60_000).toISOString();
}

test("an event inside the horizon is the payload, with both labels", () => {
  const hit = pickUpNext([ev({ id: "a", summary: "design review", start: inMins(80) })], NOW);

  expect(hit?.title).toBe("design review");
  expect(hit?.inLabel).toBe("in 1h 20m");
  // the clock time is local, so it is derived rather than written out — the
  // same local-vs-UTC trap the promise due labels have
  expect(hit?.at).toBe(new Date(NOW + 80 * 60_000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
});

test("beyond the horizon there is nothing — that is the whole point", () => {
  const justOutside = UP_NEXT_HORIZON_MS / 60_000 + 1;
  expect(pickUpNext([ev({ id: "a", start: inMins(justOutside) })], NOW)).toBeNull();
  // the captain's "in 13h 23m" case, which is not news
  expect(pickUpNext([ev({ id: "a", start: inMins(13 * 60 + 23) })], NOW)).toBeNull();
});

test("all-day events never qualify — there is no time to count down to", () => {
  expect(
    pickUpNext([ev({ id: "a", summary: "offsite", start: "2026-08-12", all_day: true })], NOW),
  ).toBeNull();
});

test("an event already under way is not NEXT", () => {
  expect(pickUpNext([ev({ id: "a", start: inMins(-5) })], NOW)).toBeNull();
});

test("the soonest qualifying event wins, whatever order they arrive in", () => {
  const hit = pickUpNext(
    [
      ev({ id: "far", summary: "later thing", start: inMins(70) }),
      ev({ id: "near", summary: "sooner thing", start: inMins(10) }),
      ev({ id: "past", summary: "gone", start: inMins(-30) }),
    ],
    NOW,
  );
  expect(hit?.title).toBe("sooner thing");
  expect(hit?.inLabel).toBe("in 10m");
});

test("a countdown never reads `in 0m`, which would say it had gone", () => {
  const hit = pickUpNext([ev({ id: "a", start: new Date(NOW + 20_000).toISOString() })], NOW);
  expect(hit?.inLabel).toBe("in 1m");
});

test("an unparseable or missing start is skipped, not crashed on", () => {
  expect(pickUpNext([ev({ id: "a", start: "not a date" }), ev({ id: "b" })], NOW)).toBeNull();
});
