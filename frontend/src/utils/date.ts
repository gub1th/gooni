// Shared date helpers. Backend ISO timestamps frequently omit a trailing
// `Z`. `new Date("2026-05-24T10:00:00")` (no offset) is parsed as LOCAL
// time, which silently shifts every server timestamp by the viewer's tz
// offset — "x ago" labels and age dots come out wrong. We treat naive
// strings as UTC (append Z) so the math is correct everywhere.

/** Parse a server ISO string as UTC-when-naive. Returns null on null/unparseable. */
export function parseServerDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "May 24, 2026" — long month. "" when null/unparseable. */
export function formatLongDate(iso: string | null): string {
  const d = parseServerDate(iso);
  return d
    ? d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "";
}

/** Coarse "x ago": s → m → h → d → mo → y. "—" when null/unparseable. */
export function relativeTimeShort(iso: string | null): string {
  const d = parseServerDate(iso);
  if (!d) return "—";
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  const mo = Math.floor(days / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** "YYYY-MM-DD" for <input type="date">; "" when null/unparseable. */
export function toDateInputValue(iso: string | null): string {
  const d = parseServerDate(iso);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
