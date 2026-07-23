import { describe, it, expect } from "vitest";
import { buildNotchItems, fmtPromiseMeta } from "./notchMerge";
import type { CalendarEvent, FocusReminder } from "../../services/api";

function evt(partial: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "e",
    summary: "event",
    start: null,
    end: null,
    all_day: false,
    ...partial,
  };
}

function reminder(partial: Partial<FocusReminder>): FocusReminder {
  return {
    id: 1,
    type: "reminder",
    content: "r",
    owed_to: null,
    due_at: null,
    done: false,
    age_days: 0,
    thought_id: null,
    ...partial,
  };
}

describe("buildNotchItems", () => {
  it("interleaves calendar events + dated reminders by time, then promises by age", () => {
    const events = [
      evt({ id: "dinner", summary: "Dinner", start: "2026-07-23T18:30:00", all_day: false }),
      evt({ id: "am", summary: "Standup", start: "2026-07-23T09:00:00", all_day: false }),
    ];
    const reminders = [
      reminder({ id: 10, type: "reminder", content: "Call bank", due_at: "2026-07-23T12:00:00" }),
    ];
    const promises = [
      reminder({ id: 20, type: "promise", content: "No smoking", owed_to: null, age_days: 0 }),
      reminder({ id: 21, type: "promise", content: "Ship PR", owed_to: "Yash", age_days: 6 }),
    ];

    const out = buildNotchItems(events, reminders, promises, 10);
    // dated block sorted ascending by time: 9:00 standup, 12:00 call, 18:30 dinner
    expect(out.slice(0, 3).map((i) => i.label)).toEqual(["Standup", "Call bank", "Dinner"]);
    // then promises, in the order given (backend already age-desc)
    expect(out.slice(3).map((i) => i.label)).toEqual(["No smoking", "Ship PR"]);
    // promises render dim; scheduled items do not
    expect(out[0].dim).toBe(false);
    expect(out[3].dim).toBe(true);
  });

  it("formats timed events as h:mm and all-day events as a weekday", () => {
    const events = [
      evt({ id: "t", summary: "Timed", start: "2026-07-23T06:30:00", all_day: false }),
      evt({ id: "a", summary: "AllDay", start: "2026-07-20", all_day: true }), // a Monday
    ];
    const out = buildNotchItems(events, [], [], 10);
    const timed = out.find((i) => i.label === "Timed")!;
    const allday = out.find((i) => i.label === "AllDay")!;
    expect(timed.right).toBe("6:30");
    expect(allday.right).toBe("Mon");
  });

  it("caps the notch line count", () => {
    const promises = Array.from({ length: 8 }, (_, i) =>
      reminder({ id: 100 + i, type: "promise", content: `p${i}`, age_days: i }),
    );
    expect(buildNotchItems([], [], promises, 4)).toHaveLength(4);
  });

  it("drops the 'owed to' prefix for self-owed promises", () => {
    expect(fmtPromiseMeta(null, 3)).toBe("3d");
    expect(fmtPromiseMeta("Yash", 6)).toBe("owed to Yash · 6d");
  });
});
