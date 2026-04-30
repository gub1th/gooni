import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchItemTree, createItem, reorderItems,
  type ApiItemTree, type ApiItemNode,
} from "../services/api";
import { Item } from "./Item";
import { Skeleton } from "./Skeleton";

const FONT = "'Inter', -apple-system, sans-serif";

export function ActivityCard() {
  const queryClient = useQueryClient();
  const { data: tree, isLoading } = useQuery<ApiItemTree>({
    queryKey: ["item-tree"],
    queryFn: fetchItemTree,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["item-tree"] });

  return (
    <div style={{
      // Drop the card chrome — gives the focuses block the same heading-style
      // weight as PrimaryFocusCard. The dashboard already supplies enough
      // visual rhythm; another bordered widget here was double-charging the
      // hierarchy.
      background: "transparent",
      padding: "0",
      marginBottom: 16,
      fontFamily: FONT,
      display: "flex", flexDirection: "column", gap: 18,
    }}>
      {isLoading && !tree ? (
        <FocusesSkeleton />
      ) : (
        <FocusesSection
          focuses={tree?.focuses ?? []}
          onChange={refresh}
        />
      )}
    </div>
  );
}

function FocusesSkeleton() {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#1C1C1E", opacity: 0.4 }} />
        <span style={{
          fontSize: 11, color: "#8E8E93", textTransform: "uppercase",
          letterSpacing: 0.6, fontWeight: 600,
        }}>Focuses</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{
            border: "0.5px solid rgba(0,0,0,0.06)", borderRadius: 8,
            padding: "8px 12px", background: "#fff",
            display: "flex", alignItems: "center", gap: 10,
          }}>
            <Skeleton width={16} height={16} radius={4} />
            <Skeleton width={`${50 + i * 10}%`} height={13} />
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionHeader({ label, right }: {
  label: string;
  right?: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
    }}>
      <span style={{
        fontSize: 11, color: "#8E8E93", textTransform: "uppercase",
        letterSpacing: 0.6, fontWeight: 600,
      }}>{label}</span>
      {right && (
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#8E8E93" }}>
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

  // Done collapsed entirely now per UX critique — single tally line.

  return (
    <div>
      <SectionHeader label="Focuses" right={
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

        {done.length > 0 && (
          <DoneSection done={done} onChange={onChange} />
        )}
      </div>
    </div>
  );
}

function DoneSection({
  done, onChange,
}: { done: ApiItemNode[]; onChange: () => void }) {
  // Daniel's UX critique: Done was competing with active focuses. Now it
  // collapses behind a single muted line — open to expand the full list.
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          fontSize: 11.5, color: "#8E8E93",
          background: "transparent", border: "none",
          padding: "4px 0", cursor: "pointer", fontFamily: FONT,
          textAlign: "left",
        }}
      >
        {open ? `− hide ${done.length} completed` : `${done.length} completed`}
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
          {done.map((f) => (
            <Item key={f.id} node={f} onChange={onChange} variant="done" />
          ))}
        </div>
      )}
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
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const t = text.trim();
    if (!t) { setActive(false); return; }
    setBusy(true);
    try {
      await createItem({ text: t, committed: true });
      setText("");
      onCreated();
    } catch (e) { console.error(e); }
    finally { setBusy(false); setActive(false); }
  }

  // Quiet text-link by default — secondary action shouldn't compete with the
  // active focus list. Click reveals an inline borderless input.
  if (!active) {
    return (
      <button
        onClick={() => setActive(true)}
        style={{
          alignSelf: "flex-start", marginTop: 2,
          fontSize: 12, color: "#8E8E93",
          background: "transparent", border: "none",
          padding: "4px 0", cursor: "pointer", fontFamily: FONT,
        }}
      >+ add focus</button>
    );
  }
  return (
    <input
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={submit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !busy) submit();
        if (e.key === "Escape") { setText(""); setActive(false); }
      }}
      placeholder="focus name…"
      style={{
        fontSize: 13, padding: "4px 0",
        border: "none", borderBottom: "1px solid rgba(0,0,0,0.18)",
        background: "transparent",
        fontFamily: FONT, color: "#1C1C1E",
        outline: "none", marginTop: 2,
        width: "100%", boxSizing: "border-box",
      }}
    />
  );
}
