import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { fetchFocuses, type ApiFocus } from "../../services/api";
import { resolveFocusColor } from "../../utils/focusColors";

// FocusCardsRow — 3-column grid of active focuses above the todo list.
//
// Mockup: each card is borderless-ish (0.5px neutral) UNLESS it's the
// "active" one (committed + has progress) — that one gets a thick 2px
// border in its own color. Title row: color dot + name. Sub-line:
// scale-derived hint ("ongoing" / "slow burn") OR a due date if
// end_at is set. Progress bar (3px tall) below + "X / Y" tally.
//
// Daniel's spec called for the FIRST card (or whichever is "primary
// focus" semantically) to be the highlighted one. Post-revamp there's
// no Focus.is_primary anymore — heuristic: highlight committed focuses
// w/ at least one linked todo, or fall back to the first card.

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

interface Props {
  onAdd?: () => void;
  onOpen?: (focus: ApiFocus) => void;
}

function fmtSubLine(f: ApiFocus): string {
  if (f.end_at) {
    const d = new Date(f.end_at);
    if (!Number.isNaN(d.getTime())) {
      return `due ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    }
  }
  if (f.scale === "slow") return "slow burn";
  if (f.scale === "quick") return "quick";
  if (f.committed) return "ongoing";
  return "—";
}

export function FocusCardsRow({ onAdd, onOpen }: Props) {
  const { data: focuses } = useQuery<ApiFocus[]>({
    queryKey: ["focuses"],
    queryFn: fetchFocuses,
  });

  // Highlight the first card by default. Could later promote based on
  // "currently doing" todo's focus_id; punt for now.
  const highlightId = (focuses ?? [])[0]?.id ?? null;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
      gap: 12,
      fontFamily: FONT,
    }}>
      {(focuses ?? []).map((f) => (
        <FocusCard
          key={f.id}
          focus={f}
          highlight={f.id === highlightId}
          onClick={() => onOpen?.(f)}
        />
      ))}

      {/* "+ add" tile fills the last column when there are <3 focuses,
          else wraps to a new row. Same rounded shape but dashed. */}
      <button
        onClick={onAdd}
        title="Add focus"
        style={{
          minHeight: 96,
          border: "1px dashed rgba(0,0,0,0.18)",
          background: "transparent",
          borderRadius: 12,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          color: "var(--gooni-muted, #8E8E93)",
          cursor: "pointer", fontFamily: FONT, fontSize: 12,
        }}
      >
        <Plus size={14} /> add focus
      </button>
    </div>
  );
}

function FocusCard({ focus, highlight, onClick }: {
  focus: ApiFocus;
  highlight: boolean;
  onClick: () => void;
}) {
  const color = resolveFocusColor(focus.color, focus.id);
  const progress = focus.progress ?? { done: 0, total: 0 };
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const sub = fmtSubLine(focus);

  return (
    <button
      onClick={onClick}
      style={{
        textAlign: "left",
        background: "var(--gooni-card, #fff)",
        border: highlight ? `2px solid ${color}` : "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
        borderRadius: 12,
        padding: highlight ? "13px 15px" : "14px 16px",
        cursor: "pointer",
        fontFamily: FONT,
        display: "flex", flexDirection: "column",
        minHeight: 96,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, minWidth: 0 }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          background: color, flexShrink: 0,
        }} />
        <span style={{
          fontSize: 14, fontWeight: 500,
          color: "var(--gooni-text, #1C1C1E)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {focus.text}
        </span>
      </div>
      <div style={{
        fontSize: 12, color: "var(--gooni-muted, #8E8E93)",
        marginBottom: 10,
      }}>
        {sub}
      </div>
      <div style={{ marginTop: "auto" }}>
        <div style={{
          height: 3, background: "rgba(0,0,0,0.07)",
          borderRadius: 2, overflow: "hidden",
        }}>
          <div style={{
            width: `${pct}%`, height: "100%",
            background: color, borderRadius: 2,
            transition: "width 220ms ease",
          }} />
        </div>
        <div style={{
          display: "flex", justifyContent: "space-between",
          marginTop: 4,
          fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
          fontVariantNumeric: "tabular-nums",
        }}>
          <span>{progress.done} / {progress.total}</span>
        </div>
      </div>
    </button>
  );
}
