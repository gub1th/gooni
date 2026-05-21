import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X, Check, Minus } from "lucide-react";
import {
  fetchHabits,
  createHabit,
  setHabitEntry,
  unlogHabitEntry,
  deleteHabit,
  patchHabit,
  type ApiHabit,
  type ApiHabitCell,
} from "../../services/api";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";

// HabitsStrip — bottom-of-dashboard widget for daily binary trackers.
// Two flavors:
//   build (positive)  — "went to gym". Cycle empty → ✓ → ✗ → empty.
//     Cell colors: ✓ green / ✗ red. Streak = consecutive ✓.
//   break (negative)  — "vaping". Cycle empty → slip(✓) → empty.
//     Cell colors: ✓ red (slip) / ✗ green (logged clean — rare).
//     Streak = days since last slip (sober-tracker).
// Weekday letters render above the 7-cell strip so the columns aren't
// mystery boxes. Today's cell + label get a darker ring/weight.
// Value semantics never invert: ✓ always = "did the literal action".

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
const DOW = ["S", "M", "T", "W", "T", "F", "S"];

type Polarity = "positive" | "negative";

function nextValue(current: boolean | null, polarity: Polarity): boolean | null {
  // Break habits skip the explicit-false state — slip-or-not is enough.
  if (polarity === "negative") {
    if (current === true) return null;
    return true;
  }
  if (current === null) return true;
  if (current === true) return false;
  return null;
}

function cellColor(
  value: boolean | null,
  habitColor: string | null,
  polarity: Polarity,
): string {
  const trueColor = polarity === "negative" ? "#EF4444" : (habitColor || "#22C55E");
  const falseColor = polarity === "negative" ? "#22C55E" : "#FCA5A5";
  if (value === true) return trueColor;
  if (value === false) return falseColor;
  return "#E2E8F0";
}

function CellIcon({ value }: { value: boolean | null }) {
  if (value === true) return <Check size={11} strokeWidth={3} color="white" />;
  if (value === false) return <X size={11} strokeWidth={3} color="white" />;
  return <Minus size={10} strokeWidth={2.5} color="#94A3B8" />;
}

function streakLabel(habit: ApiHabit): string {
  if (habit.streak <= 0) return "—";
  if (habit.polarity === "negative") return `💎 ${habit.streak}d`;
  return `🔥 ${habit.streak}`;
}

export function HabitsStrip() {
  const qc = useQueryClient();
  const { data: habits = [] } = useQuery<ApiHabit[]>({
    queryKey: ["habits"],
    queryFn: fetchHabits,
  });
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftPolarity, setDraftPolarity] = useState<Polarity>("positive");
  const [hoverId, setHoverId] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleCellClick = async (habit: ApiHabit, cell: ApiHabitCell) => {
    const next = nextValue(cell.value, habit.polarity);
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
    await createHabit(name, draftPolarity);
    setDraft("");
    setDraftPolarity("positive");
    setCreating(false);
    qc.invalidateQueries({ queryKey: ["habits"] });
  };

  const handleDelete = async (id: number) => {
    await deleteHabit(id);
    qc.invalidateQueries({ queryKey: ["habits"] });
  };

  const handleTogglePolarity = async (habit: ApiHabit) => {
    const next: Polarity = habit.polarity === "negative" ? "positive" : "negative";
    await patchHabit(habit.id, { polarity: next });
    qc.invalidateQueries({ queryKey: ["habits"] });
  };

  return (
    <div style={{ marginTop: 28, fontFamily: FONT }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        margin: "0 4px 8px",
      }}>
        <span style={{
          fontSize: 12, fontWeight: 500,
          color: "var(--gooni-muted, #6B7280)",
        }}>
          Habits
        </span>
        <button
          onClick={() => { setCreating(true); window.setTimeout(() => inputRef.current?.focus(), 0); }}
          title="Add a habit"
          style={{
            width: 24, height: 24, borderRadius: 6,
            background: "rgba(15,23,42,0.06)",
            color: "#0F172A",
            border: "0.5px solid rgba(15,23,42,0.10)",
            cursor: "pointer",
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
          {habits.map((h) => {
            const isBreak = h.polarity === "negative";
            return (
              <div
                key={h.id}
                onMouseEnter={() => setHoverId(h.id)}
                onMouseLeave={() => setHoverId(null)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto auto auto auto",
                  alignItems: "center",
                  gap: 12,
                  padding: "6px 10px",
                  borderRadius: 6,
                  background: hoverId === h.id ? "rgba(0,0,0,0.025)" : "transparent",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--gooni-text, #1C1C1E)" }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: h.color || "#22C55E", flexShrink: 0,
                  }} />
                  {h.name}
                </div>

                {/* Polarity chip — click toggles. Subtle until hover. */}
                <button
                  onClick={() => void handleTogglePolarity(h)}
                  title={isBreak ? "Break-a-habit (click to switch to build)" : "Build-a-habit (click to switch to break)"}
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: 0.4,
                    color: isBreak ? "#B91C1C" : "#15803D",
                    background: isBreak ? "rgba(239,68,68,0.10)" : "rgba(34,197,94,0.10)",
                    border: "none",
                    padding: "2px 7px",
                    borderRadius: 99,
                    cursor: "pointer",
                    opacity: hoverId === h.id ? 1 : 0.55,
                    textTransform: "uppercase",
                  }}
                >
                  {isBreak ? "break" : "build"}
                </button>

                {/* 7-day strip with weekday letters above each cell. */}
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ display: "flex", gap: 3 }}>
                    {h.recent.map((cell, idx) => {
                      const dow = new Date(cell.date + "T00:00:00").getDay();
                      const isToday = idx === h.recent.length - 1;
                      return (
                        <div
                          key={`${cell.date}-label`}
                          style={{
                            width: 22, textAlign: "center",
                            fontSize: 9, fontWeight: isToday ? 700 : 500,
                            color: isToday ? "#0F172A" : "#94A3B8",
                            letterSpacing: 0.3,
                          }}
                        >
                          {DOW[dow]}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", gap: 3 }}>
                    {h.recent.map((cell, idx) => {
                      const isToday = idx === h.recent.length - 1;
                      return (
                        <button
                          key={cell.date}
                          onClick={() => handleCellClick(h, cell)}
                          title={`${cell.date}: ${cell.value === true ? (isBreak ? "slip" : "yes") : cell.value === false ? (isBreak ? "clean (logged)" : "no") : "unlogged"}`}
                          style={{
                            width: 22, height: 22,
                            borderRadius: 4,
                            border: isToday ? "1.5px solid #0F172A" : "none",
                            background: cellColor(cell.value, h.color, h.polarity),
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
                </div>

                {/* Streak counter — fork on polarity. */}
                <div style={{
                  fontSize: 12, color: "#475569", fontVariantNumeric: "tabular-nums",
                  minWidth: 48, textAlign: "right",
                }}>
                  {streakLabel(h)}
                </div>

                <div style={{ visibility: hoverId === h.id ? "visible" : "hidden" }}>
                  <ConfirmDeleteButton
                    onConfirm={() => void handleDelete(h.id)}
                    size={14}
                    title="Delete habit"
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

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
            <>
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void handleCreate(); }
                  if (e.key === "Escape") { e.preventDefault(); setCreating(false); setDraft(""); setDraftPolarity("positive"); }
                }}
                onBlur={() => { if (!draft.trim()) { setCreating(false); setDraftPolarity("positive"); } }}
                placeholder={draftPolarity === "negative" ? "e.g. vaping" : "e.g. went to gym"}
                style={{
                  flex: 1, border: "none", outline: "none",
                  fontFamily: FONT, fontSize: 13, background: "transparent",
                  color: "var(--gooni-text, #1C1C1E)",
                }}
              />
              {/* Polarity toggle while typing — click flips build ↔ break. */}
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault() /* keep input focus */}
                onClick={() => setDraftPolarity(draftPolarity === "negative" ? "positive" : "negative")}
                title="Toggle build / break"
                style={{
                  fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
                  color: draftPolarity === "negative" ? "#B91C1C" : "#15803D",
                  background: draftPolarity === "negative" ? "rgba(239,68,68,0.10)" : "rgba(34,197,94,0.10)",
                  border: "none",
                  padding: "2px 7px",
                  borderRadius: 99,
                  cursor: "pointer",
                  textTransform: "uppercase",
                }}
              >
                {draftPolarity === "negative" ? "break" : "build"}
              </button>
            </>
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
