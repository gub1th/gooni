import type { CalendarEvent } from "../../services/api";

// THE HORIZON GRADES EMPHASIS. IT NO LONGER GATES VISIBILITY.
//
// Pass 10 made the horizon a visibility gate, on the reasoning that an UP NEXT
// which is always visible is a status bar and a status bar stops being read.
// That reasoning was half right, and using it the captain found the other half:
// a 2:00pm event lit the log button's dot at 11am while the notch stayed on
// search, because 2:51 away is outside the horizon. Two signals, neither of
// which said what was coming. A dot is the least useful form of a notification —
// it says something exists without saying what, and you cannot decode it without
// going somewhere else.
//
// So the answer is not "hide it until it is urgent", it is "say what it is, all
// day, and let how loudly you say it carry the urgency". The horizon survives as
// the line between those two volumes:
//
//   far  — outside it. Present but quiet: a calm fact, not a demand.
//   near — inside it. Prominent, which is how it has always rendered.
//
// 90 minutes: long enough to catch the thing you should already be wrapping up
// for, short enough that the loud state means something is actually about to
// happen.
export const UP_NEXT_HORIZON_MS = 90 * 60 * 1000;

/** How loudly the notch should say it — the horizon's one remaining job. */
export type UpNextEmphasis = "near" | "far";

export interface UpNext {
  id: string;
  title: string;
  /** local clock time, e.g. `2:30 PM` */
  at: string;
  /** how long until it starts, e.g. `in 1h 20m` */
  inLabel: string;
  startsInMs: number;
  emphasis: UpNextEmphasis;
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
 * The next event, or null — with the emphasis it has earned.
 *
 * Deliberate exclusions, all of which SURVIVED the horizon's demotion because
 * none of them was ever about urgency:
 *  - ALL-DAY events. They have no start time to count down to, so "in 1h 20m"
 *    would be invented; a day-long event is context, not an imminent one. (They
 *    keep their surface in the log sheet, which is the only place they have.)
 *  - Events already IN PROGRESS. "up next" and "how long until it" are one
 *    claim, and a meeting you are late for is not next. It stays out rather
 *    than silently showing a negative or clamped countdown.
 *
 * What is NOT excluded any more is distance. The candidate list is one day's
 * events, so the worst case is bounded by the end of the day rather than
 * reaching arbitrarily far into next week.
 */
export function pickUpNext(events: CalendarEvent[], now: number): UpNext | null {
  let best: UpNext | null = null;
  for (const ev of events) {
    if (ev.all_day || !ev.start) continue;
    const startsAt = new Date(ev.start).getTime();
    if (Number.isNaN(startsAt)) continue;
    const startsInMs = startsAt - now;
    if (startsInMs <= 0) continue;
    if (best && best.startsInMs <= startsInMs) continue;
    best = {
      id: ev.id,
      title: ev.summary || "(untitled)",
      at: clockLabel(new Date(startsAt)),
      inLabel: untilLabel(startsInMs),
      startsInMs,
      emphasis: startsInMs <= UP_NEXT_HORIZON_MS ? "near" : "far",
    };
  }
  return best;
}
