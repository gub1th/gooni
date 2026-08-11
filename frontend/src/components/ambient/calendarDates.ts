import type { CalendarEvent } from "../../services/api";

// Small local-timezone date helpers for the calendar widget. The browser's
// local tz is the source of truth for what "day" an event falls on — matches
// how a person reads their own calendar. All-day events carry a bare
// YYYY-MM-DD `date` (no tz), so we slice the string rather than `new Date()`
// it (which would parse as UTC midnight and drift a day in negative offsets).

/** Monday-anchored start of the week containing `d`, at local midnight. */
export function startOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const dow = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - dow);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Local YYYY-MM-DD key for a Date. */
export function dayKeyLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

/** Which day column an event belongs in (local YYYY-MM-DD). */
export function eventDayKey(ev: CalendarEvent): string {
  if (!ev.start) return "";
  if (ev.all_day) return ev.start.slice(0, 10);
  return dayKeyLocal(new Date(ev.start));
}

export function fmtTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function fmtDayLabel(d: Date): string {
  return d.toLocaleDateString([], { weekday: "short" });
}

export function fmtRange(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  return `${start.toLocaleDateString([], opts)} – ${end.toLocaleDateString([], opts)}`;
}

/** Build an RFC3339 instant from a local YYYY-MM-DD + HH:MM. toISOString()
 *  yields UTC (…Z) which is valid RFC3339; Google stores it correctly. */
export function localToIso(dayKey: string, time: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm).toISOString();
}

/** Sort key: all-day first, then by start instant. */
export function eventSortKey(ev: CalendarEvent): number {
  if (ev.all_day) return -1;
  return ev.start ? new Date(ev.start).getTime() : 0;
}
