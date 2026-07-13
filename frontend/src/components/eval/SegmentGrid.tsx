import { useEffect, useRef } from "react";
import { type EvalSegmentSummary } from "../../services/api";
import { frostInk as ctok, FONT } from "../../ui";
import { ActiveBadge, Dot, StatusPill } from "./EvalAtoms";
import {
  formatDate,
  parseUtcIso,
  SOURCE_STYLE,
  STATUS_STYLE,
  truncate,
} from "./evalShared";

// ── Card ─────────────────────────────────────────────────────────────────────

export function SegmentCard({
  seg,
  onClick,
  focused = false,
}: {
  seg: EvalSegmentSummary;
  onClick: () => void;
  focused?: boolean;
}) {
  const sourceStyle = SOURCE_STYLE[seg.source] ?? SOURCE_STYLE.web;
  const when = seg.last_message_at ? parseUtcIso(seg.last_message_at) : null;
  const ref = useRef<HTMLButtonElement>(null);
  // Auto-scroll the focused card into view so j/k feels like cursor nav,
  // not "you've now lost where you are." Block: nearest avoids unnecessary
  // jumping when the card is already visible.
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  return (
    <button
      ref={ref}
      onClick={onClick}
      style={{
        textAlign: "left",
        padding: "14px 16px",
        borderRadius: 14,
        background: focused ? ctok.accentDim : ctok.card,
        border: "none",
        cursor: "pointer",
        fontFamily: FONT,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 130,
        transition: "background 0.12s",
        outline: "none",
      }}
      onMouseEnter={(e) => {
        if (focused) return;
        e.currentTarget.style.background = ctok.cardRaised;
      }}
      onMouseLeave={(e) => {
        if (focused) return;
        e.currentTarget.style.background = ctok.card;
      }}
    >
      {/* Top — source + status pill. Source reads as the primary id of
          this card, status reads as the state. */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: sourceStyle.accent,
            fontWeight: 600,
            letterSpacing: 0.1,
          }}
        >
          <Dot color={sourceStyle.accent} />
          {sourceStyle.label}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {seg.is_active && <ActiveBadge />}
          <StatusPill status={seg.eval_status} />
        </span>
      </div>
      {/* Middle — preview text, muted, wraps. */}
      <div
        style={{
          fontSize: 13,
          color: ctok.muted,
          lineHeight: 1.45,
          flex: 1,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
        }}
      >
        {seg.preview || <em style={{ color: ctok.muted }}>(no user message)</em>}
      </div>
      {/* Bottom — metadata + action indicators. */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
          color: ctok.muted,
        }}
      >
        <span>
          {seg.message_count} msg{when ? ` · ${formatDate(when)}` : ""}
          {seg.cost_usd != null && seg.cost_usd > 0 && (
            <span style={{ color: ctok.muted }}> · ${seg.cost_usd.toFixed(4)}</span>
          )}
        </span>
        <span style={{ display: "flex", gap: 8 }}>
          {seg.flag_count > 0 && (
            <span style={{ color: ctok.warn }}>{seg.flag_count} flag{seg.flag_count === 1 ? "" : "s"}</span>
          )}
          {seg.dispatched_to_cc_at && (
            <span style={{ color: ctok.accent }}>→ CC</span>
          )}
        </span>
      </div>
    </button>
  );
}

// ── Compact list row ─────────────────────────────────────────────────────────

export function SegmentRow({
  seg,
  isFirst,
  onClick,
  focused = false,
}: {
  seg: EvalSegmentSummary;
  isFirst: boolean;
  onClick: () => void;
  focused?: boolean;
}) {
  const sourceStyle = SOURCE_STYLE[seg.source] ?? SOURCE_STYLE.web;
  const when = seg.last_message_at ? parseUtcIso(seg.last_message_at) : null;
  const statusStyle = STATUS_STYLE[seg.eval_status];
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  return (
    <button
      ref={ref}
      onClick={onClick}
      style={{
        textAlign: "left",
        padding: "10px 14px",
        background: focused ? ctok.accentDim : ctok.card,
        border: "none",
        borderTop: isFirst ? "none" : `1px solid ${ctok.hairline}`,
        borderLeft: focused ? `3px solid ${ctok.accent}` : "3px solid transparent",
        cursor: "pointer",
        fontFamily: FONT,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minHeight: 48,
        transition: "background 0.08s",
      }}
      onMouseEnter={(e) => {
        if (focused) return;
        e.currentTarget.style.background = ctok.cardRaised;
      }}
      onMouseLeave={(e) => {
        if (focused) return;
        e.currentTarget.style.background = ctok.card;
      }}
    >
      {/* Primary row — source + msg count + time on the left, status pill
          on the right. The meaningful identifier of the segment lives
          here, not in the first-message preview (which is often a
          mid-thought fragment and looked like a chopped-up title). */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 12,
            color: sourceStyle.accent,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          <Dot color={sourceStyle.accent} />
          {sourceStyle.label}
        </span>
        <span style={{ fontSize: 11, color: ctok.muted, flexShrink: 0 }}>
          · {seg.message_count} msg{when ? ` · ${formatDate(when)}` : ""}
        </span>
        <span style={{ flex: 1 }} />
        {seg.flag_count > 0 && (
          <span style={{ fontSize: 11, color: ctok.warn, flexShrink: 0 }}>
            {seg.flag_count} flag{seg.flag_count === 1 ? "" : "s"}
          </span>
        )}
        {seg.dispatched_to_cc_at && (
          <span style={{ fontSize: 11, color: ctok.accent, flexShrink: 0 }}>→ CC</span>
        )}
        <span
          style={{
            fontSize: 10,
            color: statusStyle.color,
            background: statusStyle.bg,
            padding: "2px 6px",
            borderRadius: 999,
            letterSpacing: 0.3,
            fontWeight: 600,
            textTransform: "uppercase",
            flexShrink: 0,
          }}
        >
          {statusStyle.label}
        </span>
      </div>
      {/* Secondary row — first-message preview as muted snippet. ~80 char
          cap with ellipsis keeps a long stream-of-thought sentence from
          taking over the row. */}
      {seg.preview && (
        <div
          style={{
            fontSize: 12.5,
            color: ctok.muted,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            lineHeight: 1.4,
          }}
        >
          {truncate(seg.preview, 90)}
        </div>
      )}
    </button>
  );
}

// ── View toggle ──────────────────────────────────────────────────────────────

export function ViewToggle({
  mode,
  onChange,
}: {
  mode: "list" | "cards";
  onChange: (m: "list" | "cards") => void;
}) {
  // Matches FilterGroup's segmented look: gray track, active = white fill +
  // soft shadow. Keeps the whole toolbar visually consistent.
  const btn = (active: boolean): React.CSSProperties => ({
    padding: "3px 10px",
    fontSize: 12,
    fontFamily: FONT,
    background: active ? ctok.cardRaised : "transparent",
    color: active ? ctok.text : ctok.muted,
    border: "none",
    borderRadius: 999,
    cursor: "pointer",
    lineHeight: 1,
    fontWeight: active ? 600 : 500,
    transition: "background 0.1s, color 0.1s",
    outline: "none",
  });
  return (
    <div
      style={{
        display: "inline-flex",
        padding: 2,
        background: ctok.card,
        borderRadius: 999,
      }}
    >
      <button style={btn(mode === "list")} onClick={() => onChange("list")} title="List view">
        ≡
      </button>
      <button style={btn(mode === "cards")} onClick={() => onChange("cards")} title="Card view">
        ▦
      </button>
    </div>
  );
}
