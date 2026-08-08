// Whoop tile freshness helpers — pure, deterministic, unit-tested.
//
// The tile used to show recovery / strain / sleep with NO age signal, so a
// strap that stopped syncing served ghost metrics: strain frozen at a stale
// open-cycle value, recovery/sleep null → "–". Indistinguishable from a
// genuinely bad recovery day. These helpers turn WHOOP's own record timestamp
// (`source_updated_at`, NOT our poll time) into a visible age + stale verdict.

/** Past this age, WHOOP's own data is presumed dead, not merely bad. */
export const STALE_MS = 36 * 3600 * 1000;

// WHOOP timestamps come back as NAIVE UTC (no offset). `new Date()` on a
// suffix-less ISO date-time parses as LOCAL, which silently shifts bed/wake by
// the timezone offset. Force a `Z` — but ONLY when the string carries no offset
// of its own, since appending to an already-offset stamp corrupts it (and in
// practice yields NaN). Date-only strings are already UTC per spec, so they
// pass through untouched.
const OFFSET_RE = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;

export function parseUtc(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const s = iso.trim();
  if (!s) return null;
  const tIdx = s.indexOf("T");
  const raw = tIdx < 0 ? s : OFFSET_RE.test(s.slice(tIdx + 1)) ? s : `${s}Z`;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
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
  /** Ready-to-render age phrase. */
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
