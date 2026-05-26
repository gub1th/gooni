import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Crown, GripVertical, Plus, X, AlertTriangle, ArrowUpRight, ArrowLeft, Paperclip } from "lucide-react";
import {
  fetchTodos, createTodo, updateTodo, cycleTodoState, deleteTodo,
  promoteTodoToPrimary, fetchFocuses,
  closeTodoWithOutcome, uploadAttachment,
  type ApiTodo, type ApiTodoBundle, type ApiFocus, type TodoState,
  type TodoChainMeta, type SpawnedTodoSpec,
} from "../../services/api";
import { resolveFocusColor } from "../../utils/focusColors";
import { parseServerDate } from "../../utils/date";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";
import { TodoEditModal } from "./TodoEditModal";
import { TodoChainView } from "./TodoChainView";
import { color as ctok, FONT } from "../../ui";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";

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


const CASCADE_STAGGER_MS = 80;

const AGE_TINTS = {
  today:     { bg: "#E1F5EE", fg: "#085041" },
  yesterday: { bg: "#FAEEDA", fg: "#854F0B" },
  stale:     { bg: "#FCEBEB", fg: "#791F1F" },
} as const;

// Dark variants: the light tints pair pale bg with DARK text, which is
// invisible on a dark card. Flip to a translucent tint + bright text so
// the green/amber/red semantic survives the theme.
const AGE_TINTS_DARK = {
  today:     { bg: "rgba(34,197,94,0.16)",  fg: "#4ADE80" },
  yesterday: { bg: "rgba(245,158,11,0.16)", fg: "#FBBF24" },
  stale:     { bg: "rgba(239,68,68,0.16)",  fg: "#F87171" },
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
  // Mockup-aligned: every open row carries an age pill so the eye can
  // scan freshness in one pass. "today" gets the soft green tint;
  // "yesterday" amber; ≥2 days red w/ warning icon.
  if (diff <= 0) return { label: "today", tint: "today" };
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

  // G3.9 drag-reorder state. draggedId = the row currently being
  // dragged; dragOver = which row + side the cursor is hovering. We
  // hold these in parent state so insertion-line indicators render
  // consistently across siblings.
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<{ id: number; pos: "above" | "below" } | null>(null);

  // G3.9 animations follow-up: FLIP-style move animation. Captures
  // every visible row's bounding rect each render, then on the NEXT
  // layout commit compares old vs new positions per data-todo-id.
  // Rows that moved get a one-shot inverse-transform animation via
  // the Web Animations API — translate(dx,dy) → translate(0,0) — so
  // state-change reordering (doing→not_yet, drag-reorder, primary
  // promotion) glides instead of snapping. Cascade-exiting rows are
  // intentionally skipped so the gooni-todo-cascade keyframe owns
  // their motion uncontested.
  const prevPositionsRef = useRef<Map<number, DOMRect>>(new Map());
  useLayoutEffect(() => {
    const next = new Map<number, DOMRect>();
    document.querySelectorAll<HTMLElement>("[data-todo-id]").forEach((el) => {
      const tidStr = el.getAttribute("data-todo-id");
      if (!tidStr) return;
      const tid = Number(tidStr);
      if (!tid) return;
      next.set(tid, el.getBoundingClientRect());
    });
    // Animate any row whose position changed since the last render.
    next.forEach((rect, tid) => {
      if (cascadeIds.includes(tid)) return; // exiting — let cascade own motion
      const prev = prevPositionsRef.current.get(tid);
      if (!prev) return;
      const dx = prev.left - rect.left;
      const dy = prev.top - rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      const el = document.querySelector<HTMLElement>(`[data-todo-id="${tid}"]`);
      if (!el) return;
      try {
        el.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: "translate(0, 0)" },
          ],
          {
            duration: 280,
            easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
            fill: "none",
          },
        );
      } catch {
        // Older browsers without Web Animations API — fallback is
        // the existing snap. Acceptable.
      }
    });
    prevPositionsRef.current = next;
  }, [bundle?.primary?.id, bundle?.open, cascadeIds]);

  // G3.9 loop-close: listen for chat-chip clicks and scroll/flash the
  // target row. Selector uses data-todo-id which TodoRow + PrimaryCard
  // both stamp on their outer wrapper.
  useEffect(() => {
    function onFocusTodo(e: Event) {
      const ev = e as CustomEvent<{ todoId: number }>;
      const tid = ev.detail?.todoId;
      if (typeof tid !== "number") return;
      // Defer to the next paint so a freshly-mounted row is queryable.
      requestAnimationFrame(() => {
        const el = document.querySelector(
          `[data-todo-id="${tid}"]`,
        ) as HTMLElement | null;
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.remove("gooni-todo-flash");
        // Force reflow so the animation restarts even on repeat clicks.
        void el.offsetWidth;
        el.classList.add("gooni-todo-flash");
        window.setTimeout(() => {
          el.classList.remove("gooni-todo-flash");
        }, 1700);
      });
    }
    window.addEventListener("gooni:focus-todo", onFocusTodo);
    return () => window.removeEventListener("gooni:focus-todo", onFocusTodo);
  }, []);

  const refresh = () => qc.invalidateQueries({ queryKey: ["todos-bundle"] });

  // Phase-2: drop a file straight onto a todo row → upload it to that todo
  // and refresh so the paperclip count updates. Distinct from the row's
  // reorder drag (which carries no Files in dataTransfer).
  async function handleFileDropOnTodo(todoId: number, files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    try {
      for (const f of list) await uploadAttachment(f, undefined, todoId);
      refresh();
    } catch (e) {
      console.error("todo attachment drop failed", e);
    }
  }

  async function handleReorderDrop() {
    if (!bundle || draggedId === null || !dragOver) {
      setDraggedId(null); setDragOver(null); return;
    }
    if (draggedId === dragOver.id) {
      setDraggedId(null); setDragOver(null); return;
    }
    const target = bundle.open.find((x) => x.id === dragOver.id)
      ?? (bundle.primary?.id === dragOver.id ? bundle.primary : null);
    if (!target) {
      setDraggedId(null); setDragOver(null); return;
    }
    // Compute new sort_order. Fractional between neighbors; backend
    // PATCH stores it. Long-term drift acceptable for v1 — the
    // `_apply_position` renormalizer in intent_handlers runs on chat-
    // driven reorders; we can mirror that here later if frequent
    // drags drift the column.
    const targetSO = target.sort_order ?? 0;
    const newSO = dragOver.pos === "above" ? targetSO - 0.5 : targetSO + 0.5;
    try {
      await updateTodo(draggedId, { sort_order: newSO });
      refresh();
    } catch (e) {
      console.error("reorder PATCH failed", e);
    } finally {
      setDraggedId(null); setDragOver(null);
    }
  }

  function makeDragHandlers(todoId: number) {
    return {
      onDragStart: () => setDraggedId(todoId),
      onDragEnd: () => { setDraggedId(null); setDragOver(null); },
      onDragOver: (e: React.DragEvent, pos: "above" | "below") => {
        // Skip self-hover — no insertion line over the dragged row.
        if (draggedId === todoId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dragOver?.id !== todoId || dragOver.pos !== pos) {
          setDragOver({ id: todoId, pos });
        }
      },
      onDrop: () => { void handleReorderDrop(); },
      // G3.9 loop-close fix: also guard on `draggedId !== null` so a
      // stuck dragOver (e.g. browser fails to fire dragend) doesn't
      // leave a phantom black insertion line on the page.
      showInsertionAbove: draggedId !== null && dragOver?.id === todoId && dragOver.pos === "above" && draggedId !== todoId,
      showInsertionBelow: draggedId !== null && dragOver?.id === todoId && dragOver.pos === "below" && draggedId !== todoId,
      isDragging: draggedId === todoId,
    };
  }

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

  // Slice 3 — Close-with-outcome inline flow. Doing-state checkbox
  // click opens the close modal instead of insta-cycling to done. Lets
  // Daniel log an outcome + optionally spawn follow-up todos in one
  // motion. not_yet → doing keeps the instant cycle so the common path
  // ("mark as actively working on") stays one click.
  const [closingId, setClosingId] = useState<number | null>(null);

  async function onCycle(t: ApiTodo) {
    if (t.state === "done") return;
    if (t.state === "doing") {
      // doing → done graduates through the close modal so outcome +
      // spawned follow-ups can land in the same write.
      setClosingId(t.id);
      return;
    }
    try {
      const next = await cycleTodoState(t.id);
      if (next.state === "done") scheduleCascade(t.id);
      refresh();
    } catch (e) { console.error("cycle todo failed", e); }
  }

  async function onSubmitClose(
    id: number,
    closure_note: string | null,
    spawned: SpawnedTodoSpec[],
  ) {
    try {
      await closeTodoWithOutcome(id, { closure_note, spawned });
      scheduleCascade(id);
      setClosingId(null);
      refresh();
    } catch (e) { console.error("close-with-outcome failed", e); }
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
      <div style={{ height: 60, opacity: 0.4, fontFamily: FONT, fontSize: 12, color: ctok.muted }}>
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
        /* G3.9 animations follow-up: richer cascade-done effect. Replaces
           the old plain fade+translate with a 4-phase ink-absorb shape:
           row briefly snaps tight (ink draws inward), scales down +
           shifts right-down (toward the done bucket), then fades.
           Slate background-flash adds the "ink absorbed" pulse. ~700ms
           total — long enough to feel deliberate, short enough not to
           block batched check-offs. */
        @keyframes gooni-todo-fade-out {
          0%   { opacity: 1;   transform: translate(0, 0) scale(1.00); background: transparent; }
          18%  { opacity: 1;   transform: translate(-2px, 0) scale(0.99); background: rgba(15,23,42,0.08); }
          50%  { opacity: 0.7; transform: translate(10px, 4px) scale(0.97); background: rgba(15,23,42,0.04); }
          100% { opacity: 0;   transform: translate(22px, 10px) scale(0.94); background: transparent; }
        }
        /* Ink trail pseudo — a thin slate streak that briefly draws out
           of the row's left edge as it "loses" its ink. Renders only
           on cascade thanks to the .gooni-todo-cascade scope. */
        @keyframes gooni-todo-ink-trail {
          0%   { opacity: 0; transform: translateX(0)    scaleX(0); }
          25%  { opacity: 0.45; transform: translateX(8px)  scaleX(1); }
          70%  { opacity: 0.20; transform: translateX(22px) scaleX(1.4); }
          100% { opacity: 0; transform: translateX(36px) scaleX(0.8); }
        }
        .gooni-todo-row { transition: background 0.12s; position: relative; }
        .gooni-todo-row:hover { background: var(--gooni-hover, rgba(0,0,0,0.025)); }
        .gooni-todo-cascade {
          animation: gooni-todo-fade-out 700ms cubic-bezier(0.4, 0.0, 0.2, 1) forwards;
          pointer-events: none;
        }
        .gooni-todo-cascade::before {
          content: "";
          position: absolute;
          left: 28px;
          top: 50%;
          width: 36px; height: 1.5px;
          transform-origin: left center;
          background: linear-gradient(90deg, rgba(15,23,42,0.55), rgba(15,23,42,0));
          border-radius: 2px;
          animation: gooni-todo-ink-trail 700ms cubic-bezier(0.4, 0.0, 0.2, 1) forwards;
          pointer-events: none;
        }

        /* G3.9 loop-close: flash highlight when chat chip dispatches
           gooni:focus-todo. A soft slate ring pulses twice over 1.6s
           then fades — long enough to see, short enough not to nag. */
        @keyframes gooni-todo-flash {
          0%, 100% { box-shadow: 0 0 0 0 rgba(15,23,42,0); }
          15%, 70% { box-shadow: 0 0 0 3px rgba(15,23,42,0.25); }
        }
        .gooni-todo-flash {
          animation: gooni-todo-flash 1600ms ease forwards;
          border-radius: 8px;
        }

        /* Doing-state indicator pulse — subtle breathing. Conveys
           "active, in motion" without the visual loudness of a spinner.
           Matches Claude minimal aesthetic. Scale clamped to 1.05 so
           the dot stays inside its ring at peak (1.10 was bleeding). */
        @keyframes gooni-doing-pulse {
          0%, 100% { transform: scale(1.0);  opacity: 0.92; }
          50%      { transform: scale(1.05); opacity: 1.0;  }
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
          0%, 100% { filter: drop-shadow(0 0 4px rgba(201,119,46,0.45)) drop-shadow(0 0 10px rgba(201,119,46,0.22)); }
          50%      { filter: drop-shadow(0 0 6px rgba(201,119,46,0.60)) drop-shadow(0 0 14px rgba(201,119,46,0.32)); }
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
          stroke: #C9772E;
          stroke-width: 1.4;
          stroke-linecap: round;
          stroke-dasharray: 1000;
          stroke-dashoffset: 1000;
          /* Draw once (forwards = stay drawn), then settle into a slow
             breathing halo. Delay the breath so it doesn't fight the
             draw mid-flight. Color: terracotta — replaces prior gold
             accent; matches the doing-state ring + slice-1 warm palette. */
          animation:
            gooni-primary-trace-draw 1800ms cubic-bezier(0.22, 0.61, 0.36, 1) forwards,
            gooni-primary-trace-breath 4200ms ease-in-out 1800ms infinite;
          filter: drop-shadow(0 0 4px rgba(201,119,46,0.55)) drop-shadow(0 0 10px rgba(201,119,46,0.25));
        }
      `}</style>

      {/* Primary card stands alone (card chrome carries the terracotta
          trace + crown). All other open rows render below in a single
          unified column under the "Today's todos" section header. */}
      {bundle.primary && (
        closingId === bundle.primary.id ? (
          <CloseInlineFlow
            key={`close-${bundle.primary.id}`}
            todo={bundle.primary}
            onSubmit={(note, sp) => onSubmitClose(bundle.primary!.id, note, sp)}
            onCancel={() => setClosingId(null)}
          />
        ) : (
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
            onDropFiles={(files) => handleFileDropOnTodo(bundle.primary!.id, files)}
          />
        )
      )}

      {/* Section header: "Today's todos" + progress counter + add button.
          Mirrors the mockup — label on the left, counter+plus right-
          aligned. Replaces the top-of-list floating counter slice 1
          had. */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        margin: bundle.primary ? "14px 2px 8px" : "0 2px 8px",
      }}>
        <span style={{
          fontSize: 13, fontWeight: 500,
          color: "var(--gooni-muted, #6B6557)",
        }}>
          todos
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
              background: "rgba(201,119,46,0.10)",
              color: "#C9772E",
              border: "0.5px solid rgba(201,119,46,0.25)",
              cursor: "pointer",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Combined open rows — active (doing) sorted first then pending
          (not_yet). Single flex column w/ a hairline gap between cards
          so the warm border on each row stays visible. */}
      {(() => {
        const activeOpen = bundle.open.filter((t) => t.state === "doing");
        const pendingOpen = bundle.open.filter((t) => t.state !== "doing");
        const allOpen = [...activeOpen, ...pendingOpen];
        return (
          <>
            {allOpen.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {allOpen.map((t) => (
                  closingId === t.id ? (
                    <CloseInlineFlow
                      key={`close-${t.id}`}
                      todo={t}
                      onSubmit={(note, sp) => onSubmitClose(t.id, note, sp)}
                      onCancel={() => setClosingId(null)}
                    />
                  ) : (
                    <TodoRow
                      key={t.id}
                      t={t}
                      focus={t.focus_id ? focusById.get(t.focus_id) ?? null : null}
                      cascade={cascadeIds.includes(t.id)}
                      chainMeta={bundle.chain_summary?.[t.id]}
                      onCycle={() => onCycle(t)}
                      onPickState={(s) => onPickState(t.id, s)}
                      onPromotePrimary={() => onPromotePrimary(t.id)}
                      onDelete={() => onDelete(t.id)}
                      onOpenEdit={() => setEditingId(t.id)}
                      onOpenChain={(id) => setChainViewId(id)}
                      dragHandlers={makeDragHandlers(t.id)}
                      onDropFiles={(files) => handleFileDropOnTodo(t.id, files)}
                    />
                  )
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
          borderBottom: "0.5px solid var(--gooni-border, rgba(0,0,0,0.06))",
          cursor: "text",
          marginTop: 2,
        }}
      >
        <Plus size={14} color={ctok.muted} />
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
          background: "var(--gooni-hover, rgba(0,0,0,0.05))",
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
  onCycle, onPickState, onDemote, onDelete, onOpenEdit, onOpenChain, onDropFiles,
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
  // Phase-2: drop OS files on the card to attach them to this todo.
  onDropFiles?: (files: FileList) => void;
}) {
  const dotColor = resolveFocusColor(focus?.color ?? null, focus?.id ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [fileOver, setFileOver] = useState(false);
  // Trace-border lives forever once the card is primary, but we key it
  // on todo id so promoting a different todo re-runs the draw animation
  // from scratch (the React key flip forces a remount of the SVG layer).
  const hasChain = !!chainMeta && chainMeta.children_total > 0;

  return (
    <div data-todo-id={t.id}>
    <div
      className={cascade ? "gooni-todo-cascade" : ""}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={hasChain ? () => onOpenChain(t.id) : undefined}
      onDragOver={(e) => {
        if (onDropFiles && dragHasFiles(e)) {
          e.preventDefault();
          if (!fileOver) setFileOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (fileOver && !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
          setFileOver(false);
        }
      }}
      onDrop={(e) => {
        if (onDropFiles && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          e.preventDefault();
          setFileOver(false);
          onDropFiles(e.dataTransfer.files);
        }
      }}
      style={{
        position: "relative",
        background: "var(--gooni-card, #FFFCF3)",
        // No terracotta border or glow at mount — the SVG trace paints
        // both in as it draws. A whisper-faint warm elevation shadow
        // keeps the card legible against the dashboard backdrop.
        border: fileOver
          ? "0.5px dashed var(--gooni-accent, #0A84FF)"
          : "0.5px solid rgba(155,130,70,0.15)",
        borderRadius: 12,
        padding: "12px 16px",
        display: "flex", alignItems: "center", gap: 12,
        fontFamily: FONT,
        boxShadow: fileOver ? "0 0 0 3px rgba(10,132,255,0.12)" : "0 1px 3px rgba(155,130,70,0.06)",
        cursor: hasChain ? "pointer" : "default",
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
          color: "#C9772E", cursor: "pointer",
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

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          onClick={(e) => { e.stopPropagation(); onOpenEdit(); }}
          title="Click to edit"
          style={{
            fontSize: 15, fontWeight: 500,
            color: "var(--gooni-text, #1C1C1E)",
            textDecoration: t.state === "done" ? "line-through" : "none",
            opacity: t.state === "done" ? 0.55 : 1,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            cursor: "pointer",
          }}
        >
          {t.text}
        </span>
        {chainMeta?.parent_id && (
          <InlineFromLine
            parentId={chainMeta.parent_id}
            parentText={chainMeta.parent_text}
            onOpenChain={onOpenChain}
          />
        )}
      </div>

      {hasChain && (
        <ChainIndicator
          meta={chainMeta!}
          onClick={(e) => { e.stopPropagation(); onOpenChain(t.id); }}
        />
      )}

      {/* Continuously-running timer — primary-only. Replaces the static
          AgePill non-primary rows use. Scales seconds → minutes → hours
          → days and caps at days (no week/month rollup). Tick cadence
          scales with elapsed time so we don't re-render every second
          forever. Hidden when done since the primary auto-clears on done. */}
      {t.state !== "done" && <LiveTimer since={t.created_at} />}

      <AttachmentBadge count={t.attachment_count ?? 0} />

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
    // Naive-UTC server timestamps must go through parseServerDate (appends
    // the missing "Z"); raw new Date() reads them as local and pins the
    // timer at "0s" for ~7h on a fresh todo. Matches the banner LiveTimer.
    const ms = parseServerDate(since)?.getTime();
    return ms != null && Number.isFinite(ms) ? ms : null;
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
  t, focus, cascade, chainMeta,
  onCycle, onPickState, onPromotePrimary, onDelete, onOpenEdit, onOpenChain,
  dragHandlers, onDropFiles,
}: {
  t: ApiTodo;
  focus: ApiFocus | null;
  cascade: boolean;
  chainMeta?: TodoChainMeta;
  onCycle: () => void;
  onPickState: (s: TodoState) => void;
  onPromotePrimary: () => void;
  onDelete: () => void;
  onOpenEdit: () => void;
  onOpenChain: (id: number) => void;
  // G3.9 frontend follow-up: drag-reorder handlers. Optional — when
  // undefined the row renders without grip + drag affordances. Parent
  // owns the drag state (draggedId, dragOverState) so the insertion-
  // line indicator can render across siblings consistently.
  dragHandlers?: {
    onDragStart: () => void;
    onDragEnd: () => void;
    onDragOver: (e: React.DragEvent, pos: "above" | "below") => void;
    onDrop: () => void;
    showInsertionAbove: boolean;
    showInsertionBelow: boolean;
    isDragging: boolean;
  };
  // Phase-2: drop OS files on the row to attach them to this todo.
  onDropFiles?: (files: FileList) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [fileOver, setFileOver] = useState(false);
  const dotColor = resolveFocusColor(focus?.color ?? null, focus?.id ?? null);
  const age = ageHint(t.created_at);
  const hasChain = !!chainMeta && chainMeta.children_total > 0;

  return (
    // Outer wrapper carries hover state so the OrphanLinkHint sitting
    // BELOW the row stays mounted while the cursor is anywhere in this
    // todo's territory. Pre-fix the hover lived on the inner row only —
    // mouse moving down to click the hint caused it to vanish.
    <div
      data-todo-id={t.id}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDragOver={(e) => {
        // File drag from the OS → attach-to-todo affordance (takes
        // priority over reorder; a reorder drag carries no Files).
        if (onDropFiles && dragHasFiles(e)) {
          e.preventDefault();
          if (!fileOver) setFileOver(true);
          return;
        }
        if (!dragHandlers) return;
        // Split target into top-half (insert above) vs bottom-half
        // (insert below) so the user can choose either side w/o
        // overshooting.
        const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const pos = e.clientY < midY ? "above" : "below";
        dragHandlers.onDragOver(e, pos);
      }}
      onDragLeave={(e) => {
        // Only clear when the cursor truly leaves the row (not on entering
        // a child element), else the highlight flickers.
        if (fileOver && !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
          setFileOver(false);
        }
      }}
      onDrop={(e) => {
        if (onDropFiles && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          e.preventDefault();
          setFileOver(false);
          onDropFiles(e.dataTransfer.files);
          return;
        }
        if (!dragHandlers) return;
        e.preventDefault();
        dragHandlers.onDrop();
      }}
      style={{ position: "relative", opacity: dragHandlers?.isDragging ? 0.4 : 1 }}
    >
      {/* Insertion indicator lines — claude-minimal: 2px dark slate
          bar above or below the target row, only visible during drag. */}
      {dragHandlers?.showInsertionAbove && (
        <div style={{
          position: "absolute", top: -1, left: 12, right: 12, height: 2,
          background: "#0F172A", borderRadius: 2, zIndex: 2,
        }} />
      )}
    <div
      className={`gooni-todo-row${cascade ? " gooni-todo-cascade" : ""}`}
      onClick={hasChain ? () => onOpenChain(t.id) : undefined}
      style={{
        position: "relative",
        background: "var(--gooni-card, #FFFFFF)",
        border: fileOver
          ? "1px dashed var(--gooni-accent, #0A84FF)"
          : "0.5px solid var(--gooni-border, rgba(155,130,70,0.15))",
        borderRadius: 8,
        padding: "10px 16px",
        display: "flex", alignItems: "center", gap: 12,
        cursor: hasChain ? "pointer" : "default",
        boxShadow: fileOver ? "0 0 0 3px rgba(10,132,255,0.12)" : undefined,
        transition: "box-shadow 0.12s, border-color 0.12s",
      }}
    >
      {/* Drag grip — visible on hover (or always during a drag). Carries
          draggable=true so picking it up grabs the whole row via the
          parent's drag handlers. Cursor: grab/grabbing. Muted gray;
          claude-minimal pattern. */}
      {dragHandlers && (
        <span
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            // Some browsers refuse to drag without dataTransfer.setData.
            try { e.dataTransfer.setData("text/plain", String(t.id)); } catch { /* ignore */ }
            dragHandlers.onDragStart();
          }}
          onDragEnd={() => dragHandlers.onDragEnd()}
          title="Drag to reorder"
          style={{
            display: "flex", alignItems: "center",
            color: hovered || dragHandlers.isDragging ? ctok.muted : "transparent",
            cursor: "grab",
            transition: "color 0.15s",
            marginLeft: -6, marginRight: -4,
          }}
        >
          <GripVertical size={14} />
        </span>
      )}
      <span onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center" }}>
        <Checkbox
          state={t.state}
          onClick={() => {
            if (t.state === "done") setPickerOpen(true);
            else onCycle();
          }}
        />
      </span>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          onClick={(e) => { e.stopPropagation(); onOpenEdit(); }}
          title="Click to edit"
          style={{
            fontSize: 14, color: "var(--gooni-text, #1C1C1E)",
            textDecoration: t.state === "done" ? "line-through" : "none",
            opacity: t.state === "done" ? 0.55 : 1,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            cursor: "pointer",
          }}
        >
          {t.text}
        </span>
        {chainMeta?.parent_id && (
          <InlineFromLine
            parentId={chainMeta.parent_id}
            parentText={chainMeta.parent_text}
            onOpenChain={onOpenChain}
          />
        )}
      </div>

      {hasChain && (
        <ChainIndicator
          meta={chainMeta!}
          onClick={(e) => { e.stopPropagation(); onOpenChain(t.id); }}
        />
      )}

      {age && t.state !== "done" && <AgePill age={age} />}

      <AttachmentBadge count={t.attachment_count ?? 0} />

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
            padding: 2, color: ctok.muted, display: "flex",
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
    {!chainMeta?.parent_id && hovered && (
      <OrphanLinkHint todoId={t.id} onOpenChain={onOpenChain} />
    )}
    {dragHandlers?.showInsertionBelow && (
      <div style={{
        position: "absolute", bottom: -1, left: 12, right: 12, height: 2,
        background: "#0F172A", borderRadius: 2, zIndex: 2,
      }} />
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
  // Kept for the Done section, where rows aren't carded so the
  // sibling-below-row position still reads cleanly. Open rows use
  // InlineFromLine (rendered inside the card body) — keeps the from-
  // text glued to the card it belongs to once cards have gaps between.
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

function InlineFromLine({
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
      onClick={(e) => { e.stopPropagation(); onOpenChain(parentId); }}
      style={{
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
  // mode. Absolutely positioned so it floats below the card on hover
  // without pushing siblings down (would otherwise create a visual gap
  // every time the cursor entered an orphan row).
  return (
    <div
      onClick={(e) => { e.stopPropagation(); onOpenChain(todoId); }}
      style={{
        position: "absolute",
        top: "100%",
        left: 42,
        marginTop: 2,
        padding: "2px 8px",
        fontSize: 11,
        color: "var(--gooni-muted, #C0C4CC)",
        background: "var(--gooni-bg, #FBF7EE)",
        display: "inline-flex", alignItems: "center", gap: 4,
        cursor: "pointer",
        opacity: 0.85,
        zIndex: 3,
        borderRadius: 6,
        pointerEvents: "auto",
        whiteSpace: "nowrap",
      }}
    >
      <ArrowLeft size={10} />
      <span style={{ fontStyle: "italic" }}>link to parent todo…</span>
    </div>
  );
}

// True when a drag carries OS files (vs an internal reorder drag, which
// carries no "Files" type). Lets a row tell "drop a PDF here" apart from
// "reorder me".
function dragHasFiles(e: React.DragEvent): boolean {
  const types = e.dataTransfer?.types;
  return !!types && Array.from(types).includes("Files");
}

// Paperclip + count, shown on a row when it has attachments.
function AttachmentBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span
      title={`${count} attachment${count === 1 ? "" : "s"}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        fontSize: 11, color: "var(--gooni-muted, #6B7280)",
        flexShrink: 0, fontVariantNumeric: "tabular-nums",
      }}
    >
      <Paperclip size={11} />
      {count}
    </span>
  );
}

// ── Age pill ─────────────────────────────────────────────────────────────

function AgePill({ age }: { age: { label: string; tint: keyof typeof AGE_TINTS } }) {
  const isDark = useGooniThemeStore((s) => s.theme === "dark");
  const { bg, fg } = (isDark ? AGE_TINTS_DARK : AGE_TINTS)[age.tint];
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
        background: ctok.muted, color: "#fff",
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
      border: "1.5px solid var(--gooni-faint, rgba(0,0,0,0.22))",
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
        background: "var(--gooni-card, #fff)",
        border: "1px solid var(--gooni-border, rgba(0,0,0,0.10))",
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
              border: "none", background: s === current ? "var(--gooni-hover, #F3F4F6)" : "transparent",
              padding: "4px 8px", fontSize: 11, borderRadius: 6,
              cursor: "pointer", color: ctok.text, textTransform: "capitalize",
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
  // Mockup behavior: done rows hide behind a chevron-disclosed group so
  // the eye stays on what's still actionable. Click the header to expand.
  // Count is always visible.
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ marginTop: 16 }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 4px",
          background: "transparent", border: "none",
          cursor: "pointer", fontFamily: FONT,
          color: "var(--gooni-muted, #9CA3AF)",
        }}
      >
        <span style={{
          display: "inline-block",
          transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
          transition: "transform 0.15s",
          fontSize: 11,
        }}>▾</span>
        <span style={{ fontSize: 12, fontWeight: 500 }}>Done today</span>
        <span style={{ fontSize: 11 }}>· {todos.length}</span>
      </button>
      {!expanded ? null : (
      <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 6 }}>
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
                background: "var(--gooni-card, #FFFCF3)",
                border: "0.5px solid var(--gooni-border, rgba(155,130,70,0.12))",
                borderRadius: 8,
                padding: "8px 14px",
                display: "flex", alignItems: "center", gap: 10,
                opacity: 0.4,
                cursor: "pointer",
              }}
            >
              <span style={{
                width: 14, height: 14, borderRadius: "50%",
                background: ctok.muted, color: "#fff",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontFamily: FONT, flexShrink: 0,
              }}>✓</span>
              <span style={{
                flex: 1, minWidth: 0,
                fontSize: 13, color: "var(--gooni-text, #1C1C1E)",
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
      )}
    </div>
  );
}

// ── Slice 3: close-with-outcome inline flow ──────────────────────────────
//
// Replaces the doing-state row with a vertical expansion: outcome
// textarea + multi-line spawn list + close button. Keyboard:
//   - Esc cancels (closingId → null)
//   - Cmd/Ctrl+Enter submits
//   - Enter inside a spawn input adds another row
//   - Enter on the textarea inserts a newline (default <textarea> behavior)
//
// Submit calls /todos/{id}/close with closure_note + spawned[]. Empty
// textarea → null closure_note; empty spawn entries are stripped.

function CloseInlineFlow({
  todo,
  onSubmit,
  onCancel,
}: {
  todo: ApiTodo;
  onSubmit: (closure_note: string | null, spawned: SpawnedTodoSpec[]) => void;
  onCancel: () => void;
}) {
  const [outcome, setOutcome] = useState("");
  const [spawnList, setSpawnList] = useState<string[]>([]);
  const [draftSpawn, setDraftSpawn] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { taRef.current?.focus(); }, []);

  function commitDraftSpawn(): boolean {
    const v = draftSpawn.trim();
    if (!v) return false;
    setSpawnList((arr) => [...arr, v]);
    setDraftSpawn("");
    return true;
  }

  function handleSubmit() {
    // Commit any pending draft spawn before submitting so the row Daniel
    // typed-but-didn't-Enter still gets persisted.
    const tailDraft = draftSpawn.trim();
    const finalSpawns = tailDraft ? [...spawnList, tailDraft] : spawnList;
    const cleaned: SpawnedTodoSpec[] = finalSpawns
      .map((s) => s.trim())
      .filter(Boolean)
      .map((text) => ({ text }));
    const note = outcome.trim();
    onSubmit(note ? note : null, cleaned);
  }

  function handleRootKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <div
      onKeyDown={handleRootKey}
      style={{
        background: "var(--gooni-card, #FFFCF3)",
        border: "0.5px solid rgba(201,119,46,0.40)",
        borderRadius: 12,
        overflow: "hidden",
        boxShadow: "0 2px 8px rgba(184,140,60,0.10)",
        fontFamily: FONT,
        margin: "1px 0",
      }}
    >
      {/* Header — shows the closing todo greyed-out + line-through */}
      <div style={{
        padding: "10px 16px",
        display: "flex", alignItems: "center", gap: 10,
        borderBottom: "0.5px solid rgba(155,130,70,0.15)",
        background: "var(--gooni-hover, rgba(243,238,220,0.40))",
      }}>
        <span style={{
          width: 17, height: 17, borderRadius: "50%",
          background: ctok.muted, color: "#fff",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          fontSize: 11, flexShrink: 0,
        }}>✓</span>
        <span style={{
          flex: 1, fontSize: 14,
          color: "var(--gooni-muted, #6B6557)",
          textDecoration: "line-through",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>{todo.text}</span>
        <span style={{ fontSize: 11, color: "var(--gooni-faint, #A89D80)" }}>closing…</span>
      </div>

      {/* Body */}
      <div style={{ padding: "12px 16px" }}>
        <div style={{
          fontSize: 11, color: "var(--gooni-muted, #8A8270)", marginBottom: 6, letterSpacing: 0.02,
        }}>
          what happened?
        </div>
        <textarea
          ref={taRef}
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          placeholder="enter to skip · multi-line ok"
          style={{
            width: "100%",
            fontSize: 13,
            border: "0.5px solid rgba(155,130,70,0.20)",
            background: "var(--gooni-bg, #FAF7F0)",
            borderRadius: 7,
            padding: "8px 11px",
            color: "var(--gooni-text, #2A2620)",
            fontFamily: FONT,
            lineHeight: 1.6,
            resize: "vertical",
            minHeight: 52,
            marginBottom: 14,
            outline: "none",
            boxSizing: "border-box",
          }}
        />

        <div style={{
          fontSize: 11, color: "var(--gooni-muted, #8A8270)", marginBottom: 8,
        }}>
          next steps <span style={{ color: "var(--gooni-faint, #A89D80)" }}>· enter adds another</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 12 }}>
          {spawnList.map((text, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 9,
              padding: "7px 11px",
              background: "var(--gooni-bg, #FAF7F0)",
              borderRadius: 7,
              border: "0.5px solid rgba(155,130,70,0.15)",
            }}>
              <div style={{
                width: 13, height: 13, borderRadius: "50%",
                border: "1.5px solid rgba(155,130,70,0.40)",
                flexShrink: 0,
              }} />
              <span style={{ flex: 1, fontSize: 13, color: "var(--gooni-text, #2A2620)" }}>
                {text}
              </span>
              <button
                type="button"
                onClick={() => setSpawnList((arr) => arr.filter((_, idx) => idx !== i))}
                aria-label="remove spawn"
                style={{
                  border: "none", background: "transparent",
                  color: "var(--gooni-faint, #A89D80)", cursor: "pointer", padding: 2,
                  display: "flex",
                }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <div style={{
            display: "flex", alignItems: "center", gap: 9,
            padding: "7px 11px",
            border: "0.5px dashed rgba(155,130,70,0.30)",
            borderRadius: 7,
          }}>
            <Plus size={12} color="var(--gooni-faint, #A89D80)" />
            <input
              type="text"
              value={draftSpawn}
              onChange={(e) => setDraftSpawn(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.stopPropagation();
                  commitDraftSpawn();
                }
              }}
              placeholder="add another…"
              style={{
                flex: 1, fontSize: 12, border: "none",
                background: "transparent", padding: 0,
                color: "var(--gooni-text, #4A4538)",
                outline: "none", fontFamily: FONT,
              }}
            />
          </div>
        </div>

        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          paddingTop: 8, borderTop: "0.5px solid rgba(155,130,70,0.15)",
        }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              border: "none", background: "transparent",
              color: "var(--gooni-faint, #A89D80)", cursor: "pointer", fontSize: 11,
              padding: "4px 6px", fontFamily: FONT,
            }}
          >
            esc to cancel
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 10, color: "var(--gooni-faint, #A89D80)" }}>⌘↵</span>
            <button
              type="button"
              onClick={handleSubmit}
              style={{
                fontSize: 12, padding: "6px 16px",
                background: "#C9772E", color: "#FFFCF3",
                border: "none", borderRadius: 7,
                fontWeight: 500, cursor: "pointer",
                fontFamily: FONT,
              }}
            >
              close todo
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
