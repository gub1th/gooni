import { Check, X, Minus } from "lucide-react";
import type { ApiHabit, ApiHabitCell } from "../../services/api";

// Shared habit-cell logic + the 7-day strip, so the dashboard row and the
// HabitDetailModal render the tracker identically.
//
// Value semantics never invert: ✓ always = "did the literal action".
//   build (positive)  — "went to gym". empty → ✓ → ✗ → empty.
//     ✓ green / ✗ red. Streak = consecutive ✓.
//   break (negative)  — "vaping". empty → slip(✓) → empty.
//     ✓ red (slip) / streak = days since last slip (sober-tracker).
// Weekday letters render above each cell; today's cell + label get a ring.

export type Polarity = "positive" | "negative";

const DOW = ["S", "M", "T", "W", "T", "F", "S"];

export function nextValue(current: boolean | null, polarity: Polarity): boolean | null {
  // Break habits skip the explicit-false state — slip-or-not is enough.
  if (polarity === "negative") {
    if (current === true) return null;
    return true;
  }
  if (current === null) return true;
  if (current === true) return false;
  return null;
}

export function cellColor(
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

export function CellIcon({ value }: { value: boolean | null }) {
  if (value === true) return <Check size={11} strokeWidth={3} color="white" />;
  if (value === false) return <X size={11} strokeWidth={3} color="white" />;
  return <Minus size={10} strokeWidth={2.5} color="#94A3B8" />;
}

export function streakLabel(habit: ApiHabit): string {
  if (habit.streak <= 0) return "—";
  if (habit.polarity === "negative") return `💎 ${habit.streak}d`;
  return `🔥 ${habit.streak}`;
}

// Plain-language description of what ✓ means for each polarity — used in
// the modal so the inversion (break: ✓ = slip) stops being a mystery.
export function checkMeaning(polarity: Polarity): string {
  return polarity === "negative"
    ? "Tap a day only when you slip. Streak counts the days clean since your last slip."
    : "Tap a day when you did it. Streak counts consecutive days done.";
}

export function HabitWeekStrip({
  habit,
  onCellClick,
  cellSize = 22,
}: {
  habit: ApiHabit;
  onCellClick: (cell: ApiHabitCell) => void;
  cellSize?: number;
}) {
  const isBreak = habit.polarity === "negative";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ display: "flex", gap: 3 }}>
        {habit.recent.map((cell, idx) => {
          const dow = new Date(cell.date + "T00:00:00").getDay();
          const isToday = idx === habit.recent.length - 1;
          return (
            <div
              key={`${cell.date}-label`}
              style={{
                width: cellSize,
                textAlign: "center",
                fontSize: 9,
                fontWeight: isToday ? 700 : 500,
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
        {habit.recent.map((cell, idx) => {
          const isToday = idx === habit.recent.length - 1;
          const valueLabel =
            cell.value === true
              ? isBreak ? "slip" : "yes"
              : cell.value === false
                ? isBreak ? "clean (logged)" : "no"
                : "unlogged";
          return (
            <button
              key={cell.date}
              onClick={(e) => {
                e.stopPropagation();
                onCellClick(cell);
              }}
              title={`${cell.date}: ${valueLabel}`}
              style={{
                width: cellSize,
                height: cellSize,
                borderRadius: 4,
                border: isToday ? "1.5px solid #0F172A" : "none",
                background: cellColor(cell.value, habit.color, habit.polarity),
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
  );
}
