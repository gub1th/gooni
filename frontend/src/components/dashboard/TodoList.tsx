import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Crown, Plus, AlertTriangle, ArrowUpRight, ArrowLeft } from "lucide-react";
import {
  fetchTodos, createTodo, updateTodo, cycleTodoState, deleteTodo,
  promoteTodoToPrimary, fetchFocuses,
  type ApiTodo, type ApiTodoBundle, type ApiFocus, type TodoState,
  type TodoChainMeta,
} from "../../services/api";
import { resolveFocusColor } from "../../utils/focusColors";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";
import { TodoEditModal } from "./TodoEditModal";
import { TodoChainView } from "./TodoChainView";

// TodoList — dashboard todos block. Mockup-aligned shape:
//
//   ┌ Primary card (thick info-blue border, crown, hollow check, age, focus dot)
//   │   Crown is CLICKABLE → demote primary back to a regular open todo.
//   ├ Header row: TODAY'S TODOS · X/Y · "+" button
//   ├ Open todos w/ tinted age pills (today=green / yesterday=amber / N days=red+icon)
//   ├ Inline create row at bottom ("Add a todo…" + tiny "todo" pill)
//   └ Done section: "DONE TODAY" header, dimmed rows w/ filled grey check
//
// 3-state cycle (not_yet → doing → done) is one click; Done state pops a
// state-picker so a misclick is recoverable.

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

const CASCADE_STAGGER_MS = 80;

const AGE_TINTS = {
  today:     { bg: "#E1F5EE", fg: "#085041" },
  yesterday: { bg: "#FAEEDA", fg: "#854F0B" },
  stale:     { bg: "#FCEBEB", fg: "#791F1F" },
} as const;

interface Props {
  onOpenSourceNote?: (noteId: number) => void;
}

function ageHint(iso: string | null): { label: string; tint: keyof typeof AGE_TINTS } | null {
  if (!iso) return null;
  const created = new Date(iso);
  if (Number.isNaN(created.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(created); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86400000);
  // G3.5-polish: drop the today pill. "Today" is the default frame of
  // reference — fresh todos shouldn't carry a green confirmation chip.
  // The color signal is now reserved for late states (yesterday + stale),
  // matching Claude's reference aesthetic where status colors earn their
  // slot. Returns null so the AgePill render path skips entirely.
  if (diff <= 0) return null;
  if (diff === 1) return { label: "yesterday", tint: "yesterday" };
  return { label: `${diff} days`, tint: "stale" };
}

export function TodoList({ onOpenSourceNote: _onOpenSourceNote }: Props) {
  const qc = useQueryClient();
  const { data: bundle } = useQuery<ApiTodoBundle>({
    queryKey: ["todos-bundle"],
    queryFn: fetchTodos,
  });
  const { data: focuses } = useQuery<ApiFocus[]>({
    queryKey: ["focuses"],
    queryFn: fetchFocuses,
  });

  const focusById = useMemo(() => {
    const m = new Map<number, ApiFocus>();
    for (const f of focuses ?? []) m.set(f.id, f);
    return m;
  }, [focuses]);

  // Cascade-done staggered fade for batched check-offs.
  const [cascadeIds, setCascadeIds] = useState<number[]>([]);
  const cascadeTimersRef = useRef<Record<number, number>>({});

  const refresh = () => qc.invalidateQueries({ queryKey: ["todos-bundle"] });

  function scheduleCascade(id: number) {
    setCascadeIds((arr) => (arr.includes(id) ? arr : [...arr, id]));
    cascadeTimersRef.current[id] = window.setTimeout(() => {
      setCascadeIds((arr) => arr.filter((i) => i !== id));
      delete cascadeTimersRef.current[id];
    }, 600 + (Object.keys(cascadeTimersRef.current).length * CASCADE_STAGGER_MS));
  }

  useEffect(() => {
    return () => {
      for (const id of Object.keys(cascadeTimersRef.current)) {
        clearTimeout(cascadeTimersRef.current[Number(id)]);
      }
    };
  }, []);

  async function onCycle(t: ApiTodo) {
    if (t.state === "done") return;
    try {
      const next = await cycleTodoState(t.id);
      if (next.state === "done") scheduleCascade(t.id);
      refresh();
    } catch (e) { console.error("cycle todo failed", e); }
  }

  async function onPickState(id: number, state: TodoState) {
    try { await updateTodo(id, { state }); refresh(); } catch (e) { console.error(e); }
  }

  async function onPromotePrimary(id: number) {
    try { await promoteTodoToPrimary(id); refresh(); } catch (e) { console.error(e); }
  }

  async function onDemotePrimary(id: number) {
    // Crown click on the primary row sets is_primary=false. Server
    // doesn't enforce a "must have a primary" invariant — the slot can
    // sit empty until Daniel promotes another todo.
    try { await updateTodo(id, { is_primary: false }); refresh(); } catch (e) { console.error(e); }
  }

  async function onDelete(id: number) {
    try { await deleteTodo(id); refresh(); } catch (e) { console.error(e); }
  }

  // Inline-create state.
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (creating) inputRef.current?.focus(); }, [creating]);

  // Chain view modal — opens via ↗ indicator click OR "from:" line
  // click. Null = closed. G3.5 Surface B + D entry point.
  const [chainViewId, setChainViewId] = useState<number | null>(null);

  // Edit modal — click into a card body opens the full-details view.
  const [editingId, setEditingId] = useState<number | null>(null);
  const editing: ApiTodo | null = useMemo(() => {
    if (editingId == null) return null;
    if (bundle?.primary?.id === editingId) return bundle.primary;
    return (bundle?.open.find((t) => t.id === editingId)
      ?? bundle?.done_today.find((t) => t.id === editingId)
      ?? null);
  }, [editingId, bundle]);

  async function onSubmitNew() {
    const text = draft.trim();
    if (!text) { setCreating(false); setDraft(""); return; }
    try {
      await createTodo({ text });
      setDraft("");
      refresh();
    } catch (e) { console.error(e); }
  }

  if (!bundle) {
    return (
      <div style={{ height: 60, opacity: 0.4, fontFamily: FONT, fontSize: 12, color: "#8E8E93" }}>
        loading todos…
      </div>
    );
  }

  const openCount = bundle.open.length + (bundle.primary ? 1 : 0);
  const doneCount = bundle.done_today.length;
  const totalToday = openCount + doneCount;

  return (
    <div style={{ fontFamily: FONT }}>
      <style>{`
        @keyframes gooni-todo-fade-out {
          0%   { opacity: 1; transform: translateX(0);   }
          80%  { opacity: 0.4; transform: translateX(8px); }
          100% { opacity: 0; transform: translateX(12px); }
        }
        .gooni-todo-row { transition: background 0.12s; }
        .gooni-todo-row:hover { background: rgba(0,0,0,0.025); }
        .gooni-todo-cascade { animation: gooni-todo-fade-out 600ms ease forwards; }

        /* Doing-state indicator pulse — subtle breathing. Conveys
           "active, in motion" without the visual loudness of a spinner.
           Matches Claude minimal aesthetic. */
        @keyframes gooni-doing-pulse {
          0%, 100% { transform: scale(1.0); opacity: 0.92; }
          50%      { transform: scale(1.10); opacity: 1.0;  }
        }
        .gooni-doing-dot {
          animation: gooni-doing-pulse 1.8s ease-in-out infinite;
        }

        /* Primary-todo card border: a single soft yellow stroke draws
           itself around the perimeter clockwise from the top-left,
           carrying its own drop-shadow so the glow lights up the card
           piece-by-piece as the line crosses — instead of the old
           "bullet zooms across an already-lit halo" effect. Once
           complete the stroke + halo persist as the card's signature
           treatment, and a slow breathing pulse keeps it alive without
           competing for attention.

           Uses pathLength=1000 so dashoffset math is resolution-
           independent on the rect, even with rx rounded corners. */
        @keyframes gooni-primary-trace-draw {
          0%   { stroke-dashoffset: 1000; }
          100% { stroke-dashoffset: 0;    }
        }
        @keyframes gooni-primary-trace-breath {
          0%, 100% { filter: drop-shadow(0 0 4px rgba(245,200,73,0.45)) drop-shadow(0 0 10px rgba(245,200,73,0.22)); }
          50%      { filter: drop-shadow(0 0 6px rgba(245,200,73,0.60)) drop-shadow(0 0 14px rgba(245,200,73,0.32)); }
        }
        .gooni-primary-trace {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          overflow: visible;
        }
        .gooni-primary-trace rect {
          fill: none;
          stroke: #F5C849;
          stroke-width: 1.4;
          stroke-linecap: round;
          stroke-dasharray: 1000;
          stroke-dashoffset: 1000;
          /* Draw once (forwards = stay drawn), then settle into a slow
             breathing halo. Delay the breath so it doesn't fight the
             draw mid-flight. */
          animation:
            gooni-primary-trace-draw 1800ms cubic-bezier(0.22, 0.61, 0.36, 1) forwards,
            gooni-primary-trace-breath 4200ms ease-in-out 1800ms infinite;
          filter: drop-shadow(0 0 4px rgba(245,200,73,0.55)) drop-shadow(0 0 10px rgba(245,200,73,0.25));
        }
      `}</style>

      {/* Counter + add button moved to the TOP per Daniel's redesign —
          progress should be the first thing the eye lands on, above the
          actionable cards. */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "flex-end",
        margin: "0 4px 8px", gap: 8,
      }}>
        <span style={{
          fontSize: 12, color: "var(--gooni-muted, #9CA3AF)",
          fontVariantNumeric: "tabular-nums",
        }}>
          {doneCount} / {totalToday}
        </span>
        <button
          onClick={() => setCreating(true)}
          title="Add a todo"
          style={{
            width: 24, height: 24, borderRadius: 6,
            background: "rgba(15,110,86,0.12)",
            color: "#0F6E56",
            border: "none", cursor: "pointer",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Primary + Active as ONE GROUP — "what I'm focused on right now."
          Primary always tops the group (exception for state='not_yet'
          primary still applies — it sits here, not in pending). Tight
          gap (4px) so primary and active read as related, not separated. */}
      {(() => {
        const activeOpen = bundle.open.filter((t) => t.state === "doing");
        const pendingOpen = bundle.open.filter((t) => t.state !== "doing");
        const hasFocusedGroup = !!bundle.primary || activeOpen.length > 0;
        return (
          <>
            {hasFocusedGroup && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {bundle.primary && (
                  <PrimaryCard
                    t={bundle.primary}
                    focus={bundle.primary.focus_id ? focusById.get(bundle.primary.focus_id) ?? null : null}
                    cascade={cascadeIds.includes(bundle.primary.id)}
                    chainMeta={bundle.chain_summary?.[bundle.primary.id]}
                    onCycle={() => onCycle(bundle.primary!)}
                    onPickState={(s) => onPickState(bundle.primary!.id, s)}
                    onDemote={() => onDemotePrimary(bundle.primary!.id)}
                    onDelete={() => onDelete(bundle.primary!.id)}
                    onOpenEdit={() => setEditingId(bundle.primary!.id)}
                    onOpenChain={(id) => setChainViewId(id)}
                  />
                )}
                {activeOpen.map((t) => (
                  <TodoRow
                    key={t.id}
                    t={t}
                    focus={t.focus_id ? focusById.get(t.focus_id) ?? null : null}
                    cascade={cascadeIds.includes(t.id)}
                    chainMeta={bundle.chain_summary?.[t.id]}
                    subdued={false}
                    onCycle={() => onCycle(t)}
                    onPickState={(s) => onPickState(t.id, s)}
                    onPromotePrimary={() => onPromotePrimary(t.id)}
                    onDelete={() => onDelete(t.id)}
                    onOpenEdit={() => setEditingId(t.id)}
                    onOpenChain={(id) => setChainViewId(id)}
                  />
                ))}
              </div>
            )}
            {pendingOpen.length > 0 && (
              <div
                style={{
                  display: "flex", flexDirection: "column", gap: 0,
                  marginTop: hasFocusedGroup ? 10 : 0,
                }}
              >
                {pendingOpen.map((t) => (
                  <TodoRow
                    key={t.id}
                    t={t}
                    focus={t.focus_id ? focusById.get(t.focus_id) ?? null : null}
                    cascade={cascadeIds.includes(t.id)}
                    chainMeta={bundle.chain_summary?.[t.id]}
                    subdued={true}
                    onCycle={() => onCycle(t)}
                    onPickState={(s) => onPickState(t.id, s)}
                    onPromotePrimary={() => onPromotePrimary(t.id)}
                    onDelete={() => onDelete(t.id)}
                    onOpenEdit={() => setEditingId(t.id)}
                    onOpenChain={(id) => setChainViewId(id)}
                  />
                ))}
              </div>
            )}
          </>
        );
      })()}

      {/* Inline create row — always visible per mockup. Click anywhere
          to focus the input; ESC collapses back to the placeholder hint. */}
      <div
        onClick={() => setCreating(true)}
        style={{
          padding: "10px 16px",
          display: "flex", alignItems: "center", gap: 12,
          opacity: creating ? 1 : 0.55,
          borderBottom: "0.5px solid rgba(0,0,0,0.06)",
          cursor: "text",
          marginTop: 2,
        }}
      >
        <Plus size={14} color="#9CA3AF" />
        {creating ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void onSubmitNew(); }
              if (e.key === "Escape") { e.preventDefault(); setCreating(false); setDraft(""); }
            }}
            onBlur={() => { if (!draft.trim()) setCreating(false); }}
            placeholder="What needs doing?"
            style={{
              flex: 1, border: "none", outline: "none",
              fontFamily: FONT, fontSize: 13, background: "transparent",
              color: "var(--gooni-text, #1C1C1E)",
            }}
          />
        ) : (
          <span style={{
            flex: 1, fontSize: 13,
            color: "var(--gooni-muted, #9CA3AF)",
          }}>
            Add a todo...
          </span>
        )}
        <span style={{
          fontSize: 11,
          color: "var(--gooni-muted, #9CA3AF)",
          background: "rgba(0,0,0,0.05)",
          padding: "2px 8px", borderRadius: 99,
        }}>
          todo
        </span>
      </div>

      {bundle.done_today.length > 0 && (
        <DoneSection
          todos={bundle.done_today}
          focusById={focusById}
          chainSummary={bundle.chain_summary}
          onOpenEdit={(id) => setEditingId(id)}
          onOpenChain={(id) => setChainViewId(id)}
        />
      )}

      {editing && (
        <TodoEditModal
          todo={editing}
          focuses={focuses ?? []}
          chainMeta={bundle?.chain_summary?.[editing.id]}
          onClose={() => setEditingId(null)}
          onOpenChain={(id) => { setEditingId(null); setChainViewId(id); }}
        />
      )}

      {chainViewId !== null && (
        <TodoChainView
          todoId={chainViewId}
          onClose={() => setChainViewId(null)}
          onMutate={refresh}
        />
      )}
    </div>
  );
}

// ── Primary card ─────────────────────────────────────────────────────────

function PrimaryCard({
  t, focus, cascade, chainMeta,
  onCycle, onPickState, onDemote, onDelete, onOpenEdit, onOpenChain,
}: {
  t: ApiTodo;
  focus: ApiFocus | null;
  cascade: boolean;
  chainMeta?: TodoChainMeta;
  onCycle: () => void;
  onPickState: (s: TodoState) => void;
  onDemote: () => void;
  onDelete: () => void;
  onOpenEdit: () => void;
  onOpenChain: (id: number) => void;
}) {
  const dotColor = resolveFocusColor(focus?.color ?? null, focus?.id ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Trace-border lives forever once the card is primary, but we key it
  // on todo id so promoting a different todo re-runs the draw animation
  // from scratch (the React key flip forces a remount of the SVG layer).

  return (
    <div>
    <div
      className={cascade ? "gooni-todo-cascade" : ""}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        background: "var(--gooni-card, #FFFFFF)",
        // No yellow border or glow at mount — the SVG trace paints both
        // in as it draws. A whisper-faint elevation shadow keeps the
        // card legible against the dashboard backdrop.
        border: "0.5px solid rgba(0,0,0,0.05)",
        borderRadius: 12,
        padding: "12px 16px",
        display: "flex", alignItems: "center", gap: 12,
        fontFamily: FONT,
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      <svg
        key={t.id}
        className="gooni-primary-trace"
        aria-hidden
        preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Rect rides the card edge itself; rx 12 matches the card's
            borderRadius. pathLength normalizes the rounded perimeter
            so the dashoffset math is just "1000 → 0". */}
        <rect x="0" y="0" width="100%" height="100%" rx="12" ry="12" pathLength={1000} />
      </svg>
      <button
        onClick={(e) => { e.stopPropagation(); onDemote(); }}
        title="Demote — clear primary"
        aria-label="Demote primary"
        style={{
          border: "none", background: "transparent",
          color: "#BA7517", cursor: "pointer",
          display: "flex", alignItems: "center", padding: 0,
        }}
      >
        <Crown size={16} fill="currentColor" strokeWidth={1.5} />
      </button>

      <span onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center" }}>
        <Checkbox
          state={t.state}
          onClick={() => {
            if (t.state === "done") setPickerOpen(true);
            else onCycle();
          }}
          size="lg"
        />
      </span>

      <span
        onClick={onOpenEdit}
        title="Click to edit"
        style={{
          flex: 1, fontSize: 15, fontWeight: 500,
          color: "var(--gooni-text, #1C1C1E)",
          textDecoration: t.state === "done" ? "line-through" : "none",
          opacity: t.state === "done" ? 0.55 : 1,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          cursor: "pointer",
        }}
      >
        {t.text}
      </span>

      {chainMeta && chainMeta.children_total > 0 && (
        <ChainIndicator
          meta={chainMeta}
          onClick={(e) => { e.stopPropagation(); onOpenChain(t.id); }}
        />
      )}

      {/* Continuously-running timer — primary-only. Replaces the static
          AgePill non-primary rows use. Scales seconds → minutes → hours
          → days and caps at days (no week/month rollup). Tick cadence
          scales with elapsed time so we don't re-render every second
          forever. Hidden when done since the primary auto-clears on done. */}
      {t.state !== "done" && <LiveTimer since={t.created_at} />}

      {focus && (
        <span
          title={focus.text}
          style={{
            width: 8, height: 8, borderRadius: "50%",
            background: dotColor, flexShrink: 0,
          }}
        />
      )}

      {hovered && (
        <span onClick={(e) => e.stopPropagation()}>
          <ConfirmDeleteButton onConfirm={onDelete} />
        </span>
      )}

      {pickerOpen && (
        <StatePicker
          current={t.state}
          onPick={(s) => { onPickState(s); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
    {chainMeta?.parent_id && (
      <FromLine
        parentId={chainMeta.parent_id}
        parentText={chainMeta.parent_text}
        onOpenChain={onOpenChain}
      />
    )}
    </div>
  );
}

// Continuously-updating elapsed-time pill. Tier cadence is tied to the
// elapsed bucket: re-render every 1s while under a minute, every 30s
// under an hour, every minute under a day, every hour beyond. Caps at
// days (no week/month — primary todos lingering past days should
// surface a different signal, not a bigger number).
function LiveTimer({ since }: { since: string | null }) {
  const start = useMemo(() => {
    if (!since) return null;
    const ms = new Date(since).getTime();
    return Number.isFinite(ms) ? ms : null;
  }, [since]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (start == null) return;
    let id: number | null = null;
    function tick() {
      const elapsed = Date.now() - start!;
      const next =
        elapsed < 60_000 ? 1000 :
        elapsed < 3_600_000 ? 30_000 :
        elapsed < 86_400_000 ? 60_000 :
        3_600_000;
      setNow(Date.now());
      id = window.setTimeout(tick, next);
    }
    tick();
    return () => { if (id != null) clearTimeout(id); };
  }, [start]);

  if (start == null) return null;
  const elapsed = Math.max(0, now - start);
  const label =
    elapsed < 60_000 ? `${Math.floor(elapsed / 1000)}s` :
    elapsed < 3_600_000 ? `${Math.floor(elapsed / 60_000)}m` :
    elapsed < 86_400_000 ? `${Math.floor(elapsed / 3_600_000)}h` :
    `${Math.floor(elapsed / 86_400_000)}d`;

  return (
    <span
      title={`Primary for ${label}`}
      style={{
        display: "inline-flex", alignItems: "center",
        fontSize: 11,
        color: "#0F6E56",
        background: "rgba(15,110,86,0.10)",
        padding: "2px 8px", borderRadius: 99,
        flexShrink: 0,
        fontVariantNumeric: "tabular-nums",
        fontWeight: 500,
      }}
    >
      {label}
    </span>
  );
}

// ── Single open row ──────────────────────────────────────────────────────

function TodoRow({
  t, focus, cascade, chainMeta, subdued = false,
  onCycle, onPickState, onPromotePrimary, onDelete, onOpenEdit, onOpenChain,
}: {
  t: ApiTodo;
  focus: ApiFocus | null;
  cascade: boolean;
  chainMeta?: TodoChainMeta;
  // When true, render as a plain-row (no card chrome) — used for
  // state='not_yet' so the "I'm doing this" todos stand out above the
  // pile. Active todos pass subdued=false and keep the elevated card
  // treatment.
  subdued?: boolean;
  onCycle: () => void;
  onPickState: (s: TodoState) => void;
  onPromotePrimary: () => void;
  onDelete: () => void;
  onOpenEdit: () => void;
  onOpenChain: (id: number) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const dotColor = resolveFocusColor(focus?.color ?? null, focus?.id ?? null);
  const age = ageHint(t.created_at);

  return (
    // Outer wrapper carries hover state so the OrphanLinkHint sitting
    // BELOW the row stays mounted while the cursor is anywhere in this
    // todo's territory. Pre-fix the hover lived on the inner row only —
    // mouse moving down to click the hint caused it to vanish.
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
    <div
      className={`gooni-todo-row${cascade ? " gooni-todo-cascade" : ""}`}
      style={{
        position: "relative",
        background: subdued ? "transparent" : "var(--gooni-card, #FFFFFF)",
        border: subdued ? "none" : "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
        borderRadius: subdued ? 0 : 8,
        padding: subdued ? "7px 12px" : "10px 16px",
        display: "flex", alignItems: "center", gap: 12,
      }}
    >
      <span onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center" }}>
        <Checkbox
          state={t.state}
          onClick={() => {
            if (t.state === "done") setPickerOpen(true);
            else onCycle();
          }}
        />
      </span>

      <span
        onClick={onOpenEdit}
        title="Click to edit"
        style={{
          flex: 1, minWidth: 0,
          fontSize: 15, color: "var(--gooni-text, #1C1C1E)",
          textDecoration: t.state === "done" ? "line-through" : "none",
          opacity: t.state === "done" ? 0.55 : 1,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          cursor: "pointer",
        }}
      >
        {t.text}
      </span>

      {chainMeta && chainMeta.children_total > 0 && (
        <ChainIndicator
          meta={chainMeta}
          onClick={(e) => { e.stopPropagation(); onOpenChain(t.id); }}
        />
      )}

      {age && t.state !== "done" && <AgePill age={age} />}

      {focus && (
        <span
          title={focus.text}
          style={{
            width: 8, height: 8, borderRadius: "50%",
            background: dotColor, flexShrink: 0,
          }}
        />
      )}

      {hovered && (
        <button
          title="Make primary"
          onClick={(e) => { e.stopPropagation(); onPromotePrimary(); }}
          style={{
            border: "none", background: "transparent", cursor: "pointer",
            padding: 2, color: "#9CA3AF", display: "flex",
          }}
        >
          <Crown size={12} />
        </button>
      )}
      {hovered && (
        <span onClick={(e) => e.stopPropagation()}>
          <ConfirmDeleteButton onConfirm={onDelete} />
        </span>
      )}

      {pickerOpen && (
        <StatePicker
          current={t.state}
          onPick={(s) => { onPickState(s); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
    {chainMeta?.parent_id && (
      <FromLine
        parentId={chainMeta.parent_id}
        parentText={chainMeta.parent_text}
        onOpenChain={onOpenChain}
      />
    )}
    {!chainMeta?.parent_id && hovered && (
      <OrphanLinkHint todoId={t.id} onOpenChain={onOpenChain} />
    )}
    </div>
  );
}

// ── G3.5 chain indicators + from-line + orphan link hint ─────────────────

function ChainIndicator({
  meta,
  onClick,
}: {
  meta: TodoChainMeta;
  onClick: (e: React.MouseEvent) => void;
}) {
  // ↗N ✓M — children_total spawn count, done count in muted green.
  return (
    <button
      onClick={onClick}
      title="View thread"
      style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        background: "transparent",
        border: "none",
        cursor: "pointer",
        padding: "2px 6px",
        borderRadius: 4,
        fontSize: 10,
        color: "var(--gooni-muted, #6B7280)",
        flexShrink: 0,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <ArrowUpRight size={10} />
      <span style={{ fontWeight: 600 }}>{meta.children_total}</span>
      {meta.children_done > 0 && (
        <>
          <span style={{ color: "#0F6E56", marginLeft: 2 }}>✓</span>
          <span style={{ color: "#0F6E56", fontWeight: 600 }}>
            {meta.children_done}
          </span>
        </>
      )}
    </button>
  );
}

function FromLine({
  parentId,
  parentText,
  onOpenChain,
}: {
  parentId: number;
  parentText: string | null;
  onOpenChain: (id: number) => void;
}) {
  const truncated = (parentText || "").length > 60
    ? (parentText || "").slice(0, 60).trim() + "…"
    : (parentText || "");
  return (
    <div
      onClick={() => onOpenChain(parentId)}
      style={{
        padding: "2px 16px 4px 42px",   // align under todo text column
        fontSize: 11,
        color: "var(--gooni-muted, #9CA3AF)",
        display: "flex", alignItems: "center", gap: 4,
        cursor: "pointer",
      }}
    >
      <ArrowLeft size={10} />
      <span style={{ opacity: 0.8 }}>from:</span>
      <span style={{ fontStyle: "italic" }}>{truncated}</span>
    </div>
  );
}

function OrphanLinkHint({
  todoId,
  onOpenChain,
}: {
  todoId: number;
  onOpenChain: (id: number) => void;
}) {
  // Hover affordance for orphan todos — opens chain view in parent-link
  // mode. The chain view's ParentLinkAffordance handles the search UI.
  return (
    <div
      onClick={() => onOpenChain(todoId)}
      style={{
        padding: "2px 16px 4px 42px",
        fontSize: 11,
        color: "var(--gooni-muted, #C0C4CC)",
        display: "flex", alignItems: "center", gap: 4,
        cursor: "pointer",
        opacity: 0.7,
      }}
    >
      <ArrowLeft size={10} />
      <span style={{ fontStyle: "italic" }}>link to parent todo…</span>
    </div>
  );
}

// ── Age pill ─────────────────────────────────────────────────────────────

function AgePill({ age }: { age: { label: string; tint: keyof typeof AGE_TINTS } }) {
  const { bg, fg } = AGE_TINTS[age.tint];
  const showWarn = age.tint === "stale";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 11, color: fg, background: bg,
      padding: "2px 8px", borderRadius: 99,
      flexShrink: 0,
    }}>
      {age.label}
      {showWarn && <AlertTriangle size={11} />}
    </span>
  );
}

// ── Checkbox cycler ──────────────────────────────────────────────────────

function Checkbox({ state, onClick, size = "md" }: {
  state: TodoState;
  onClick: () => void;
  size?: "md" | "lg";
}) {
  const dim = size === "lg" ? 16 : 16;
  const innerDim = size === "lg" ? 8 : 8;
  const common: React.CSSProperties = {
    width: dim, height: dim, borderRadius: "50%",
    flexShrink: 0, cursor: "pointer",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    fontFamily: FONT, fontSize: 11, lineHeight: 1,
    transition: "all 0.12s",
  };
  if (state === "done") {
    return (
      <span onClick={onClick} style={{
        ...common,
        background: "#9CA3AF", color: "#fff",
        border: "none",
      }}>✓</span>
    );
  }
  if (state === "doing") {
    // Match Claude reference: 2px terracotta ring + filled center dot
    // in the same color. Pulse animation on the inner dot — subtle
    // breathing (scale + opacity) at 1.8s/cycle. Conveys "actively in
    // motion" without spinner loudness.
    return (
      <span onClick={onClick} style={{
        ...common,
        background: "transparent",
        border: "2px solid #D85A30",
      }}>
        <span
          className="gooni-doing-dot"
          style={{
            width: innerDim, height: innerDim, borderRadius: "50%",
            background: "#D85A30",
          }}
        />
      </span>
    );
  }
  return (
    <span onClick={onClick} style={{
      ...common,
      background: "transparent",
      border: "1.5px solid rgba(0,0,0,0.22)",
    }} />
  );
}

// ── Done picker (popover on done row click) ──────────────────────────────

function StatePicker({ current, onPick, onClose }: {
  current: TodoState;
  onPick: (s: TodoState) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, zIndex: 50, background: "transparent",
      }} />
      <div style={{
        position: "absolute", right: 8, top: "100%", marginTop: 4, zIndex: 51,
        background: "#fff",
        border: "1px solid rgba(0,0,0,0.10)",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
        padding: 4, display: "flex", gap: 4,
        fontFamily: FONT,
      }}>
        {(["not_yet", "doing", "done"] as TodoState[]).map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            style={{
              border: "none", background: s === current ? "#F3F4F6" : "transparent",
              padding: "4px 8px", fontSize: 11, borderRadius: 6,
              cursor: "pointer", color: "#1C1C1E", textTransform: "capitalize",
            }}
          >
            {s.replace("_", " ")}
          </button>
        ))}
      </div>
    </>
  );
}

// ── Done section ─────────────────────────────────────────────────────────

function DoneSection({ todos, focusById, chainSummary, onOpenEdit, onOpenChain }: {
  todos: ApiTodo[];
  focusById: Map<number, ApiFocus>;
  chainSummary?: Record<number, TodoChainMeta>;
  onOpenEdit: (id: number) => void;
  onOpenChain: (id: number) => void;
}) {
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{
        margin: "0 4px 8px",
        fontSize: 12, fontWeight: 500, letterSpacing: 0.4,
        color: "var(--gooni-muted, #9CA3AF)",
      }}>
        DONE TODAY
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {todos.map((t) => {
          const focus = t.focus_id ? focusById.get(t.focus_id) ?? null : null;
          const dotColor = resolveFocusColor(focus?.color ?? null, focus?.id ?? null);
          const meta = chainSummary?.[t.id];
          return (
            <div key={t.id}>
            <div
              onClick={() => onOpenEdit(t.id)}
              title="Click to edit"
              style={{
                background: "var(--gooni-card, #FFFFFF)",
                border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
                borderRadius: 8,
                padding: "10px 16px",
                display: "flex", alignItems: "center", gap: 12,
                opacity: 0.45,
                cursor: "pointer",
              }}
            >
              <span style={{
                width: 16, height: 16, borderRadius: "50%",
                background: "#9CA3AF", color: "#fff",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, fontFamily: FONT, flexShrink: 0,
              }}>✓</span>
              <span style={{
                flex: 1, minWidth: 0,
                fontSize: 14, color: "var(--gooni-text, #1C1C1E)",
                textDecoration: "line-through",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}>{t.text}</span>
              {meta && meta.children_total > 0 && (
                <ChainIndicator
                  meta={meta}
                  onClick={(e) => { e.stopPropagation(); onOpenChain(t.id); }}
                />
              )}
              {focus && (
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />
              )}
            </div>
            {meta?.parent_id && (
              <FromLine
                parentId={meta.parent_id}
                parentText={meta.parent_text}
                onOpenChain={onOpenChain}
              />
            )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
