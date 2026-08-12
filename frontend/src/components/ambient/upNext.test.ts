/**
 * The HORIZON is still the thing under test — but it now grades EMPHASIS rather
 * than gating visibility, so these tests moved with it.
 *
 * Pass 10 hid an event until it was within 90 minutes, which produced the
 * captain's case: a 2:00pm event lit a dot at 11am while the notch said nothing.
 * The failure the horizon was guarding against (an always-visible up-next
 * becomes furniture, the way the grindstone line did) is now guarded by VOLUME
 * instead — so the pins here are that distance changes emphasis and NOTHING
 * else, and that the three non-distance exclusions all survived the change.
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

test("an event inside the horizon is the payload, with both labels, NEAR", () => {
  const hit = pickUpNext([ev({ id: "a", summary: "design review", start: inMins(80) })], NOW);

  expect(hit?.title).toBe("design review");
  expect(hit?.inLabel).toBe("in 1h 20m");
  expect(hit?.emphasis).toBe("near");
  // the clock time is local, so it is derived rather than written out — the
  // same local-vs-UTC trap the promise due labels have
  expect(hit?.at).toBe(new Date(NOW + 80 * 60_000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
});

test("beyond the horizon it is still the payload — just FAR", () => {
  const justOutside = UP_NEXT_HORIZON_MS / 60_000 + 1;
  expect(pickUpNext([ev({ id: "a", start: inMins(justOutside) })], NOW)?.emphasis).toBe("far");

  // THE captain's case: a 2:00pm event seen at 11am. It used to be nothing, and
  // a dot elsewhere said "something exists" without saying what.
  const hit = pickUpNext([ev({ id: "a", summary: "dentist", start: inMins(180) })], NOW);
  expect(hit?.title).toBe("dentist");
  expect(hit?.inLabel).toBe("in 3h");
  expect(hit?.emphasis).toBe("far");
});

test("the horizon boundary itself is NEAR — a threshold reached is a threshold crossed", () => {
  const exactly = pickUpNext([ev({ id: "a", start: new Date(NOW + UP_NEXT_HORIZON_MS).toISOString() })], NOW);
  expect(exactly?.emphasis).toBe("near");
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

test("a NEAR event outranks a FAR one — soonest still wins, emphasis is not a sort key", () => {
  const hit = pickUpNext(
    [
      ev({ id: "far", summary: "dinner", start: inMins(300) }),
      ev({ id: "near", summary: "standup", start: inMins(20) }),
    ],
    NOW,
  );
  expect(hit?.title).toBe("standup");
  expect(hit?.emphasis).toBe("near");
});

test("a countdown never reads `in 0m`, which would say it had gone", () => {
  const hit = pickUpNext([ev({ id: "a", start: new Date(NOW + 20_000).toISOString() })], NOW);
  expect(hit?.inLabel).toBe("in 1m");
});

test("an unparseable or missing start is skipped, not crashed on", () => {
  expect(pickUpNext([ev({ id: "a", start: "not a date" }), ev({ id: "b" })], NOW)).toBeNull();
});
