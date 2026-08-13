/**
 * The log carries the day's events that have ALREADY HAPPENED; the notch
 * carries the one that hasn't yet. That split is the whole answer to the
 * captain's two complaints — a dot that said nothing, and the same event
 * reported twice with the useless copy buried in a list — so it is pinned as
 * one invariant across BOTH modules rather than as two independent filters that
 * can drift into overlapping or into a gap.
 */
import { expect, test } from "vitest";
import type { ActivityItem, CalendarEvent } from "../../services/api";
import { labelFor, loggedEvents, mergeNewest } from "./LogSheet";
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

/**
 * Device rows: three sensors, one row.
 *
 * The phone's iOS Shortcuts pings ride in as a `trackable` with source
 * `shortcuts` (each ping really is a +1 on a real Trackable). The browser and
 * the Mac ride in as `device`, derived from raw attention intervals with no
 * Trackable behind them — high-cardinality names would have minted hundreds and
 * flooded the log matrix. That difference is storage, and the captain's ask was
 * explicitly that it not be visible: "opened hinge" from the phone and "opened
 * cursor" from the Mac are the same fact about the day.
 */
test("every device layer renders as the same amber `device` row", () => {
  const phone = labelFor({
    key: "trackable-1", kind: "trackable", at: "", text: "opened instagram",
    source: "shortcuts", name: "instagram open",
  });
  const browser = labelFor({
    key: "device-browser-1", kind: "device", at: "", text: "opened leetcode",
    source: "browser", name: "leetcode.com",
  });
  const desktop = labelFor({
    key: "device-app-1", kind: "device", at: "", text: "opened cursor",
    source: "app", name: "cursor",
  });

  expect(phone.label).toBe("device");
  expect(browser).toEqual(phone);
  expect(desktop).toEqual(phone);
});

/**
 * A device run's key is STABLE on purpose — it anchors at the run's first open
 * — so the poll re-fetches the same key with a bigger count all day. The sheet
 * never remounts, so a dedup that discarded the re-fetched copy froze the row.
 */
test("a re-fetched row updates in place; the key dedup still stops duplicates", () => {
  const row = (over: Partial<ActivityItem> & { key: string; at: string }): ActivityItem =>
    ({ kind: "device", text: "opened cursor", ...over }) as ActivityItem;

  const seen = new Set<string>();
  const first = mergeNewest([], [row({ key: "device-app-7", at: "2026-08-12T09:00:00Z" })], seen);
  expect(first.map((r) => r.text)).toEqual(["opened cursor"]);

  // …the run grows through the day. Same key, same anchor, bigger count.
  const grown = mergeNewest(
    first,
    [row({ key: "device-app-7", at: "2026-08-12T09:00:00Z", text: "opened cursor ×8" })],
    seen,
  );
  expect(grown.map((r) => r.text)).toEqual(["opened cursor ×8"]);
  expect(grown).toHaveLength(1);

  // An unchanged re-fetch is a no-op, and returns the SAME array so React
  // doesn't re-render the sheet every 20 seconds for nothing.
  const again = mergeNewest(grown, [row({ key: "device-app-7", at: "2026-08-12T09:00:00Z", text: "opened cursor ×8" })], seen);
  expect(again).toBe(grown);

  // A genuinely new row still lands, newest first.
  const withNew = mergeNewest(
    grown,
    [row({ key: "device-app-9", at: "2026-08-12T11:00:00Z", text: "opened slack" })],
    seen,
  );
  expect(withNew.map((r) => r.key)).toEqual(["device-app-9", "device-app-7"]);
});

test("a device row is not mistaken for a logged measurement", () => {
  // `logged` (accent green) is a real measurement Daniel entered. A device row
  // is telemetry — same feed, different claim, and the colours have to say so.
  const logged = labelFor({
    key: "trackable-2", kind: "trackable", at: "", text: "weight 178",
    source: "manual", name: "weight",
  });
  expect(logged.label).toBe("logged");
  expect(logged.color).not.toBe(labelFor({
    key: "device-app-2", kind: "device", at: "", text: "opened slack",
  }).color);
});
