import type { CalendarEvent } from "../../services/api";

// THE HORIZON IS THE WHOLE DESIGN.
//
// An UP NEXT that is always visible is a status bar, and a status bar stops
// being read — "in 13h 23m" is not news, it is furniture, which is exactly why
// the grindstone line was deleted. This is the line between a signal and
// decoration, so it is one named constant rather than a number sprinkled
// through the render.
//
// 90 minutes: long enough to catch the thing you should already be wrapping up
// for, short enough that seeing it means something is actually about to happen.
export const UP_NEXT_HORIZON_MS = 90 * 60 * 1000;

export interface UpNext {
  id: string;
  title: string;
  /** local clock time, e.g. `2:30 PM` */
  at: string;
  /** how long until it starts, e.g. `in 1h 20m` */
  inLabel: string;
  startsInMs: number;
}

function clockLabel(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** `in 45m` / `in 1h 20m` / `in 1m` — never `in 0m`, which reads as "gone". */
function untilLabel(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
}

/**
 * The next event worth interrupting for, or null.
 *
 * Deliberate exclusions:
 *  - ALL-DAY events. They have no start time to count down to, so "in 1h 20m"
 *    would be invented; a day-long event is context, not an imminent one.
 *  - Events already IN PROGRESS. "up next" and "how long until it" are one
 *    claim, and a meeting you are late for is not next. It stays out rather
 *    than silently showing a negative or clamped countdown.
 *  - Anything beyond `UP_NEXT_HORIZON_MS` — see the constant.
 */
export function pickUpNext(events: CalendarEvent[], now: number): UpNext | null {
  let best: UpNext | null = null;
  for (const ev of events) {
    if (ev.all_day || !ev.start) continue;
    const startsAt = new Date(ev.start).getTime();
    if (Number.isNaN(startsAt)) continue;
    const startsInMs = startsAt - now;
    if (startsInMs <= 0 || startsInMs > UP_NEXT_HORIZON_MS) continue;
    if (best && best.startsInMs <= startsInMs) continue;
    best = {
      id: ev.id,
      title: ev.summary || "(untitled)",
      at: clockLabel(new Date(startsAt)),
      inLabel: untilLabel(startsInMs),
      startsInMs,
    };
  }
  return best;
}
