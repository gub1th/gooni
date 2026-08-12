/**
 * The log carries the day's events that have ALREADY HAPPENED; the notch
 * carries the one that hasn't yet. That split is the whole answer to the
 * captain's two complaints — a dot that said nothing, and the same event
 * reported twice with the useless copy buried in a list — so it is pinned as
 * one invariant across BOTH modules rather than as two independent filters that
 * can drift into overlapping or into a gap.
 */
import { expect, test } from "vitest";
import type { CalendarEvent } from "../../services/api";
import { loggedEvents } from "./LogSheet";
import { pickUpNext } from "./upNext";

const NOW = new Date("2026-08-12T18:00:00Z").getTime();

function ev(over: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return { summary: "standup", start: null, end: null, all_day: false, ...over };
}

function inMins(m: number): string {
  return new Date(NOW + m * 60_000).toISOString();
}

test("a started event is the log's; an upcoming one is not", () => {
  const started = ev({ id: "done", summary: "morning sync", start: inMins(-120) });
  const upcoming = ev({ id: "soon", summary: "dentist", start: inMins(180) });

  expect(loggedEvents([started, upcoming], NOW).map((e) => e.id)).toEqual(["done"]);
});

test("an event lands in exactly ONE surface — no duplicate, no gap", () => {
  // the captain's day: one event this morning, one this afternoon
  const events = [
    ev({ id: "past", summary: "morning sync", start: inMins(-120) }),
    ev({ id: "future", summary: "2pm thing", start: inMins(180) }),
  ];

  const inLog = new Set(loggedEvents(events, NOW).map((e) => e.id));
  const inNotch = pickUpNext(events, NOW)?.id;

  expect(inLog.has("past")).toBe(true);
  expect(inLog.has("future")).toBe(false);
  expect(inNotch).toBe("future");
});

test("all-day events stay in the log FOREVER — the notch refuses them, so it is their only surface", () => {
  const allDay = ev({ id: "offsite", summary: "offsite", start: "2026-08-12", all_day: true });

  expect(loggedEvents([allDay], NOW).map((e) => e.id)).toEqual(["offsite"]);
  // and the notch still will not take it — dropping it here would take it off
  // the app entirely
  expect(pickUpNext([allDay], NOW)).toBeNull();
});

test("a row we cannot place is kept, not silently discarded", () => {
  const broken = ev({ id: "junk", start: "not a date" });
  const dateless = ev({ id: "none" });

  expect(loggedEvents([broken, dateless], NOW).map((e) => e.id)).toEqual(["junk", "none"]);
});

test("an event crossing its start time moves from the notch to the log", () => {
  const events = [ev({ id: "a", summary: "standup", start: inMins(10) })];

  expect(pickUpNext(events, NOW)?.id).toBe("a");
  expect(loggedEvents(events, NOW)).toEqual([]);

  const later = NOW + 11 * 60_000;
  expect(pickUpNext(events, later)).toBeNull();
  expect(loggedEvents(events, later).map((e) => e.id)).toEqual(["a"]);
});
