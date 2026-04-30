import { useEffect, useRef, useState } from "react";
import {
  type ApiItemNode, type FocusScale, type FocusStatus,
  updateItem, deleteItem,
} from "../services/api";
import { FocusModal } from "./FocusModal";

const FONT = "'Inter', -apple-system, sans-serif";

// Focus-specific row. Distinct from `Item` (which renders todos + nested
// focus children with checkboxes) — focuses are commitments, not todos, so
// the checkbox UI is intentionally absent. The row layout:
//   [status-or-pulse dot][name][scale badge][last active][···][×]
// Primary focus shows ONLY a pulsing green dot (no second status dot — they
// looked like two separate buttons). Plus a 3px green left rail + faint tint.
// Rows live inside a single shared card (no per-row borders).

interface FocusRowProps {
  node: ApiItemNode;
  onChange: () => void;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  // "active" = full UI (status dot, scale badge, ··· menu, ×).
  // "done"   = read-only completed treatment: strikethrough title,
  //           completed_at timestamp, no menu, no delete button. Restore
  //           via clicking the row → modal → uncheck Done.
  variant?: "active" | "done";
  // When true, draws a thin top separator. Used inside ReorderableList where
  // sibling structure (rows + DropSlots) doesn't let CSS adjacent-sibling
  // selectors fire reliably.
  separator?: boolean;
}

export function FocusRow({
  node, onChange, draggable, onDragStart, onDragEnd, variant = "active", separator,
}: FocusRowProps) {
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const isDone = variant === "done";
  const isPrimary = node.is_primary && !isDone;  // primary treatment irrelevant once done
  const effectiveStatus = resolveStatus(node);
  const isNeglected = effectiveStatus === "someday";
  const tsIso = isDone ? node.completed_at : (node.updated_at || node.created_at);

  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  async function togglePrimary(e: React.MouseEvent) {
    e.stopPropagation();
    setMenuOpen(false);
    await updateItem(node.id, { is_primary: !isPrimary });
    window.dispatchEvent(new CustomEvent("gooni-primary-changed"));
    onChange();
  }

  async function remove(e: React.MouseEvent) {
    e.stopPropagation();
    await deleteItem(node.id);
    onChange();
  }

  return (
    <>
      <div
        onClick={() => setOpen(true)}
        onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true); }}
        draggable={draggable}
        onDragStart={(e) => {
          setDragging(true);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(node.id));
          onDragStart?.();
        }}
        onDragEnd={() => { setDragging(false); onDragEnd?.(); }}
        style={{
          position: "relative",
          // Live inside a shared parent card now — no per-row border.
          // Primary keeps its green rail + tint, everyone else stays flat.
          borderLeft: isPrimary ? "3px solid #4ADE80" : "3px solid transparent",
          borderTop: separator ? "0.5px solid rgba(0,0,0,0.06)" : "none",
          padding: "9px 10px",
          background: isPrimary ? "rgba(74, 222, 128, 0.05)" : "transparent",
          cursor: "pointer",
          fontFamily: FONT,
          opacity: dragging ? 0.4 : 1,
          transition: "background 100ms",
        }}
        onMouseEnter={(e) => {
          if (!isPrimary) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.025)";
        }}
        onMouseLeave={(e) => {
          if (!isPrimary) (e.currentTarget as HTMLDivElement).style.background = "transparent";
        }}
      >
        <style>{PULSE_KEYFRAMES}</style>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* Primary shows the glowing dot ONLY — no second status dot. The
              two-dot version read like two adjacent buttons. */}
          {isPrimary ? (
            <span
              aria-hidden
              title="primary"
              style={{
                width: 8, height: 8, borderRadius: "50%",
                background: "#4ADE80",
                boxShadow: "0 0 6px rgba(74,222,128,0.6)",
                animation: "primaryPulse 1.6s ease-in-out infinite",
                flexShrink: 0,
              }}
            />
          ) : (
            <span
              aria-hidden
              title={effectiveStatus}
              style={{
                width: 8, height: 8, borderRadius: "50%",
                background: STATUS_DOT[effectiveStatus],
                flexShrink: 0,
              }}
            />
          )}
          <span style={{
            fontSize: 13,
            fontWeight: isPrimary ? 600 : 500,
            color: isDone ? "#AEAEB2"
              : isNeglected ? "var(--color-text-tertiary, #C7C7CC)" : "#1C1C1E",
            textDecoration: isDone ? "line-through" : "none",
            flex: 1,
            minWidth: 0,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {node.text}
          </span>

          {/* Scale badge — primary skips it; primary's left border + pulse
              already say "this is the important one". */}
          {!isPrimary && node.scale && (
            <span style={{
              ...SCALE_BADGE_BASE,
              ...SCALE_BADGE_STYLE[node.scale],
            }}>
              {SCALE_LABEL[node.scale]}
            </span>
          )}

          <span style={{ fontSize: 10.5, color: "#AEAEB2", flexShrink: 0 }}>
            {fmtAgo(tsIso)}
          </span>

          {!isDone && (
            <div ref={menuRef} style={{ position: "relative" }}>
              <button
                onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
                aria-label="more"
                style={{
                  background: "transparent", border: "none",
                  color: "#AEAEB2", cursor: "pointer",
                  fontSize: 14, padding: "0 4px", lineHeight: 1,
                }}
              >···</button>
              {menuOpen && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: "absolute", right: 0, top: "100%",
                    marginTop: 4, zIndex: 10,
                    background: "#FFF", border: "0.5px solid rgba(0,0,0,0.12)",
                    borderRadius: 8, padding: 4,
                    boxShadow: "0 6px 20px rgba(0,0,0,0.08)",
                    minWidth: 140,
                  }}
                >
                  <button onClick={togglePrimary} style={MENU_BTN}>
                    {node.is_primary ? "Unset primary" : "Set as primary"}
                  </button>
                </div>
              )}
            </div>
          )}

          {!isDone && (
            <button
              onClick={remove}
              aria-label="delete"
              style={{
                background: "transparent", border: "none",
                color: "#C7C7CC", cursor: "pointer",
                fontSize: 12, padding: "0 4px",
              }}
            >×</button>
          )}
        </div>
      </div>
      {open && (
        <FocusModal
          node={node}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

const PULSE_KEYFRAMES = `
  @keyframes primaryPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.4; transform: scale(0.7); }
  }
`;

const STATUS_DOT: Record<FocusStatus, string> = {
  committed: "#4ADE80",
  pending:   "#FBD24D",
  someday:   "#DDDDDD",
};

const SCALE_LABEL: Record<FocusScale, string> = {
  long_term: "long-term",
  sprint:    "sprint",
  medium:    "medium",
};

const SCALE_BADGE_BASE: React.CSSProperties = {
  fontSize: 10, fontWeight: 600,
  padding: "2px 7px", borderRadius: 999,
  letterSpacing: 0.2,
  flexShrink: 0,
  textTransform: "lowercase",
};

const SCALE_BADGE_STYLE: Record<FocusScale, React.CSSProperties> = {
  long_term: { background: "#EDE9FE", color: "#5B21B6" },
  sprint:    { background: "#F0FDF4", color: "#166534" },
  medium:    { background: "#FEF3C7", color: "#92400E" },
};

const MENU_BTN: React.CSSProperties = {
  display: "block", width: "100%",
  padding: "6px 10px", border: "none",
  background: "transparent", color: "#1C1C1E",
  fontSize: 12, fontFamily: FONT,
  textAlign: "left", cursor: "pointer", borderRadius: 6,
};

// Resolve the displayed status. Status column is the source of truth when
// present; legacy rows fall back to deriving from `committed` + `stale`.
function resolveStatus(node: ApiItemNode): FocusStatus {
  if (node.status) return node.status;
  if (!node.committed) return "someday";
  return node.stale ? "pending" : "committed";
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
