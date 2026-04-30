import { useEffect, useState } from "react";
import {
  fetchItemTree, createItem, reorderItems,
  type ApiItemTree, type ApiItemNode,
} from "../services/api";
import { Item } from "./Item";

const FONT = "'Inter', -apple-system, sans-serif";

export function ActivityCard() {
  const [tree, setTree] = useState<ApiItemTree | null>(null);

  async function refresh() {
    try {
      const t = await fetchItemTree();
      setTree(t);
    } catch (e) { console.error(e); }
  }

  useEffect(() => { refresh(); }, []);

  return (
    <div style={{
      background: "#fff",
      border: "0.5px solid rgba(0,0,0,0.08)",
      borderRadius: 12,
      padding: "16px 18px",
      marginBottom: 16,
      fontFamily: FONT,
      display: "flex", flexDirection: "column", gap: 18,
    }}>
      <FocusesSection
        focuses={tree?.focuses ?? []}
        onChange={refresh}
      />
    </div>
  );
}

function SectionHeader({ dotColor, label, right }: {
  dotColor: string;
  label: string;
  right?: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: "50%", background: dotColor,
      }} />
      <span style={{
        fontSize: 11, color: "#8E8E93", textTransform: "uppercase",
        letterSpacing: 0.6, fontWeight: 600,
      }}>{label}</span>
      {right && (
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#1C1C1E" }}>
          {right}
        </span>
      )}
    </div>
  );
}

function FocusesSection({ focuses, onChange }: {
  focuses: ApiItemNode[];
  onChange: () => void;
}) {
  const committed = focuses.filter((f) => f.committed && !f.done);
  const uncommitted = focuses.filter((f) => !f.committed && !f.done);
  // Done sorted by completed_at desc so most recent is on top.
  const done = focuses
    .filter((f) => f.done)
    .sort((a, b) => {
      const ta = a.completed_at ? new Date(a.completed_at).getTime() : 0;
      const tb = b.completed_at ? new Date(b.completed_at).getTime() : 0;
      return tb - ta;
    });
  const stale = committed.filter((f) => f.stale).length;

  const recentDone = done.slice(0, 2);
  const olderDone = done.slice(2);

  return (
    <div>
      <SectionHeader dotColor="#1C1C1E" label="Focuses" right={
        <span style={{ fontSize: 11, color: "#8E8E93", fontWeight: 500 }}>
          {committed.length} active{stale > 0 ? ` · ${stale} stale` : ""}
        </span>
      } />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <ReorderableList
          items={committed}
          onChange={onChange}
        />

        <FocusAdder onCreated={onChange} />

        {uncommitted.length > 0 && (
          <details style={{ marginTop: 6 }}>
            <summary style={{
              fontSize: 11, color: "#8E8E93", cursor: "pointer",
              padding: "4px 0", listStyle: "none",
            }}>
              ▸ {uncommitted.length} not committed
            </summary>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
              {uncommitted.map((f) => (
                <Item key={f.id} node={f} onChange={onChange} />
              ))}
            </div>
          </details>
        )}

        {recentDone.length > 0 && (
          <DoneSection recent={recentDone} older={olderDone} onChange={onChange} />
        )}
      </div>
    </div>
  );
}

function DoneSection({
  recent, older, onChange,
}: { recent: ApiItemNode[]; older: ApiItemNode[]; onChange: () => void }) {
  const [showAll, setShowAll] = useState(false);
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(0,0,0,0.05)" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6, marginBottom: 6,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#30A14E" }} />
        <span style={{
          fontSize: 11, color: "#8E8E93", textTransform: "uppercase",
          letterSpacing: 0.6, fontWeight: 600,
        }}>Done</span>
        <span style={{ fontSize: 11, color: "#AEAEB2", marginLeft: 4 }}>
          {recent.length + older.length}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {recent.map((f) => (
          <Item key={f.id} node={f} onChange={onChange} variant="done" />
        ))}
        {older.length > 0 && (
          <>
            {showAll && older.map((f) => (
              <Item key={f.id} node={f} onChange={onChange} variant="done" />
            ))}
            <button
              onClick={() => setShowAll((v) => !v)}
              style={{
                fontSize: 11, color: "#8E8E93",
                background: "transparent", border: "none",
                padding: "4px 0", cursor: "pointer", fontFamily: FONT,
                textAlign: "left",
              }}
            >
              {showAll ? "− hide" : `+ ${older.length} more done`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Reorder ────────────────────────────────────────────────────────────────
//
// HTML5 drag-and-drop with drop slots between rows. We mutate a local copy
// optimistically; if the API call fails, we restore from the server state.

function ReorderableList({ items, onChange }: { items: ApiItemNode[]; onChange: () => void }) {
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (items.length === 0) {
    return (
      <span style={{ fontSize: 11.5, color: "#C7C7CC", padding: "4px 0" }}>
        no focuses yet — what's on your plate?
      </span>
    );
  }

  async function commitReorder(targetIdx: number) {
    if (draggingId == null) return;
    const fromIdx = items.findIndex((i) => i.id === draggingId);
    if (fromIdx === -1 || fromIdx === targetIdx || fromIdx + 1 === targetIdx) return;
    const next = items.slice();
    const [moved] = next.splice(fromIdx, 1);
    const insertAt = targetIdx > fromIdx ? targetIdx - 1 : targetIdx;
    next.splice(insertAt, 0, moved);
    try {
      await reorderItems(next.map((n) => n.id));
      onChange();
    } catch (e) { console.error(e); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <DropSlot
        active={draggingId != null && hoverIdx === 0}
        onEnter={() => setHoverIdx(0)}
        onDrop={() => { commitReorder(0); setHoverIdx(null); }}
      />
      {items.map((f, i) => (
        <div key={f.id}>
          <Item
            node={f}
            onChange={onChange}
            draggable={!f.done}
            onDragStart={() => setDraggingId(f.id)}
            onDragEnd={() => { setDraggingId(null); setHoverIdx(null); }}
          />
          <DropSlot
            active={draggingId != null && draggingId !== f.id && hoverIdx === i + 1}
            onEnter={() => setHoverIdx(i + 1)}
            onDrop={() => { commitReorder(i + 1); setHoverIdx(null); }}
          />
        </div>
      ))}
    </div>
  );
}

function DropSlot({
  active, onEnter, onDrop,
}: { active: boolean; onEnter: () => void; onDrop: () => void }) {
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; onEnter(); }}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
      style={{ position: "relative", height: 8, margin: "1px 0" }}
    >
      <div style={{
        position: "absolute", left: 4, right: 4, top: 3, height: 2,
        borderRadius: 1,
        background: active ? "#3B82F6" : "transparent",
        transition: "background 100ms",
      }} />
    </div>
  );
}

function FocusAdder({ onCreated }: { onCreated: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      await createItem({ text: t, committed: true });
      setText("");
      onCreated();
    } catch (e) { console.error(e); }
    finally { setBusy(false); }
  }

  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !busy) submit();
        if (e.key === "Escape") setText("");
      }}
      placeholder="+ add focus"
      style={{
        fontSize: 12.5, padding: "8px 12px", borderRadius: 8,
        border: "1px dashed rgba(0,0,0,0.12)", background: "transparent",
        fontFamily: FONT, color: "#1C1C1E",
        outline: "none", marginTop: 2,
        width: "100%", boxSizing: "border-box",
      }}
      onFocus={(e) => { (e.currentTarget as HTMLInputElement).style.borderStyle = "solid"; (e.currentTarget as HTMLInputElement).style.borderColor = "rgba(0,0,0,0.18)"; }}
      onBlur={(e) => { (e.currentTarget as HTMLInputElement).style.borderStyle = "dashed"; (e.currentTarget as HTMLInputElement).style.borderColor = "rgba(0,0,0,0.12)"; }}
    />
  );
}
