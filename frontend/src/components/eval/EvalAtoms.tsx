import {
  type EvalSegmentFull,
  type EvalStatus,
} from "../../services/api";
import { Check, Minus, X } from "lucide-react";
import { frostInk as ctok, FONT } from "../../ui";
import { RATING_COLOR_EVAL, RATING_LABEL_EVAL, STATUS_STYLE } from "./evalShared";

// ── Small UI helpers ─────────────────────────────────────────────────────────
export function FilterDot() {
  // Subtle separator between filter groups. Pure decoration — matches the
  // spec's "Source: [..] · Status: [..] · [Flagged]" cadence.
  return (
    <span style={{ color: ctok.faint, fontSize: 12, padding: "0 2px", userSelect: "none" }}>·</span>
  );
}

export function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  // Inline label + chip cluster. Dropped the segmented-control track so
  // each chip stands on its own — active chips read as "the filter that's
  // narrowing the list," inactive chips as "click me to narrow further."
  // Matches the inclusive multi-select semantics: empty set = show all,
  // any selected = show only those.
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 11, color: ctok.faint, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
      <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
        {children}
      </div>
    </div>
  );
}

export function FilterPill({
  active,
  accent,
  onClick,
  count,
  children,
}: {
  active: boolean;
  accent: string;
  onClick: () => void;
  // Optional match count for active pills — gives immediate feedback on
  // what the filter actually surfaces. Omit for binary toggles (Flagged,
  // Unrated) where the count would just duplicate the visible list size.
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        background: active ? `${accent}1A` : "transparent",
        color: active ? accent : ctok.muted,
        border: active ? "none" : `1px solid ${ctok.hairline}`,
        borderRadius: 999,
        padding: "3px 10px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: active ? 600 : 500,
        fontFamily: FONT,
        transition: "background 0.1s, color 0.1s, border-color 0.1s",
        outline: "none",
      }}
    >
      {children}
      {count != null && active && (
        <span
          style={{
            background: `${accent}33`,
            color: accent,
            padding: "0 5px",
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 700,
            marginLeft: 1,
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        padding: "8px 14px",
        marginBottom: -1,
        cursor: "pointer",
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        fontFamily: FONT,
        color: active ? ctok.text : ctok.muted,
        borderBottom: active ? `2px solid ${ctok.text}` : "2px solid transparent",
      }}
    >
      {children}
    </button>
  );
}

export function Dot({ color }: { color: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: color,
      }}
    />
  );
}

// Pulsing green badge that signals "this convo is currently active" —
// last_message_at < 30 min ago, server-derived. Halo ring uses keyframes
// so the dot reads as alive without being loud.
export function ActiveBadge() {
  return (
    <span
      title="Active conversation — last message <30 min ago"
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        fontSize: 10, color: ctok.accent, fontWeight: 600,
        letterSpacing: 0.4, textTransform: "uppercase",
      }}
    >
      <style>{`
        @keyframes gooni-active-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(34,197,94,0.55); }
          50%      { box-shadow: 0 0 0 5px rgba(34,197,94,0); }
        }
      `}</style>
      <span style={{
        width: 7, height: 7, borderRadius: "50%",
        background: ctok.accent,
        animation: "gooni-active-pulse 1.6s ease-out infinite",
      }} />
      live
    </span>
  );
}

export function StatusPill({ status, onCycle }: { status: EvalStatus; onCycle?: () => void }) {
  const s = STATUS_STYLE[status];
  const clickable = !!onCycle;
  return (
    <button
      type="button"
      onClick={onCycle}
      disabled={!clickable}
      title={clickable ? "Click to cycle status" : undefined}
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        background: s.bg,
        color: s.color,
        fontSize: 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.3,
        border: "none",
        cursor: clickable ? "pointer" : "default",
        fontFamily: FONT,
      }}
    >
      {s.label}
    </button>
  );
}

// Tiny "N/M rated" badge in the eval detail header — gives the reviewer
// a quick sense of how far through a long segment they are without
// having to scroll. Counts only assistant messages (those are the ones
// that can carry a rating). A non-null rating (1/2/3) OR a non-empty
// comment counts the row as touched.
export function RatedProgressBadge({ data }: { data: EvalSegmentFull }) {
  const assistantMsgs = data.messages.filter((m) => m.role === "assistant");
  const total = assistantMsgs.length;
  if (total === 0) return null;
  const rated = assistantMsgs.filter(
    (m) => m.rating && (m.rating.rating != null || (m.rating.comment ?? "").trim() !== ""),
  ).length;
  const pct = total === 0 ? 0 : Math.round((rated / total) * 100);
  return (
    <span
      title={`${rated} of ${total} assistant replies have a rating or note (${pct}%)`}
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        background: ctok.accentDim,
        color: ctok.accent,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.3,
        fontFamily: FONT,
      }}
    >
      {rated}/{total} rated
    </span>
  );
}

export function RatingPicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  // Lucide X / Minus / Check w/ ops-board palette — parity with per-msg
  // rating row. Numbered prefix kept so the keyboard shortcut hints
  // (1/2/3) still read as labels.
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {[1, 2, 3].map((r) => {
        const active = value === r;
        const icon = r === 1
          ? <X size={14} strokeWidth={3} />
          : r === 2
            ? <Minus size={14} strokeWidth={3} />
            : <Check size={14} strokeWidth={3} />;
        return (
        <button
          key={r}
          onClick={() => onChange(value === r ? null : r)}
          title={`${r} = ${RATING_LABEL_EVAL[r]}`}
          style={{
            background: active ? `${RATING_COLOR_EVAL[r]}1F` : "transparent",
            color: RATING_COLOR_EVAL[r],
            border: active ? "none" : `1px solid ${ctok.hairline}`,
            borderRadius: 999,
            padding: "4px 10px",
            cursor: "pointer",
            fontSize: 13,
            fontFamily: FONT,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontVariantNumeric: "tabular-nums",
            transition: "background 120ms ease, color 120ms ease",
          }}
        >
          <span style={{ fontWeight: 600 }}>{r}</span>
          {icon}
          <span style={{ fontSize: 12 }}>{RATING_LABEL_EVAL[r]}</span>
        </button>
        );
      })}
    </div>
  );
}
export function ModalButton({
  children,
  onClick,
  variant,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant: "primary" | "ghost";
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: variant === "primary" ? ctok.accentDim : "transparent",
        color: variant === "primary" ? ctok.accent : ctok.muted,
        border: variant === "primary" ? "none" : `1px solid ${ctok.hairline}`,
        borderRadius: 999,
        padding: "5px 14px",
        fontSize: 12,
        fontWeight: 600,
        fontFamily: FONT,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
