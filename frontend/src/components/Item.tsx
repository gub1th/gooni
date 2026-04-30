import { useState } from "react";
import {
  type ApiItemNode,
  updateItem, deleteItem,
} from "../services/api";
import { FocusModal } from "./FocusModal";

const FONT = "'Inter', -apple-system, sans-serif";

interface ItemProps {
  node: ApiItemNode;
  onChange: () => void;
}

export function Item({ node, onChange }: ItemProps) {
  const [open, setOpen] = useState(false);
  const hasChildren = node.children.length > 0;
  const { progress, stale } = node;
  const pct = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);

  async function toggleDone(e: React.MouseEvent | React.ChangeEvent) {
    e.stopPropagation();
    await updateItem(node.id, { done: !node.done });
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
        style={{
          border: "0.5px solid rgba(0,0,0,0.06)", borderRadius: 8,
          padding: hasChildren ? "10px 12px" : "8px 12px",
          background: hasChildren ? "#FDFCFA" : "#fff",
          cursor: "pointer",
          fontFamily: FONT,
          transition: "background 100ms, border-color 100ms",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(0,0,0,0.12)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(0,0,0,0.06)"; }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {!hasChildren && (
            <input
              type="checkbox"
              checked={node.done}
              onClick={(e) => e.stopPropagation()}
              onChange={toggleDone}
              style={{ accentColor: "#30D158", flexShrink: 0 }}
            />
          )}
          <span style={{
            fontSize: 13, fontWeight: hasChildren ? 600 : 500,
            color: !hasChildren && node.done ? "#AEAEB2" : "#1C1C1E",
            textDecoration: !hasChildren && node.done ? "line-through" : "none",
            flex: 1,
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
          {node.due_date && !hasChildren && (
            <span style={{ fontSize: 10.5, color: "#8E8E93", flexShrink: 0 }}>
              {fmtDue(node.due_date)}
            </span>
          )}
          {!hasChildren && (
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
