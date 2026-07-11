import { type EvalStatus } from "../../services/api";
import { color as ctok } from "../../ui";

// Per-source visual identity. Tone matches Apple-Notes restraint that the
// rest of Gooni uses: muted accent dot + label, not loud full-fill badges.
// `accent` colors stay deliberately desaturated so cards read as a quiet
// grid, not a status board.
// Distinct per-source palette — Daniel called out that everything was
// the same green. WhatsApp gets the brand green; Telegram + iMessage get
// blues from their respective brand families (slightly differentiated so
// they're not literally identical); Web stays a neutral generic blue.
export const SOURCE_STYLE: Record<
  string,
  { accent: string; label: string }
> = {
  web: { accent: "#378ADD", label: "Web" },
  telegram: { accent: "#229ED9", label: "Telegram" },
  whatsapp: { accent: "#25D366", label: "WhatsApp" },
  imessage: { accent: "#534AB7", label: "iMessage" },
};

// Color-coded status pills — DONE green / PENDING amber / NOT YET neutral.
// Same palette family as the dashboard's age indicator, so the eyes already
// know which is which.
export const STATUS_STYLE: Record<EvalStatus, { color: string; bg: string; label: string }> = {
  not_yet: { color: ctok.muted, bg: ctok.hover, label: "Not yet" },
  pending: { color: "#B8860B", bg: "rgba(245,158,11,0.16)", label: "Pending" },
  done: { color: "#15A06E", bg: "rgba(22,163,74,0.16)", label: "Done" },
};

export const SOURCES = ["web", "telegram", "whatsapp", "imessage"] as const;
export const STATUSES: EvalStatus[] = ["not_yet", "pending", "done"];
export const RATING_COLOR_EVAL: Record<number, string> = { 1: "#F87171", 2: "#9CA3AF", 3: "#34D399" };
export const RATING_LABEL_EVAL: Record<number, string> = { 1: "bad", 2: "neutral", 3: "good" };
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

// Backend stores last_message_at as naive UTC (SQLite drops tzinfo) and
// .isoformat() emits no 'Z' suffix. JS `new Date(str)` then parses as local
// → renders future-shifted by the local offset, producing "-1d ago" for
// stamps from a few hours back. Append 'Z' so JS parses as UTC.
export function parseUtcIso(iso: string): Date {
  const hasTz = iso.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(iso);
  return new Date(hasTz ? iso : iso + "Z");
}

export function formatDate(d: Date): string {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const diffMs = now.getTime() - d.getTime();
  // Defensive: future timestamps (clock skew, residual TZ bugs) → render as time-of-day.
  if (diffMs < 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}
