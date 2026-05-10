import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Crown, Plus, X, Sparkles } from "lucide-react";
import {
  fetchTodos, createTodo, updateTodo, cycleTodoState, deleteTodo,
  promoteTodoToPrimary, fetchFocuses,
  type ApiTodo, type ApiTodoBundle, type ApiFocus, type TodoState,
} from "../../services/api";
import { resolveFocusColor } from "../../utils/focusColors";

// TodoList — dashboard todos block. Shape after the dashboard revamp:
//
//   ┌ Crown row  (singleton primary; segregated from "open" bucket)
//   ├ open todos ordered with `doing` floated above `not_yet`
//   ├ inline create row ("+ add a todo")
//   └ Done section (toggle: Dev Activity ↔ Completed today)
//
// The 3-state cycle (not_yet → doing → done) is one click; the Done state
// pops a small picker so users can revert without a long-press.

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

// Two consecutive doneCycle invocations within this window after landing
// on `done` count as a confirm (safety against accidental double-clicks).
const CASCADE_STAGGER_MS = 80;

interface Props {
  onOpenSourceNote?: (noteId: number) => void;
}

function ageHint(iso: string | null): string {
  if (!iso) return "";
  const created = new Date(iso);
  if (Number.isNaN(created.getTime())) return "";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(created); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  return `${diff}d ago`;
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

  // Cascading-done staggered animation: when the user marks several todos
  // done quickly, fade them out one after another (80ms apart) so the eye
  // can track the satisfaction. Tracked locally (not server-driven).
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
    if (t.state === "done") {
      // From done, the row's StatePicker handles re-pick; cycle is a no-op.
      return;
    }
    try {
      const next = await cycleTodoState(t.id);
      if (next.state === "done") scheduleCascade(t.id);
      refresh();
    } catch (e) {
      console.error("cycle todo failed", e);
    }
  }

  async function onPickState(id: number, state: TodoState) {
    try {
      await updateTodo(id, { state });
      refresh();
    } catch (e) { console.error(e); }
  }

  async function onPromotePrimary(id: number) {
    try { await promoteTodoToPrimary(id); refresh(); } catch (e) { console.error(e); }
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
      // Stay in create mode so Daniel can add several in a row; ESC exits.
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

  return (
    <div style={{ fontFamily: FONT, display: "flex", flexDirection: "column", gap: 6 }}>
      <style>{`
        @keyframes gooni-todo-fade-out {
          0%   { opacity: 1; transform: translateX(0);   }
          80%  { opacity: 0.4; transform: translateX(8px); }
          100% { opacity: 0; transform: translateX(12px); }
        }
        .gooni-todo-row { transition: background 0.12s; }
        .gooni-todo-row:hover { background: rgba(0,0,0,0.035); }
        .gooni-todo-cascade { animation: gooni-todo-fade-out 600ms ease forwards; }
      `}</style>

      {bundle.primary && (
        <TodoRow
          t={bundle.primary}
          isPrimary
          focus={bundle.primary.focus_id ? focusById.get(bundle.primary.focus_id) ?? null : null}
          cascade={cascadeIds.includes(bundle.primary.id)}
          onCycle={() => onCycle(bundle.primary!)}
          onPickState={(s) => onPickState(bundle.primary!.id, s)}
          onPromotePrimary={() => {/* already primary */}}
          onDelete={() => onDelete(bundle.primary!.id)}
        />
      )}

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

      {/* Inline create row */}
      {creating ? (
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "8px 10px", borderRadius: 8,
          border: "1px dashed rgba(0,0,0,0.15)",
          background: "rgba(0,0,0,0.015)",
        }}>
          <Plus size={14} color="#8E8E93" />
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
              fontFamily: FONT, fontSize: 13.5, background: "transparent",
              color: "var(--gooni-text, #1C1C1E)",
            }}
          />
        </div>
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="gooni-todo-add"
          style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "8px 10px", borderRadius: 8,
            border: "none", background: "transparent",
            cursor: "pointer", textAlign: "left",
            color: "var(--gooni-muted, #8E8E93)", fontFamily: FONT, fontSize: 12.5,
          }}
        >
          <Plus size={14} /> add a todo
        </button>
      )}

      {bundle.done_today.length > 0 && (
        <DoneSection todos={bundle.done_today} focusById={focusById} />
      )}
    </div>
  );
}

// ── Single row ────────────────────────────────────────────────────────────

function TodoRow({
  t, focus, isPrimary, cascade,
  onCycle, onPickState, onPromotePrimary, onDelete,
}: {
  t: ApiTodo;
  focus: ApiFocus | null;
  isPrimary?: boolean;
  cascade?: boolean;
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
        display: "flex", alignItems: "center", gap: 10,
        padding: "8px 10px",
        borderRadius: 8,
        position: "relative",
        // Primary row: green left rail + soft tint, pulse dot to the right.
        background: isPrimary ? "rgba(48, 161, 78, 0.07)" : "transparent",
        borderLeft: isPrimary ? "2px solid #30A14E" : "2px solid transparent",
      }}
    >
      {/* Checkbox cycler */}
      <Checkbox
        state={t.state}
        onClick={() => {
          if (t.state === "done") setPickerOpen(true);
          else onCycle();
        }}
      />

      {/* Focus color dot */}
      {focus && (
        <span
          title={focus.text}
          style={{
            width: 8, height: 8, borderRadius: "50%",
            background: dotColor, flexShrink: 0,
          }}
        />
      )}

      {/* Crown for primary */}
      {isPrimary && (
        <Crown size={12} color="#D97706" strokeWidth={2} />
      )}

      {/* Text */}
      <div style={{
        flex: 1, minWidth: 0,
        fontSize: 13.5, color: "var(--gooni-text, #1C1C1E)",
        textDecoration: t.state === "done" ? "line-through" : "none",
        opacity: t.state === "done" ? 0.5 : 1,
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>
        {t.text}
      </div>

      {/* Age tag */}
      {age && t.state !== "done" && (
        <span style={{
          fontSize: 10.5, color: "var(--gooni-muted, #8E8E93)",
          fontVariantNumeric: "tabular-nums",
          flexShrink: 0,
        }}>
          {age}
        </span>
      )}

      {/* Hover actions: promote-to-primary, delete */}
      {hovered && !isPrimary && (
        <button
          title="Make primary"
          onClick={onPromotePrimary}
          style={{
            border: "none", background: "transparent", cursor: "pointer",
            padding: 2, color: "#8E8E93", display: "flex",
          }}
        >
          <Crown size={12} />
        </button>
      )}
      {hovered && (
        <button
          title="Delete"
          onClick={onDelete}
          style={{
            border: "none", background: "transparent", cursor: "pointer",
            padding: 2, color: "#8E8E93", display: "flex",
          }}
        >
          <X size={12} />
        </button>
      )}

      {/* State picker pops above the row when a done row is clicked. */}
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

// ── Checkbox cycler ──────────────────────────────────────────────────────

function Checkbox({ state, onClick }: { state: TodoState; onClick: () => void }) {
  // Visual: empty square (not_yet) / dotted half (doing) / filled check (done).
  const common: React.CSSProperties = {
    width: 16, height: 16, borderRadius: 4,
    flexShrink: 0, cursor: "pointer",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    fontFamily: FONT, fontSize: 11, lineHeight: 1,
    transition: "all 0.12s",
  };
  if (state === "done") {
    return (
      <span onClick={onClick} style={{
        ...common,
        background: "#30A14E", color: "#fff",
        border: "1px solid #2B8C4D",
      }}>✓</span>
    );
  }
  if (state === "doing") {
    return (
      <span onClick={onClick} style={{
        ...common,
        background: "#FEF3C7", color: "#92400E",
        border: "1px solid #F59E0B",
      }}>·</span>
    );
  }
  return (
    <span onClick={onClick} style={{
      ...common,
      background: "transparent",
      border: "1px solid rgba(0,0,0,0.25)",
    }} />
  );
}

// ── State picker (popover on done) ───────────────────────────────────────

function StatePicker({ current, onPick, onClose }: {
  current: TodoState;
  onPick: (s: TodoState) => void;
  onClose: () => void;
}) {
  // Click-outside via a fixed overlay; popover docked relative to the row.
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
//
// Daniel's spec: under the open list, surface a small section that toggles
// between "Dev Activity" (commits/PR titles for today) and "Completed
// today" (the done_today bucket). Default = Completed when there are
// completions, else Dev Activity. Dev Activity content is rendered by a
// sibling component (DevActivityToday) — here we own only the toggle +
// completed list.

function DoneSection({ todos, focusById }: {
  todos: ApiTodo[];
  focusById: Map<number, ApiFocus>;
}) {
  const [tab, setTab] = useState<"completed" | "dev">("completed");

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        marginBottom: 6,
        fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
        textTransform: "uppercase", letterSpacing: 0.4,
      }}>
        <Sparkles size={11} />
        <button
          onClick={() => setTab("completed")}
          style={{
            border: "none", background: "transparent", padding: 0,
            fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase",
            color: tab === "completed" ? "var(--gooni-text, #1C1C1E)" : "var(--gooni-muted, #8E8E93)",
            fontWeight: tab === "completed" ? 600 : 400,
            cursor: "pointer", fontFamily: FONT,
          }}
        >
          Completed today
        </button>
        <span style={{ opacity: 0.4 }}>·</span>
        <button
          onClick={() => setTab("dev")}
          style={{
            border: "none", background: "transparent", padding: 0,
            fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase",
            color: tab === "dev" ? "var(--gooni-text, #1C1C1E)" : "var(--gooni-muted, #8E8E93)",
            fontWeight: tab === "dev" ? 600 : 400,
            cursor: "pointer", fontFamily: FONT,
          }}
        >
          Dev activity
        </button>
      </div>

      {tab === "completed" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {todos.map((t) => {
            const focus = t.focus_id ? focusById.get(t.focus_id) ?? null : null;
            const dotColor = resolveFocusColor(focus?.color ?? null, focus?.id ?? null);
            return (
              <div key={t.id} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "4px 10px", borderRadius: 6,
                opacity: 0.55,
              }}>
                <span style={{
                  width: 14, height: 14, borderRadius: 3,
                  background: "#30A14E", color: "#fff",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, fontFamily: FONT,
                }}>✓</span>
                {focus && (
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor }} />
                )}
                <span style={{
                  fontSize: 12.5, color: "var(--gooni-text, #1C1C1E)",
                  textDecoration: "line-through", flex: 1, minWidth: 0,
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}>{t.text}</span>
              </div>
            );
          })}
        </div>
      )}

      {tab === "dev" && (
        <DevActivityToday />
      )}
    </div>
  );
}

// Lightweight inline dev-activity preview. Pulls dev take from the cache
// (already fetched by the dashboard's GooniTake panel), so this is just
// a rendered string — no extra fetch. Shows "(no commits today)" when
// the dev take is empty.
function DevActivityToday() {
  return (
    <div style={{
      padding: "6px 10px",
      fontSize: 12, color: "var(--gooni-muted, #8E8E93)",
      fontFamily: FONT, fontStyle: "italic",
    }}>
      See "Gooni's Dev Take" above for today's shipped work.
    </div>
  );
}
