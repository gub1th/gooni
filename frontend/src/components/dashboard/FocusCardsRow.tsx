import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { fetchFocuses, type ApiFocus } from "../../services/api";
import { resolveFocusColor } from "../../utils/focusColors";

// FocusCardsRow — horizontal row of focus cards rendered above the todo
// list on the dashboard. Each card carries the focus color (left rail +
// dot), text, status sub-line, and a progress bar of linked todos
// (done / total) sourced from the `_focus_tree_node` payload.

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

interface Props {
  onAdd?: () => void;
  onOpen?: (focus: ApiFocus) => void;
}

export function FocusCardsRow({ onAdd, onOpen }: Props) {
  const { data: focuses } = useQuery<ApiFocus[]>({
    queryKey: ["focuses"],
    queryFn: fetchFocuses,
  });

  return (
    <div style={{
      display: "flex", gap: 10,
      overflowX: "auto", paddingBottom: 4,
      fontFamily: FONT,
      // Hide scrollbar on Webkit/Firefox while keeping scroll fn.
      scrollbarWidth: "thin",
    }}>
      {(focuses ?? []).map((f) => (
        <FocusCard key={f.id} focus={f} onClick={() => onOpen?.(f)} />
      ))}

      <button
        onClick={onAdd}
        title="Add focus"
        style={{
          flexShrink: 0,
          minWidth: 110, height: 86,
          border: "1px dashed rgba(0,0,0,0.18)",
          background: "transparent",
          borderRadius: 10,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          color: "var(--gooni-muted, #8E8E93)",
          cursor: "pointer", fontFamily: FONT, fontSize: 12,
        }}
      >
        <Plus size={14} /> add
      </button>
    </div>
  );
}

function FocusCard({ focus, onClick }: { focus: ApiFocus; onClick: () => void }) {
  const color = resolveFocusColor(focus.color, focus.id);
  const progress = focus.progress ?? { done: 0, total: 0 };
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const status = focus.status ?? (focus.committed ? "committed" : null);

  return (
    <button
      onClick={onClick}
      style={{
        flexShrink: 0,
        minWidth: 180, maxWidth: 240, height: 86,
        background: "var(--gooni-card, #fff)",
        border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
        borderLeft: `3px solid ${color}`,
        borderRadius: 10,
        padding: "10px 12px",
        textAlign: "left", cursor: "pointer",
        display: "flex", flexDirection: "column", justifyContent: "space-between",
        fontFamily: FONT,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
        <span style={{
          fontSize: 13, fontWeight: 600, color: "var(--gooni-text, #1C1C1E)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>{focus.text}</span>
      </div>
      <div>
        <div style={{
          height: 4, borderRadius: 4,
          background: "rgba(0,0,0,0.08)",
          overflow: "hidden",
          marginBottom: 4,
        }}>
          <div style={{
            width: `${pct}%`, height: "100%",
            background: color, transition: "width 220ms ease",
          }} />
        </div>
        <div style={{
          display: "flex", justifyContent: "space-between",
          fontSize: 10.5, color: "var(--gooni-muted, #8E8E93)",
          fontVariantNumeric: "tabular-nums",
        }}>
          <span>{status ?? "—"}</span>
          <span>{progress.done}/{progress.total}</span>
        </div>
      </div>
    </button>
  );
}
