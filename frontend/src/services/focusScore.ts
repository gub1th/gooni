// Pure helpers behind the recap's charts.
//
// The score itself is server-computed (`focus_session_activity`, #526) — it
// classifies every second of the session from camera presence, camera events
// and device intervals, which a client-side fold over the timer + detection
// counts can't reconstruct (it doesn't see continuous camera presence, only
// discrete events). So this file does NOT compute a score; it only buckets
// one for display.

export type ScoreTier = "good" | "ok" | "low";

/** Buckets a 0–100 score into a ring/legend colour tier. Pure paint over a
 *  real number — the score itself always comes from the server. */
export function scoreTier(score: number): ScoreTier {
  if (score >= 75) return "good";
  if (score >= 45) return "ok";
  return "low";
}

/** One fraction (0..1) of focused time per bucket across the span — the
 *  "focus over time" chart's data. Pure so the binning is testable without a
 *  canvas. A bucket with zero span coverage is 0, never `null` — there is no
 *  missing-data case here, only "no focused segment overlapped". Callers feed
 *  it either the real sensor timeline's `focused` spans or, for a session
 *  with no sensor timeline, the client's own closed focus runs — same fold
 *  either way. */
export function focusFractionSeries(
  spanStart: number,
  spanEnd: number,
  segments: Array<{ start: number; end: number }>,
  buckets = 24,
): number[] {
  const span = spanEnd - spanStart;
  if (span <= 0 || buckets <= 0) return [];
  const bucketMs = span / buckets;
  const out: number[] = new Array(buckets).fill(0);
  for (let i = 0; i < buckets; i++) {
    const bStart = spanStart + i * bucketMs;
    const bEnd = bStart + bucketMs;
    let covered = 0;
    for (const seg of segments) {
      const overlap = Math.min(seg.end, bEnd) - Math.max(seg.start, bStart);
      if (overlap > 0) covered += overlap;
    }
    out[i] = Math.max(0, Math.min(1, covered / bucketMs));
  }
  return out;
}
