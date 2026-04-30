import { useState } from "react";
import {
  type ApiItemNode,
  updateItem, deleteItem,
} from "../services/api";
import { FocusModal } from "./FocusModal";
import { Checkbox } from "./Checkbox";

const FONT = "'Inter', -apple-system, sans-serif";

interface ItemProps {
  node: ApiItemNode;
  onChange: () => void;
  // Drag — optional so callers that don't reorder can omit.
  draggable?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  // Render variant — "active" rows pulse-out before refresh; "done" rows show timestamp.
  variant?: "active" | "done";
}

export function Item({
  node, onChange,
  draggable, onDragStart, onDragEnd,
  variant = "active",
}: ItemProps) {
  const [open, setOpen] = useState(false);
  // `leaving` triggers the fade+slide animation on done toggle so items don't
  // teleport between sections — visual continuity for "I just completed this."
  const [leaving, setLeaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const hasChildren = node.children.length > 0;
  const { progress, stale } = node;
  const pct = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);

  async function toggleDone(e?: React.MouseEvent) {
    e?.stopPropagation();
    // Animate-out only when transitioning into done — the reverse direction
    // doesn't move sections in any obvious way the user would notice.
    if (!node.done) {
      setLeaving(true);
      setTimeout(async () => {
        await updateItem(node.id, { done: true });
        onChange();
      }, 260);
    } else {
      await updateItem(node.id, { done: false });
      onChange();
    }
  }

  async function remove(e: React.MouseEvent) {
    e.stopPropagation();
    await deleteItem(node.id);
    onChange();
  }

  return (
    <>
      <div
        onClick={() => { if (!leaving) setOpen(true); }}
        draggable={draggable}
        onDragStart={(e) => {
          setDragging(true);
          e.dataTransfer.effectAllowed = "move";
          // Required for Firefox to actually start a drag.
          e.dataTransfer.setData("text/plain", String(node.id));
          onDragStart?.();
        }}
        onDragEnd={() => { setDragging(false); onDragEnd?.(); }}
        style={{
          border: "0.5px solid rgba(0,0,0,0.06)", borderRadius: 8,
          padding: hasChildren ? "10px 12px" : "8px 12px",
          background: hasChildren ? "#FDFCFA" : "#fff",
          cursor: "pointer",
          fontFamily: FONT,
          opacity: leaving ? 0 : dragging ? 0.4 : 1,
          transform: leaving ? "translateY(8px) scale(0.98)" : "translateY(0)",
          transition: "opacity 240ms ease, transform 240ms cubic-bezier(0.22,1,0.36,1), background 100ms, border-color 100ms",
          pointerEvents: leaving ? "none" : "auto",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(0,0,0,0.12)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(0,0,0,0.06)"; }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {!hasChildren && (
            <Checkbox
              checked={node.done}
              onChange={() => toggleDone()}
              onClick={(e) => e.stopPropagation()}
            />
          )}
          <span style={{
            fontSize: 13, fontWeight: hasChildren ? 600 : 500,
            color: !hasChildren && node.done ? "#AEAEB2" : "#1C1C1E",
            textDecoration: !hasChildren && node.done ? "line-through" : "none",
            flex: 1,
            minWidth: 0,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {node.text}
          </span>
          {hasChildren && (
            <span style={{
              fontSize: 11, color: "#6B6B70",
              fontFamily: "ui-monospace, monospace",
              flexShrink: 0,
            }}>
              {progress.done}/{progress.total}
            </span>
          )}
          {stale && hasChildren && (
            <span style={{
              fontSize: 10, color: "#FF9500", fontWeight: 600, flexShrink: 0,
            }}>stale</span>
          )}
          {variant === "done" && node.completed_at && (
            <span style={{ fontSize: 10.5, color: "#AEAEB2", flexShrink: 0 }}>
              {fmtAgo(node.completed_at)}
            </span>
          )}
          {variant === "active" && node.due_date && !hasChildren && (
            <span style={{ fontSize: 10.5, color: "#8E8E93", flexShrink: 0 }}>
              {fmtDue(node.due_date)}
            </span>
          )}
          {!hasChildren && variant === "active" && (
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
        {hasChildren && node.endgoal && (
          <div style={{ fontSize: 11.5, color: "#8E8E93", marginTop: 4, fontStyle: "italic" }}>
            "{node.endgoal}"
          </div>
        )}
        {hasChildren && (
          <div style={{
            height: 3, background: "rgba(0,0,0,0.06)", borderRadius: 2,
            marginTop: 8, overflow: "hidden",
          }}>
            <div style={{
              width: `${pct}%`, height: "100%",
              background: stale ? "#FF9500" : "#30D158",
              transition: "width 200ms ease",
            }} />
          </div>
        )}
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

function fmtDue(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startOfTarget.getTime() - startOfToday.getTime()) / 86400000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays === -1) return "yesterday";
  if (diffDays < 0) return `${Math.abs(diffDays)}d overdue`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtAgo(iso: string): string {
  const t = new Date(iso).getTime();
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
