// Whoop tile freshness helpers — pure, deterministic, unit-tested.
//
// The tile used to show recovery / strain / sleep with NO age signal, so a
// strap that stopped syncing served ghost metrics: strain frozen at a stale
// open-cycle value, recovery/sleep null → "–". Indistinguishable from a
// genuinely bad recovery day. These helpers turn WHOOP's own record timestamp
// (`source_updated_at`, NOT our poll time) into a visible age + stale verdict.

import { parseServerDate } from "../../utils/date";

/** Past this age, WHOOP's own data is presumed dead, not merely bad. */
export const STALE_MS = 36 * 3600 * 1000;

// WHOOP timestamps come back as NAIVE UTC (no offset), which `new Date()` would
// read as LOCAL and silently shift bed/wake by the viewer's offset. That
// append-`Z`-only-when-there-is-no-offset rule has ONE owner: `parseServerDate`
// in utils/date.ts — see it for why appending unconditionally is wrong. This is
// just the epoch-ms wrapper the helpers below consume.
export function parseUtc(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const s = iso.trim();
  if (!s) return null;
  return parseServerDate(s)?.getTime() ?? null;
}

/** "11:20p" in the VIEWER's local timezone, or null if unparseable. */
export function clock(iso: string | null | undefined): string | null {
  const t = parseUtc(iso);
  if (t == null) return null;
  const d = new Date(t);
  const h24 = d.getHours();
  const ap = h24 < 12 ? "a" : "p";
  const h = h24 % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")}${ap}`;
}

/** "11:20p → 7:05a", or null unless BOTH ends are known. */
export function sleepClock(
  start: string | null | undefined,
  end: string | null | undefined,
): string | null {
  const a = clock(start);
  const b = clock(end);
  return a && b ? `${a} → ${b}` : null;
}

// Coarse relative age. Clamped at 0 so clock skew can't print "-3m ago".
// Hours run to 48, not 24, deliberately: the stale threshold sits at 36h, and
// rolling over to "1d ago" would blur both sides of the decision into one
// phrase — "35h" vs "37h" is exactly the distinction the reader wants there.
export function relAge(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export interface Freshness {
  /** The bare age, e.g. "3h ago" / "age unknown". Prefer `agePhrase`. */
  label: string;
  /** Older than STALE_MS — render the warning treatment. */
  stale: boolean;
  /** False when the feed gave us no usable timestamp. */
  known: boolean;
}

// A missing/unparseable source_updated_at must NOT read as fresh — we simply
// cannot prove age, and saying nothing implies "current". So it gets its own
// honest third state rather than a silent freshness claim or a NaN.
export function freshness(
  sourceUpdatedAt: string | null | undefined,
  now: number,
): Freshness {
  const t = parseUtc(sourceUpdatedAt);
  if (t == null) return { label: "age unknown", stale: false, known: false };
  const age = now - t;
  return { label: relAge(age), stale: age > STALE_MS, known: true };
}

// The whole rendered sentence, so the two whoop surfaces can't drift in
// wording the way they would if each rebuilt it from `label`. Callers own only
// the COLOUR (the one thing that legitimately differs: frostInk.warn on the
// ambient home vs the kiosk's local pal.warn).
export function agePhrase(f: Freshness): string {
  return `${f.known ? `updated ${f.label}` : f.label}${f.stale ? " ⚠ stale" : ""}`;
}
