import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import {
  fetchItemTree, createItem, reorderItems, suggestFocus,
  type ApiItemTree, type ApiItemNode,
  type FocusScale, type FocusStatus,
} from "../services/api";
import { FocusRow } from "./FocusRow";
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

function SectionHeader({ label, right, actions }: {
  label: string;
  right?: React.ReactNode;
  actions?: React.ReactNode;
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
        <span style={{ fontSize: 12, color: "#8E8E93" }}>
          {right}
        </span>
      )}
      {actions && (
        <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          {actions}
        </span>
      )}
    </div>
  );
}

function HeaderButton({ label, onClick, disabled }: {
  label: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: "transparent", border: "none",
        fontFamily: FONT, fontSize: 11.5, color: disabled ? "#C7C7CC" : "#6B6B70",
        padding: "2px 8px", borderRadius: 6,
        cursor: disabled ? "wait" : "pointer", letterSpacing: 0.2,
      }}
    >{label}</button>
  );
}

function SuggestButton({ onSuggest }: {
  onSuggest: (s: { text: string; endgoal: string | null; scale: FocusScale | null }) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const s = await suggestFocus();
      if (s.text) onSuggest(s);
    } catch (e) { console.error(e); }
    finally { setBusy(false); }
  }
  return (
    <HeaderButton
      onClick={run}
      disabled={busy}
      label={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <Sparkles size={11} />
          {busy ? "thinking…" : "suggest"}
        </span>
      }
    />
  );
}

function FocusesSection({ focuses, onChange }: {
  focuses: ApiItemNode[];
  onChange: () => void;
}) {
  // Active = committed status (committed | pending). "someday" lives in the
  // collapsed parking lot below, not the main list.
  const active = focuses
    .filter((f) => !f.done && resolveStatus(f) !== "someday")
    .sort((a, b) => {
      // Primary always sits at the top.
      if (a.is_primary && !b.is_primary) return -1;
      if (!a.is_primary && b.is_primary) return 1;
      return a.sort_order - b.sort_order;
    });
  const someday = focuses.filter((f) => !f.done && resolveStatus(f) === "someday");
  // Done sorted by completed_at desc so most recent is on top.
  const done = focuses
    .filter((f) => f.done)
    .sort((a, b) => {
      const ta = a.completed_at ? new Date(a.completed_at).getTime() : 0;
      const tb = b.completed_at ? new Date(b.completed_at).getTime() : 0;
      return tb - ta;
    });
  const stale = active.filter((f) => resolveStatus(f) === "pending").length;

  const [adding, setAdding] = useState(false);
  const [seed, setSeed] = useState<{ text: string; endgoal: string | null; scale: FocusScale | null } | null>(null);

  return (
    <div>
      <SectionHeader
        label="Focuses"
        right={
          <span style={{ fontSize: 11, color: "#8E8E93", fontWeight: 500 }}>
            {active.length} active{stale > 0 ? ` · ${stale} stale` : ""}
          </span>
        }
        actions={
          <>
            <SuggestButton
              onSuggest={(s) => {
                setSeed({ text: s.text, endgoal: s.endgoal, scale: s.scale });
                setAdding(true);
              }}
            />
            <HeaderButton
              label="+ add"
              onClick={() => { setSeed(null); setAdding(true); }}
            />
          </>
        }
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <ReorderableList
          items={active}
          onChange={onChange}
        />

        {adding && (
          <FocusAdderForm
            seed={seed}
            onClose={() => { setAdding(false); setSeed(null); }}
            onCreated={() => { setAdding(false); setSeed(null); onChange(); }}
          />
        )}

        {someday.length > 0 && (
          <details style={{ marginTop: 6 }}>
            <summary style={{
              fontSize: 11, color: "#8E8E93", cursor: "pointer",
              padding: "4px 0", listStyle: "none",
            }}>
              ▸ {someday.length} someday
            </summary>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
              {someday.map((f) => (
                <FocusRow key={f.id} node={f} onChange={onChange} />
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

function resolveStatus(n: ApiItemNode): FocusStatus {
  if (n.status) return n.status;
  if (!n.committed) return "someday";
  return n.stale ? "pending" : "committed";
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
            <FocusRow key={f.id} node={f} onChange={onChange} variant="done" />
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
          <FocusRow
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

function FocusAdderForm({ seed, onCreated, onClose }: {
  seed: { text: string; endgoal: string | null; scale: FocusScale | null } | null;
  onCreated: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(seed?.text ?? "");
  const [endgoal, setEndgoal] = useState(seed?.endgoal ?? "");
  const [dueDate, setDueDate] = useState("");
  const [scale, setScale] = useState<FocusScale | "">(seed?.scale ?? "");
  const [status, setStatus] = useState<FocusStatus>("committed");
  const [isPrimary, setIsPrimary] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      await createItem({
        text: t,
        endgoal: endgoal.trim() || null,
        due_date: dueDate ? new Date(`${dueDate}T00:00:00`).toISOString() : null,
        scale: scale || null,
        status,
        committed: status !== "someday",
        is_primary: isPrimary,
      });
      onCreated();
    } catch (e) { console.error(e); }
    finally { setBusy(false); }
  }

  return (
    <div
      style={{
        marginTop: 4,
        padding: 12,
        background: "#FAFAFA",
        border: "0.5px solid rgba(0,0,0,0.08)",
        borderRadius: 8,
        display: "flex", flexDirection: "column", gap: 8,
        fontFamily: FONT,
      }}
    >
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onClose();
        }}
        placeholder="focus name"
        style={{
          fontSize: 14, padding: "6px 8px",
          border: "0.5px solid rgba(0,0,0,0.12)", borderRadius: 6,
          background: "#FFF", fontFamily: FONT, color: "#1C1C1E",
          outline: "none",
        }}
      />
      <input
        value={endgoal}
        onChange={(e) => setEndgoal(e.target.value)}
        placeholder="end goal (optional)"
        style={{
          fontSize: 13, padding: "5px 8px",
          border: "0.5px solid rgba(0,0,0,0.10)", borderRadius: 6,
          background: "#FFF", fontFamily: FONT, color: "#3C3C43",
          outline: "none",
        }}
      />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          title="target date"
          style={{
            fontSize: 12, padding: "4px 8px",
            border: "0.5px solid rgba(0,0,0,0.10)", borderRadius: 6,
            background: "#FFF", fontFamily: FONT, color: "#1C1C1E", outline: "none",
          }}
        />
        <select
          value={scale}
          onChange={(e) => setScale(e.target.value as FocusScale | "")}
          title="scale"
          style={{
            fontSize: 12, padding: "4px 8px",
            border: "0.5px solid rgba(0,0,0,0.10)", borderRadius: 6,
            background: "#FFF", fontFamily: FONT, color: "#1C1C1E", outline: "none",
          }}
        >
          <option value="">scale…</option>
          <option value="long_term">long-term</option>
          <option value="medium">medium</option>
          <option value="sprint">sprint</option>
        </select>
        <Segmented<FocusStatus>
          value={status}
          onChange={setStatus}
          options={[
            { value: "committed", label: "committed" },
            { value: "pending",   label: "pending" },
            { value: "someday",   label: "someday" },
          ]}
        />
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#3C3C43" }}>
        <input
          type="checkbox"
          checked={isPrimary}
          onChange={(e) => setIsPrimary(e.target.checked)}
        />
        make this my primary focus
      </label>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          onClick={onClose}
          style={{
            fontSize: 12, padding: "5px 10px",
            background: "transparent", border: "none",
            color: "#8E8E93", cursor: "pointer", fontFamily: FONT,
          }}
        >cancel</button>
        <button
          onClick={submit}
          disabled={busy || !text.trim()}
          style={{
            fontSize: 12, padding: "5px 12px",
            background: "#1C1C1E", color: "#FFF",
            border: "none", borderRadius: 6, fontWeight: 600,
            cursor: busy || !text.trim() ? "not-allowed" : "pointer",
            opacity: busy || !text.trim() ? 0.5 : 1,
            fontFamily: FONT,
          }}
        >{busy ? "adding…" : "add"}</button>
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  value, onChange, options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div style={{
      display: "inline-flex",
      border: "0.5px solid rgba(0,0,0,0.10)", borderRadius: 6,
      overflow: "hidden",
      fontFamily: FONT,
    }}>
      {options.map((opt) => {
        const sel = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              fontSize: 12, padding: "4px 10px",
              background: sel ? "#1C1C1E" : "#FFF",
              color: sel ? "#FFF" : "#6B6B70",
              border: "none", cursor: "pointer",
              fontFamily: FONT,
            }}
          >{opt.label}</button>
        );
      })}
    </div>
  );
}
