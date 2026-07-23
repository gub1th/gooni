// Notch merge — the one piece of real logic on the kiosk. The plan forbids
// syncing Google Calendar into SQLite (two-way sync is a tar pit), so the notch
// reads BOTH sources and merges at DISPLAY time:
//
//   1. calendar events + dated reminders  → one time-ordered list
//   2. promises                            → appended, by age (oldest first)
//
// Capped at a few lines — "anything longer means the day is overbooked, which
// is itself the signal." Pure + deterministic so it's unit-testable.

import type { CalendarEvent, FocusReminder } from "../../services/api";

export interface NotchItem {
  key: string;
  kind: "event" | "reminder" | "promise";
  label: string;
  // Right-aligned meta: a clock time, a weekday, or a promise age.
  right: string;
  // Promises read as a lower-contrast "at-risk" tier, distinct from what's
  // scheduled today.
  dim: boolean;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ISO/date → local "h:mm" (e.g. "6:30"). Null-safe.
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h}:${m.toString().padStart(2, "0")}`;
}

// ISO/date → local weekday abbrev (all-day events show a day, not a time).
export function fmtWeekday(iso: string | null | undefined): string {
  if (!iso) return "";
  // All-day starts arrive as "YYYY-MM-DD" (no time) — parse as local noon so a
  // UTC-midnight parse can't roll the date backward across the timezone.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return WEEKDAYS[d.getDay()];
}

// Millis for time-ordering. All-day events sort by their day start; undated
// reminders sink below everything dated (but still ahead of promises).
function sortMs(iso: string | null | undefined): number {
  if (!iso) return Number.MAX_SAFE_INTEGER;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
  const t = d.getTime();
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

// Promise age descriptor: "owed to Yash · 6d", or just "6d" when self-owed.
export function fmtPromiseMeta(owedTo: string | null, ageDays: number): string {
  const age = `${Math.max(0, ageDays)}d`;
  return owedTo ? `owed to ${owedTo} · ${age}` : age;
}

export function buildNotchItems(
  events: CalendarEvent[],
  reminders: FocusReminder[],
  promises: FocusReminder[],
  cap = 4,
): NotchItem[] {
  const timed: { item: NotchItem; ms: number }[] = [];

  for (const e of events) {
    timed.push({
      item: {
        key: `event:${e.id}`,
        kind: "event",
        label: e.summary || "(untitled)",
        right: e.all_day ? fmtWeekday(e.start) : fmtTime(e.start),
        dim: false,
      },
      ms: sortMs(e.start),
    });
  }

  for (const r of reminders) {
    timed.push({
      item: {
        key: `reminder:${r.id}`,
        kind: "reminder",
        label: r.content,
        right: fmtTime(r.due_at),
        dim: false,
      },
      ms: sortMs(r.due_at),
    });
  }

  timed.sort((a, b) => a.ms - b.ms);

  // Promises already arrive age-desc (oldest first) from the backend; keep it.
  const promiseItems: NotchItem[] = promises.map((p) => ({
    key: `promise:${p.id}`,
    kind: "promise",
    label: p.content,
    right: fmtPromiseMeta(p.owed_to, p.age_days),
    dim: true,
  }));

  return [...timed.map((t) => t.item), ...promiseItems].slice(0, cap);
}
