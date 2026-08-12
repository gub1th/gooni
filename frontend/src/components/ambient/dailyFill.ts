// The daily fill's dismissed-for-today flag.
//
// Logging the day's trackables is a RITUAL, not a destination — so it appears in
// TODAY as a task row rather than waiting behind a rail entry you have to
// remember to visit. Like any task it can be put away once it is done with, and
// like the day itself that only lasts until tomorrow.
//
// Deliberately NOT a trackable entry or a promise: dismissing the row says "I am
// finished logging for today", which is not the same claim as "every trackable
// has a value" and must not be written into the record the matrix reads. The
// fill writes entries; this only remembers whether to keep offering.
//
// Keyed by LOCAL day for the same reason every other day-bounded thing on this
// surface is: the home polls and is never reloaded, so a UTC key would clear the
// row hours early or late depending on the season.

const KEY = "gooni_daily_fill_dismissed";

/** `2026-08-12` in the viewer's own timezone. */
export function localDayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isFillDismissed(now: Date = new Date()): boolean {
  try {
    return localStorage.getItem(KEY) === localDayKey(now);
  } catch {
    return false; // private mode — better to keep offering than to hide it
  }
}

export function dismissFill(now: Date = new Date()): void {
  try {
    localStorage.setItem(KEY, localDayKey(now));
  } catch {
    /* private mode — it still holds in memory for this sitting */
  }
}
