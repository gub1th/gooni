import { useState } from "react";
import {
  type ApiItemNode, type ApiTodayItem,
  updateItem, deleteItem, createItem,
} from "../services/api";

const FONT = "'Manrope', -apple-system, sans-serif";

interface ItemProps {
  node: ApiItemNode;
  depth: number;
  onChange: () => void;
}

export function Item({ node, depth, onChange }: ItemProps) {
  const isFocus = depth === 0 && Boolean(node.endgoal);
  const hasChildren = node.children.length > 0;
  const [expanded, setExpanded] = useState(depth === 0);
  const [adding, setAdding] = useState(false);

  if (isFocus) {
    return (
      <FocusRow
        node={node}
        expanded={expanded}
        onToggleExpand={() => setExpanded((v) => !v)}
        onChange={onChange}
        onStartAddChild={() => { setExpanded(true); setAdding(true); }}
        adding={adding}
        onAddDone={() => setAdding(false)}
      />
    );
  }

  return (
    <LeafRow
      node={node}
      depth={depth}
      hasChildren={hasChildren}
      expanded={expanded}
      onToggleExpand={() => setExpanded((v) => !v)}
      onChange={onChange}
    />
  );
}

// ── Focus row (top-level item with endgoal) ─────────────────────────────────

function FocusRow({ node, expanded, onToggleExpand, onChange, onStartAddChild, adding, onAddDone }: {
  node: ApiItemNode;
  expanded: boolean;
  onToggleExpand: () => void;
  onChange: () => void;
  onStartAddChild: () => void;
  adding: boolean;
  onAddDone: () => void;
}) {
  const { progress, stale } = node;
  const pct = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);

  return (
    <div style={{
      border: "0.5px solid rgba(0,0,0,0.06)", borderRadius: 8,
      padding: "10px 12px", background: "#FDFCFA",
    }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
        onClick={onToggleExpand}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: "#1C1C1E", flex: 1 }}>
          {node.text}
        </span>
        <span style={{
          fontSize: 11, color: "#6B6B70",
          fontFamily: "ui-monospace, monospace",
          flexShrink: 0,
        }}>
          {progress.done}/{progress.total || 0}
        </span>
        {stale && (
          <span style={{
            fontSize: 10, color: "#FF9500", fontWeight: 600, flexShrink: 0,
          }}>stale</span>
        )}
      </div>
      {node.endgoal && (
        <div style={{ fontSize: 11.5, color: "#8E8E93", marginTop: 4, fontStyle: "italic" }}>
          "{node.endgoal}"
        </div>
      )}
      {/* Progress bar */}
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
      {expanded && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
          {node.children.map((child) => (
            <Item key={child.id} node={child} depth={1} onChange={onChange} />
          ))}
          {adding ? (
            <ChildAdder parentId={node.id} onDone={() => { onAddDone(); onChange(); }} />
          ) : (
            <button
              onClick={onStartAddChild}
              style={{
                fontSize: 11.5, color: "#8E8E93", textAlign: "left",
                background: "transparent", border: "none",
                padding: "4px 0", cursor: "pointer", fontFamily: FONT,
              }}
            >+ add step</button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Leaf row (step / todo) ──────────────────────────────────────────────────

function LeafRow({ node, depth, hasChildren, expanded, onToggleExpand, onChange }: {
  node: ApiItemNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onChange: () => void;
}) {
  async function toggleDone() {
    await updateItem(node.id, { done: !node.done });
    onChange();
  }
  async function remove() {
    await deleteItem(node.id);
    onChange();
  }
  return (
    <div style={{
      paddingLeft: depth > 1 ? (depth - 1) * 14 : 0,
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "4px 0", fontFamily: FONT,
      }}>
        <input
          type="checkbox"
          checked={node.done}
          onChange={toggleDone}
          style={{ accentColor: "#30D158", flexShrink: 0 }}
        />
        <span
          onClick={hasChildren ? onToggleExpand : undefined}
          style={{
            fontSize: 12, color: node.done ? "#AEAEB2" : "#1C1C1E",
            textDecoration: node.done ? "line-through" : "none",
            cursor: hasChildren ? "pointer" : "default",
            flex: 1,
          }}
        >{node.text}</span>
        {node.due_date && (
          <span style={{ fontSize: 10.5, color: "#8E8E93", flexShrink: 0 }}>
            {fmtDue(node.due_date)}
          </span>
        )}
        <button
          onClick={remove}
          aria-label="delete"
          style={{
            background: "transparent", border: "none",
            color: "#C7C7CC", cursor: "pointer",
            fontSize: 12, padding: "0 4px",
          }}
        >×</button>
      </div>
      {hasChildren && expanded && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {node.children.map((child) => (
            <Item key={child.id} node={child} depth={depth + 1} onChange={onChange} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Today row (flat leaf with parent_chain badge) ───────────────────────────

export function TodayRow({ item, onChange }: { item: ApiTodayItem; onChange: () => void }) {
  async function toggleDone() {
    await updateItem(item.id, { done: !item.done });
    onChange();
  }
  const parent = item.parent_chain[0]; // top-level focus name, if any
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "4px 0", fontFamily: FONT,
    }}>
      <input
        type="checkbox"
        checked={item.done}
        onChange={toggleDone}
        style={{ accentColor: "#30D158", flexShrink: 0 }}
      />
      <span style={{
        fontSize: 12, color: item.done ? "#AEAEB2" : "#1C1C1E",
        textDecoration: item.done ? "line-through" : "none",
        flex: 1,
      }}>{item.text}</span>
      {parent && (
        <span style={{
          fontSize: 10, color: "#6B6B70",
          background: "rgba(0,0,0,0.04)", borderRadius: 4,
          padding: "1px 6px", flexShrink: 0,
        }}>← {parent}</span>
      )}
      {item.due_date && (
        <span style={{ fontSize: 10.5, color: "#8E8E93", flexShrink: 0 }}>
          {fmtDue(item.due_date)}
        </span>
      )}
    </div>
  );
}

// ── Inline child adder ──────────────────────────────────────────────────────

function ChildAdder({ parentId, onDone }: { parentId: number; onDone: () => void }) {
  const [text, setText] = useState("");
  async function submit() {
    if (!text.trim()) { onDone(); return; }
    await createItem({ text: text.trim(), parent_id: parentId });
    onDone();
  }
  return (
    <input
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={submit}
      onKeyDown={(e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") onDone();
      }}
      placeholder="step…"
      style={{
        fontSize: 12, padding: "4px 8px", borderRadius: 6,
        border: "1px solid rgba(0,0,0,0.1)", background: "#fff",
        fontFamily: FONT,
      }}
    />
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
