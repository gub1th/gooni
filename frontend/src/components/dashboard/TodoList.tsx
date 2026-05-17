import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Crown, Plus, AlertTriangle } from "lucide-react";
import {
  fetchTodos, createTodo, updateTodo, cycleTodoState, deleteTodo,
  promoteTodoToPrimary, fetchFocuses,
  type ApiTodo, type ApiTodoBundle, type ApiFocus, type TodoState,
} from "../../services/api";
import { resolveFocusColor } from "../../utils/focusColors";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";

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

        /* Primary-todo card: a single small yellow bullet that travels
           around the card perimeter once then fades. Implemented as an
           SVG <rect> with a tiny stroke-dasharray gap; we animate
           stroke-dashoffset so the visible dash slides along the path.
           The whole svg layer also fades out at the end so the soft
           halo (box-shadow on the card) is what remains. */
        @keyframes gooni-primary-race-offset {
          0%   { stroke-dashoffset: 0;     }
          100% { stroke-dashoffset: -2400; }
        }
        @keyframes gooni-primary-race-fade {
          0%, 88% { opacity: 1; }
          100%    { opacity: 0; }
        }
        .gooni-primary-race {
          /* Rides the card border itself (rect rx matches the card's
             border-radius). Explicit width/height — SVG is a CSS
             replaced element so 'inset: 0' alone wouldn't reliably
             stretch it. */
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          overflow: visible;
          animation: gooni-primary-race-fade 2400ms ease forwards;
        }
        .gooni-primary-race rect {
          fill: none;
          stroke: #F5C849;
          stroke-width: 2;
          stroke-linecap: round;
          /* 36px visible bullet + huge gap so only one segment shows
             at a time. */
          stroke-dasharray: 36 2400;
          stroke-dashoffset: 0;
          filter: drop-shadow(0 0 5px rgba(245, 200, 73, 0.7));
          /* Slower lap so the eye can track the bullet around the
             border without it feeling like a hurry. */
          animation: gooni-primary-race-offset 2200ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
        }
      `}</style>

      {/* Primary card — separate visual treatment, sits above the list. */}
      {bundle.primary && (
        <PrimaryCard
          t={bundle.primary}
          focus={bundle.primary.focus_id ? focusById.get(bundle.primary.focus_id) ?? null : null}
          cascade={cascadeIds.includes(bundle.primary.id)}
          onCycle={() => onCycle(bundle.primary!)}
          onPickState={(s) => onPickState(bundle.primary!.id, s)}
          onDemote={() => onDemotePrimary(bundle.primary!.id)}
          onDelete={() => onDelete(bundle.primary!.id)}
        />
      )}

      {/* Section header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        margin: "0 4px 8px",
      }}>
        <span style={{
          fontSize: 12, fontWeight: 500, letterSpacing: 0.4,
          color: "var(--gooni-muted, #6B7280)",
        }}>
          TODAY'S TODOS
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
              background: "rgba(15,110,86,0.12)",
              color: "#0F6E56",
              border: "none", cursor: "pointer",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Open list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {bundle.open.map((t) => (
          <TodoRow
            key={t.id}
            t={t}
            focus={t.focus_id ? focusById.get(t.focus_id) ?? null : null}
            cascade={cascadeIds.includes(t.id)}
            onCycle={() => onCycle(t)}
            onPickState={(s) => onPickState(t.id, s)}
            onPromotePrimary={() => onPromotePrimary(t.id)}
            onDelete={() => onDelete(t.id)}
          />
        ))}
      </div>

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
        <DoneSection todos={bundle.done_today} focusById={focusById} />
      )}
    </div>
  );
}

// ── Primary card ─────────────────────────────────────────────────────────

function PrimaryCard({
  t, focus, cascade,
  onCycle, onPickState, onDemote, onDelete,
}: {
  t: ApiTodo;
  focus: ApiFocus | null;
  cascade: boolean;
  onCycle: () => void;
  onPickState: (s: TodoState) => void;
  onDemote: () => void;
  onDelete: () => void;
}) {
  const dotColor = resolveFocusColor(focus?.color ?? null, focus?.id ?? null);
  const age = ageHint(t.created_at);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Race-border one-shot — keyed on todo id so promoting another todo to
  // primary re-fires the animation. Local state flips off after the
  // animation duration so re-renders don't keep restarting it.
  const [racing, setRacing] = useState(true);
  useEffect(() => {
    setRacing(true);
    const id = window.setTimeout(() => setRacing(false), 2500);
    return () => clearTimeout(id);
  }, [t.id]);

  return (
    <div
      className={cascade ? "gooni-todo-cascade" : ""}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        background: "var(--gooni-card, #FFFFFF)",
        border: "0.5px solid rgba(245,200,73,0.35)",
        borderRadius: 12,
        padding: "12px 16px",
        display: "flex", alignItems: "center", gap: 12,
        marginBottom: 12,
        fontFamily: FONT,
        boxShadow: "0 0 0 1px rgba(245,200,73,0.18), 0 6px 22px rgba(245,200,73,0.22), 0 2px 8px rgba(245,200,73,0.14)",
      }}
    >
      {racing && (
        <svg
          className="gooni-primary-race"
          aria-hidden
          preserveAspectRatio="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Rect rides the card edge itself; rx 12 matches the card's
              borderRadius. Stroke is centered on the path so half sits
              just outside the border (overflow:visible on the parent). */}
          <rect x="0" y="0" width="100%" height="100%" rx="12" ry="12" />
        </svg>
      )}
      <button
        onClick={onDemote}
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

      <Checkbox
        state={t.state}
        onClick={() => {
          if (t.state === "done") setPickerOpen(true);
          else onCycle();
        }}
        size="lg"
      />

      <span style={{
        flex: 1, fontSize: 14, fontWeight: 500,
        color: "var(--gooni-text, #1C1C1E)",
        textDecoration: t.state === "done" ? "line-through" : "none",
        opacity: t.state === "done" ? 0.55 : 1,
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>
        {t.text}
      </span>

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
        <ConfirmDeleteButton onConfirm={onDelete} />
      )}

      {pickerOpen && (
        <StatePicker
          current={t.state}
          onPick={(s) => { onPickState(s); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

// ── Single open row ──────────────────────────────────────────────────────

function TodoRow({
  t, focus, cascade,
  onCycle, onPickState, onPromotePrimary, onDelete,
}: {
  t: ApiTodo;
  focus: ApiFocus | null;
  cascade: boolean;
  onCycle: () => void;
  onPickState: (s: TodoState) => void;
  onPromotePrimary: () => void;
  onDelete: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const dotColor = resolveFocusColor(focus?.color ?? null, focus?.id ?? null);
  const age = ageHint(t.created_at);

  return (
    <div
      className={`gooni-todo-row${cascade ? " gooni-todo-cascade" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        background: "var(--gooni-card, #FFFFFF)",
        border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
        borderRadius: 8,
        padding: "10px 16px",
        display: "flex", alignItems: "center", gap: 12,
      }}
    >
      <Checkbox
        state={t.state}
        onClick={() => {
          if (t.state === "done") setPickerOpen(true);
          else onCycle();
        }}
      />

      <span style={{
        flex: 1, minWidth: 0,
        fontSize: 14, color: "var(--gooni-text, #1C1C1E)",
        textDecoration: t.state === "done" ? "line-through" : "none",
        opacity: t.state === "done" ? 0.55 : 1,
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>
        {t.text}
      </span>

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
          onClick={onPromotePrimary}
          style={{
            border: "none", background: "transparent", cursor: "pointer",
            padding: 2, color: "#9CA3AF", display: "flex",
          }}
        >
          <Crown size={12} />
        </button>
      )}
      {hovered && (
        <ConfirmDeleteButton onConfirm={onDelete} />
      )}

      {pickerOpen && (
        <StatePicker
          current={t.state}
          onPick={(s) => { onPickState(s); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
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
    return (
      <span onClick={onClick} style={{
        ...common,
        background: "transparent",
        border: "2px solid #F59E0B",
      }}>
        <span style={{
          width: innerDim, height: innerDim, borderRadius: "50%",
          background: "#F59E0B",
        }} />
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

function DoneSection({ todos, focusById }: {
  todos: ApiTodo[];
  focusById: Map<number, ApiFocus>;
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
          return (
            <div key={t.id} style={{
              background: "var(--gooni-card, #FFFFFF)",
              border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
              borderRadius: 8,
              padding: "10px 16px",
              display: "flex", alignItems: "center", gap: 12,
              opacity: 0.45,
            }}>
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
              {focus && (
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
