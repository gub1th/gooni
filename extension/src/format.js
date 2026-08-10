/**
 * Display formatting for the popup.
 *
 * Chrome-free and DOM-free so it is testable on node:test, same split as
 * status.js. The wording rules here are not decoration — three of them are the
 * difference between the popup reporting what the sensor knows and the popup
 * flattering it:
 *
 *  - a period with no intervals says "no data", never "0 seconds"
 *  - a duration built from salvaged (`truncated`) intervals is a FLOOR, and
 *    the row that carries one says so
 *  - a rounded percentage never reads 0% for a host that actually holds time
 */

/**
 * Seconds → clock form, the shape of the numbers in the ranked list:
 * `1:13:10` past an hour, `28:38` under one, `0:07` under a minute.
 *
 * Seconds are FLOORED, not rounded: every number in the list is a lower bound
 * on real attention already (intervals close at heartbeats and idle is
 * backdated), and rounding up would let the parts total more than the whole.
 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Seconds → the headline form: `2h 0m 30s`, `5m 12s`, `42s`.
 *
 * Zero-valued LEADING units are dropped but interior ones are kept — "2h 30s"
 * would read as two and a half hours at a glance, so the minutes stay even at
 * zero once an hour is present.
 */
export function formatHeadline(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** `1 session` / `40 sessions`. */
export function formatSessions(n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  return `${count} session${count === 1 ? "" : "s"}`;
}

/**
 * Share of the period, as a display string.
 *
 * Rounds to a whole percent EXCEPT where that would print `0%` for a host that
 * really holds time — a row showing a duration next to 0% reads as a rendering
 * bug. Those become `<1%`.
 */
export function formatPercent(part, total) {
  const p = Number(part) || 0;
  const t = Number(total) || 0;
  if (t <= 0 || p <= 0) return "0%";
  const pct = (p / t) * 100;
  if (pct < 0.5) return "<1%";
  return `${Math.round(pct)}%`;
}

/** Bar width as a 0–100 number. Unrounded — the bar is geometry, not a claim. */
export function barPercent(part, total) {
  const t = Number(total) || 0;
  if (t <= 0) return 0;
  return Math.max(0, Math.min(100, ((Number(part) || 0) / t) * 100));
}

/**
 * `2026-08-08` → a short axis label. Parsed as LOCAL noon rather than through
 * `new Date("2026-08-08")`, which JS reads as UTC midnight and therefore
 * renders as the PREVIOUS day for anyone west of Greenwich — the exact bug the
 * server-side local-day bucketing exists to avoid, reintroduced at the last
 * step.
 */
export function dayLabel(iso, { today = null } = {}) {
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return String(iso);
  const date = new Date(y, m - 1, d, 12);
  const now = today ? new Date(today) : new Date();
  const isToday =
    now.getFullYear() === y && now.getMonth() === m - 1 && now.getDate() === d;
  if (isToday) return "today";
  return date.toLocaleDateString(undefined, { weekday: "short" });
}

/**
 * The one sentence about salvaged intervals, or null when there are none.
 *
 * A `truncated` interval was closed at its last heartbeat because the browser
 * died mid-span, so its duration is a floor rather than a measurement. It is
 * counted (dropping real attention would understate the day) and it is
 * labelled (counting it silently would overstate it) — that is the whole rule,
 * and this is where it is said out loud.
 */
export function truncatedNote(totals) {
  const n = Math.floor(Number(totals?.truncated_sessions) || 0);
  if (n <= 0) return null;
  return (
    `${n} salvaged interval${n === 1 ? "" : "s"} ` +
    `(${formatDuration(totals.truncated_sec)}) — browser closed mid-span, ` +
    `so that time is a floor, not a measurement`
  );
}

/**
 * The buffered/unsent line, or null when nothing is pending.
 *
 * Without it a low number is ambiguous: attention that happened but has not
 * flushed yet is indistinguishable from attention that never happened.
 */
export function pendingNote(status) {
  const buffered = Math.floor(Number(status?.buffered) || 0);
  if (buffered <= 0) return null;
  const why = status?.hasToken === false ? " — no token saved, nothing can flush" : "";
  return `${buffered} interval${buffered === 1 ? "" : "s"} not yet sent${why}; totals below exclude them`;
}
