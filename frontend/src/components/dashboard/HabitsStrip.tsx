import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X, Check, Minus } from "lucide-react";
import {
  fetchHabits,
  createHabit,
  setHabitEntry,
  unlogHabitEntry,
  deleteHabit,
  type ApiHabit,
  type ApiHabitCell,
} from "../../services/api";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";

// HabitsStrip — bottom-of-dashboard widget for daily binary trackers.
// Each row: name + 7-day strip (oldest → newest) + current streak +
// hover-delete. Click any cell to cycle: empty → ✓ → ✗ → empty.
// Today's cell is the rightmost; highlighted with a subtle ring.
//
// Habits are always phrased positively. value=true means Daniel did the
// good thing (went to gym / stayed clean). `polarity` carries the
// underlying connotation for downstream colour decisions; the value
// semantics never invert.
//
// Visual chrome — section title size + inline-create row — matches
// TodoList so the two surfaces feel like sibling widgets.

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

function nextValue(current: boolean | null): boolean | null {
  // empty (null) → true → false → empty
  if (current === null) return true;
  if (current === true) return false;
  return null;
}

function cellColor(value: boolean | null, habitColor: string | null): string {
  if (value === true) return habitColor || "#22C55E";
  if (value === false) return "#FCA5A5"; // muted red — explicit "no"
  return "#E2E8F0"; // neutral slate — unknown
}

function CellIcon({ value }: { value: boolean | null }) {
  if (value === true) return <Check size={11} strokeWidth={3} color="white" />;
  if (value === false) return <X size={11} strokeWidth={3} color="white" />;
  return <Minus size={10} strokeWidth={2.5} color="#94A3B8" />;
}

export function HabitsStrip() {
  const qc = useQueryClient();
  const { data: habits = [] } = useQuery<ApiHabit[]>({
    queryKey: ["habits"],
    queryFn: fetchHabits,
  });
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [hoverId, setHoverId] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleCellClick = async (
    habit: ApiHabit, cell: ApiHabitCell,
  ) => {
    const next = nextValue(cell.value);
    if (next === null) {
      await unlogHabitEntry(habit.id, cell.date);
    } else {
      await setHabitEntry(habit.id, cell.date, next);
    }
    qc.invalidateQueries({ queryKey: ["habits"] });
  };

  const handleCreate = async () => {
    const name = draft.trim();
    if (!name) { setCreating(false); return; }
    await createHabit(name);
    setDraft("");
    setCreating(false);
    qc.invalidateQueries({ queryKey: ["habits"] });
  };

  const handleDelete = async (id: number) => {
    await deleteHabit(id);
    qc.invalidateQueries({ queryKey: ["habits"] });
  };

  return (
    <div style={{ marginTop: 28, fontFamily: FONT }}>
      {/* Section header — mirrors TodoList's TODAY'S TODOS row. + button is
          greenish (same Gooni accent) and triggers the inline create row. */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        margin: "0 4px 8px",
      }}>
        <span style={{
          fontSize: 12, fontWeight: 500, letterSpacing: 0.4,
          color: "var(--gooni-muted, #6B7280)",
        }}>
          HABITS
        </span>
        <button
          onClick={() => { setCreating(true); window.setTimeout(() => inputRef.current?.focus(), 0); }}
          title="Add a habit"
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

      {habits.length === 0 && !creating ? (
        <div style={{
          padding: "10px 16px",
          display: "flex", alignItems: "center", gap: 12,
          opacity: 0.55,
          borderBottom: "0.5px solid rgba(0,0,0,0.06)",
          cursor: "text",
        }}
          onClick={() => { setCreating(true); window.setTimeout(() => inputRef.current?.focus(), 0); }}
        >
          <Plus size={14} color="#9CA3AF" />
          <span style={{ flex: 1, fontSize: 13, color: "#9CA3AF" }}>
            Add a habit...
          </span>
          <span style={{
            fontSize: 11, color: "#9CA3AF",
            background: "rgba(0,0,0,0.05)",
            padding: "2px 8px", borderRadius: 99,
          }}>
            habit
          </span>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {habits.map((h) => (
            <div
              key={h.id}
              onMouseEnter={() => setHoverId(h.id)}
              onMouseLeave={() => setHoverId(null)}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto auto auto",
                alignItems: "center",
                gap: 12,
                padding: "6px 10px",
                borderRadius: 6,
                background: hoverId === h.id ? "rgba(0,0,0,0.025)" : "transparent",
              }}
            >
              {/* Name w/ color dot — fontSize matches todo row body text. */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--gooni-text, #1C1C1E)" }}>
                <span style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: h.color || "#22C55E", flexShrink: 0,
                }} />
                {h.name}
              </div>

              {/* 7-day strip */}
              <div style={{ display: "flex", gap: 3 }}>
                {h.recent.map((cell, idx) => {
                  const isToday = idx === h.recent.length - 1;
                  return (
                    <button
                      key={cell.date}
                      onClick={() => handleCellClick(h, cell)}
                      title={`${cell.date}: ${cell.value === true ? "yes" : cell.value === false ? "no" : "unlogged"}`}
                      style={{
                        width: 22, height: 22,
                        borderRadius: 4,
                        border: isToday ? "1.5px solid #0F172A" : "none",
                        background: cellColor(cell.value, h.color),
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 0,
                      }}
                    >
                      <CellIcon value={cell.value} />
                    </button>
                  );
                })}
              </div>

              {/* Streak counter */}
              <div style={{
                fontSize: 12, color: "#475569", fontVariantNumeric: "tabular-nums",
                minWidth: 32, textAlign: "right",
              }}>
                {h.streak > 0 ? `🔥${h.streak}` : "—"}
              </div>

              {/* Delete on hover — same two-step confirm as todos. */}
              <div style={{ visibility: hoverId === h.id ? "visible" : "hidden" }}>
                <ConfirmDeleteButton
                  onConfirm={() => void handleDelete(h.id)}
                  size={14}
                  title="Delete habit"
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Inline create row — same shape as TodoList's add-todo row.
          Click anywhere to focus; Esc collapses; Enter saves. */}
      {(creating || habits.length > 0) && (
        <div
          onClick={() => { setCreating(true); window.setTimeout(() => inputRef.current?.focus(), 0); }}
          style={{
            padding: "10px 16px",
            display: "flex", alignItems: "center", gap: 12,
            opacity: creating ? 1 : 0.55,
            borderBottom: "0.5px solid rgba(0,0,0,0.06)",
            cursor: "text",
            marginTop: 8,
          }}
        >
          <Plus size={14} color="#9CA3AF" />
          {creating ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void handleCreate(); }
                if (e.key === "Escape") { e.preventDefault(); setCreating(false); setDraft(""); }
              }}
              onBlur={() => { if (!draft.trim()) setCreating(false); }}
              placeholder="e.g. went to gym"
              style={{
                flex: 1, border: "none", outline: "none",
                fontFamily: FONT, fontSize: 13, background: "transparent",
                color: "var(--gooni-text, #1C1C1E)",
              }}
            />
          ) : (
            <span style={{ flex: 1, fontSize: 13, color: "#9CA3AF" }}>
              Add a habit...
            </span>
          )}
          <span style={{
            fontSize: 11, color: "#9CA3AF",
            background: "rgba(0,0,0,0.05)",
            padding: "2px 8px", borderRadius: 99,
          }}>
            habit
          </span>
        </div>
      )}
    </div>
  );
}
