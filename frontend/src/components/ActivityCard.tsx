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
          fontSize: 11, color: "var(--gooni-muted, #8E8E93)", textTransform: "uppercase",
          letterSpacing: 0.6, fontWeight: 600,
        }}>Focuses</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{
            border: "0.5px solid rgba(0,0,0,0.06)", borderRadius: 8,
            padding: "8px 12px", background: "var(--gooni-card, #fff)",
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
        fontSize: 11, color: "var(--gooni-muted, #8E8E93)", textTransform: "uppercase",
        letterSpacing: 0.6, fontWeight: 600,
      }}>{label}</span>
      {right && (
        <span style={{ fontSize: 12, color: "var(--gooni-muted, #8E8E93)" }}>
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
          <span style={{ fontSize: 11, color: "var(--gooni-muted, #8E8E93)", fontWeight: 500 }}>
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
      {/* Single shared card for all focus rows (active, someday, done).
          Inner separators between rows; per-row borders dropped. Inline
          adder lives at the top of the card so it's near the +add button
          and feels like a quick-capture lane. */}
      <div style={{
        background: "var(--gooni-card, #FFFFFF)",
        border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
        borderRadius: 10,
        overflow: "hidden",
      }}>
        {adding && (
          <div style={{
            padding: 10,
            borderBottom: active.length > 0 ? "0.5px solid rgba(0,0,0,0.06)" : "none",
            background: "#FAFAFA",
          }}>
            <FocusAdderForm
              seed={seed}
              onClose={() => { setAdding(false); setSeed(null); }}
              onCreated={() => { setAdding(false); setSeed(null); onChange(); }}
            />
          </div>
        )}
        {active.length === 0 && !adding ? (
          <div style={{
            padding: "16px 12px", fontSize: 12, color: "#AEAEB2",
            textAlign: "center",
          }}>
            no focuses yet — click + add or ✦ suggest
          </div>
        ) : (
          <SeparatedList>
            <ReorderableList items={active} onChange={onChange} />
          </SeparatedList>
        )}

        {someday.length > 0 && (
          <CollapsibleSection
            label={`${someday.length} someday`}
            topBorder={active.length > 0 || adding}
          >
            <SeparatedList>
              {someday.map((f) => (
                <FocusRow key={f.id} node={f} onChange={onChange} />
              ))}
            </SeparatedList>
          </CollapsibleSection>
        )}

        {done.length > 0 && (
          <CollapsibleSection
            label={`${done.length} completed`}
            topBorder
          >
            <SeparatedList>
              {done.map((f) => (
                <FocusRow key={f.id} node={f} onChange={onChange} variant="done" />
              ))}
            </SeparatedList>
          </CollapsibleSection>
        )}
      </div>
    </div>
  );
}

// Wraps a list of children with thin separators between siblings — used to
// make rows inside the focuses card feel like one continuous list rather
// than independent boxes.
function SeparatedList({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="gooni-focus-list"
      style={{ display: "flex", flexDirection: "column" }}
    >
      <style>{`
        .gooni-focus-list > * + * {
          border-top: 0.5px solid rgba(0,0,0,0.06);
        }
      `}</style>
      {children}
    </div>
  );
}

function CollapsibleSection({
  label, topBorder, children,
}: { label: string; topBorder?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{
      borderTop: topBorder ? "0.5px solid rgba(0,0,0,0.06)" : "none",
    }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%", textAlign: "left",
          padding: "8px 12px",
          background: "transparent", border: "none",
          fontFamily: FONT, fontSize: 11.5, color: "var(--gooni-muted, #8E8E93)",
          cursor: "pointer",
        }}
      >
        {open ? `− hide ${label}` : `▸ ${label}`}
      </button>
      {open && children}
    </div>
  );
}

function resolveStatus(n: ApiItemNode): FocusStatus {
  if (n.status) return n.status;
  if (!n.committed) return "someday";
  return n.stale ? "pending" : "committed";
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
      {/* Top drop slot only renders mid-drag — keeps the card chrome
          uncluttered when nobody's dragging. */}
      {draggingId != null && (
        <DropSlot
          active={hoverIdx === 0}
          onEnter={() => setHoverIdx(0)}
          onDrop={() => { commitReorder(0); setHoverIdx(null); }}
        />
      )}
      {items.map((f, i) => (
        <div key={f.id}>
          <FocusRow
            node={f}
            onChange={onChange}
            draggable={!f.done}
            onDragStart={() => setDraggingId(f.id)}
            onDragEnd={() => { setDraggingId(null); setHoverIdx(null); }}
            separator={i > 0}
          />
          {draggingId != null && (
            <DropSlot
              active={draggingId !== f.id && hoverIdx === i + 1}
              onEnter={() => setHoverIdx(i + 1)}
              onDrop={() => { commitReorder(i + 1); setHoverIdx(null); }}
            />
          )}
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
  // Compact 2-line inline form: name + status segmented + 3 action buttons.
  // Anything richer (end goal, scale, due date) lives in the focus modal —
  // click the row after add to fill those in. Keeps quick-capture fast.
  const [text, setText] = useState(seed?.text ?? "");
  const [status, setStatus] = useState<FocusStatus>("committed");
  // seed lingers so suggest can still preload endgoal/scale even though
  // they don't render here — we pass them through on submit.
  const [busy, setBusy] = useState<"add" | "primary" | null>(null);

  async function submit(asPrimary: boolean) {
    const t = text.trim();
    if (!t) return;
    setBusy(asPrimary ? "primary" : "add");
    try {
      await createItem({
        text: t,
        endgoal: seed?.endgoal || null,
        scale: seed?.scale ?? null,
        status,
        committed: status !== "someday",
        is_primary: asPrimary,
      });
      onCreated();
    } catch (e) { console.error(e); }
    finally { setBusy(null); }
  }

  const canSubmit = !!text.trim() && busy === null;

  return (
    <div
      style={{
        display: "flex", flexDirection: "column", gap: 8,
        fontFamily: FONT,
      }}
    >
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit(false);
          if (e.key === "Escape") onClose();
        }}
        placeholder="focus name"
        style={{
          fontSize: 14, padding: "8px 10px",
          border: "0.5px solid rgba(0,0,0,0.12)", borderRadius: 6,
          background: "#FFF", fontFamily: FONT, color: "var(--gooni-text, #1C1C1E)",
          outline: "none",
        }}
      />
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 10, flexWrap: "wrap",
      }}>
        <Segmented<FocusStatus>
          value={status}
          onChange={setStatus}
          options={[
            { value: "committed", label: "committed" },
            { value: "pending",   label: "pending" },
            { value: "someday",   label: "someday" },
          ]}
        />
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button
            onClick={onClose}
            style={{
              fontSize: 12, padding: "6px 10px",
              background: "transparent", border: "none",
              color: "var(--gooni-muted, #8E8E93)", cursor: "pointer", fontFamily: FONT,
            }}
          >cancel</button>
          <button
            onClick={() => submit(true)}
            disabled={!canSubmit}
            title="create and pin this as primary"
            style={{
              fontSize: 12, padding: "6px 11px",
              background: "transparent",
              color: !canSubmit ? "#C7C7CC" : "#15803D",
              border: `0.5px solid ${!canSubmit ? "rgba(0,0,0,0.08)" : "#86EFAC"}`,
              borderRadius: 6, fontWeight: 600,
              cursor: !canSubmit ? "not-allowed" : "pointer",
              fontFamily: FONT,
            }}
          >{busy === "primary" ? "adding…" : "set primary"}</button>
          <button
            onClick={() => submit(false)}
            disabled={!canSubmit}
            style={{
              fontSize: 12, padding: "6px 14px",
              background: !canSubmit ? "#E4E4E7" : "#1C1C1E",
              color: !canSubmit ? "#9CA3AF" : "#FFF",
              border: "none", borderRadius: 6, fontWeight: 600,
              cursor: !canSubmit ? "not-allowed" : "pointer",
              fontFamily: FONT,
            }}
          >{busy === "add" ? "adding…" : "add"}</button>
        </div>
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
