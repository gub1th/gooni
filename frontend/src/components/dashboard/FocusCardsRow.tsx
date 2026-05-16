import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { fetchFocuses, type ApiFocus } from "../../services/api";
import { resolveFocusColor } from "../../utils/focusColors";

// FocusCardsRow — 3-column grid of active focuses above the todo list.
//
// Anchor section of the dashboard. Every card gets a soft Gemini-style
// glow halo behind it in its own focus color — eye-catching but quiet
// enough not to fight the foreground text. Highlighted (currently
// "primary") card gets a deeper halo so the eye lands on it first.

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
    <div style={{ fontFamily: FONT }}>
      <style>{`
        @keyframes gooni-focus-glow-spin {
          to { transform: translate(-50%, -50%) rotate(360deg); }
        }
      `}</style>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: 16,
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

  // Halo intensity: highlighted card gets a wider, slightly more opaque
  // glow + a slow rotating conic-gradient sheen. Non-highlighted cards
  // still glow softly so the row reads as a unified colorful surface.
  const haloBlur = highlight ? 22 : 14;
  const haloOpacity = highlight ? 0.45 : 0.22;
  const haloInset = highlight ? -10 : -6;

  return (
    <div style={{ position: "relative" }}>
      {/* Soft colored halo — rendered as a separate layer behind the
          card so the card itself stays opaque and readable. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: haloInset,
          borderRadius: 18,
          background: color,
          filter: `blur(${haloBlur}px)`,
          opacity: haloOpacity,
          pointerEvents: "none",
          transition: "opacity 220ms ease",
        }}
      />
      {/* Gemini-ish rotating sheen layer — only on the highlighted card.
          Conic gradient at low opacity gives a multi-stop colorful look
          without going full rainbow. Slow rotate keeps it alive. */}
      {highlight && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: "50%", left: "50%",
            width: "180%", height: "180%",
            transform: "translate(-50%, -50%)",
            borderRadius: "50%",
            background: `conic-gradient(from 0deg, ${color}00, ${color}77, ${color}22, ${color}88, ${color}00)`,
            filter: "blur(28px)",
            opacity: 0.45,
            pointerEvents: "none",
            animation: "gooni-focus-glow-spin 14s linear infinite",
          }}
        />
      )}
      <button
        onClick={onClick}
        style={{
          position: "relative",
          width: "100%",
          textAlign: "left",
          background: "var(--gooni-card, #fff)",
          border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
          borderRadius: 12,
          padding: "14px 16px",
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
    </div>
  );
}
