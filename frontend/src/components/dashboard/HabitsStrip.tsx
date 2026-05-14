import { useState } from "react";
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

// HabitsStrip — bottom-of-dashboard widget for daily binary trackers.
// Each row: name + 7-day strip (oldest → newest) + current streak +
// hover-delete. Click any cell to cycle: empty → ✓ → ✗ → empty.
// Today's cell is the rightmost; highlighted with a subtle ring.
//
// Habits are always phrased positively. value=true means Daniel did the
// good thing (went to gym / stayed clean). `polarity` carries the
// underlying connotation for downstream colour decisions; the value
// semantics never invert.

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
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [hoverId, setHoverId] = useState<number | null>(null);

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
    if (!name) return;
    await createHabit(name);
    setDraft("");
    setAdding(false);
    qc.invalidateQueries({ queryKey: ["habits"] });
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm("Delete this habit? All history will be lost.")) return;
    await deleteHabit(id);
    qc.invalidateQueries({ queryKey: ["habits"] });
  };

  return (
    <div style={{ marginTop: 28, fontFamily: FONT }}>
      <div style={{
        fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
        color: "#94A3B8", textTransform: "uppercase",
        marginBottom: 10,
      }}>
        Habits
      </div>

      {habits.length === 0 && !adding ? (
        <div style={{ color: "#94A3B8", fontSize: 13 }}>
          No habits yet.{" "}
          <button
            onClick={() => setAdding(true)}
            style={{
              background: "none", border: "none", color: "#3B82F6",
              cursor: "pointer", padding: 0, fontSize: 13,
            }}
          >
            + add one
          </button>
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
                background: hoverId === h.id ? "#F8FAFC" : "transparent",
              }}
            >
              {/* Name w/ color dot */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#0F172A" }}>
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

              {/* Delete on hover */}
              <button
                onClick={() => handleDelete(h.id)}
                style={{
                  background: "none", border: "none",
                  cursor: "pointer", padding: 2,
                  visibility: hoverId === h.id ? "visible" : "hidden",
                  color: "#94A3B8",
                }}
                title="Delete habit"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Inline add */}
      {adding ? (
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
              if (e.key === "Escape") { setAdding(false); setDraft(""); }
            }}
            placeholder="e.g. went to gym"
            autoFocus
            style={{
              flex: 1, padding: "6px 10px",
              border: "1px solid #CBD5E1", borderRadius: 6,
              fontSize: 13, fontFamily: FONT,
            }}
          />
          <button
            onClick={handleCreate}
            style={{
              padding: "6px 12px", border: "none",
              background: "#0F172A", color: "white",
              borderRadius: 6, cursor: "pointer", fontSize: 12,
            }}
          >
            Add
          </button>
        </div>
      ) : habits.length > 0 ? (
        <button
          onClick={() => setAdding(true)}
          style={{
            background: "none", border: "1px dashed #CBD5E1",
            color: "#64748B", fontSize: 12, padding: "6px 10px",
            borderRadius: 6, cursor: "pointer", marginTop: 8,
            display: "inline-flex", alignItems: "center", gap: 4,
            fontFamily: FONT,
          }}
        >
          <Plus size={12} /> add habit
        </button>
      ) : null}
    </div>
  );
}
