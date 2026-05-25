import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { FONT } from "../../ui";
import { ItemCard, SectionHeader, AddItemRow, StatusDot } from "./TrackerPrimitives";
import { HabitWeekStrip, streakLabel, nextValue, type Polarity } from "./habitCells";
import { HabitDetailModal } from "./HabitDetailModal";

// HabitsStrip — bottom-of-dashboard daily binary trackers. Now shares the
// todos card pattern (ItemCard / SectionHeader / AddItemRow) so habits,
// todos, and promises read as one family. Each row opens HabitDetailModal
// on click; the 7-day strip cells stay individually clickable (they
// stopPropagation so logging a day doesn't open the modal). Cell + streak
// semantics live in ./habitCells, shared with the modal.

export function HabitsStrip() {
  const qc = useQueryClient();
  const { data: habits = [] } = useQuery<ApiHabit[]>({
    queryKey: ["habits"],
    queryFn: fetchHabits,
  });
  const [draftPolarity, setDraftPolarity] = useState<Polarity>("positive");
  const [openId, setOpenId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ["habits"] });
  const openHabit = habits.find((h) => h.id === openId) ?? null;

  async function handleCellClick(habit: ApiHabit, cell: ApiHabitCell) {
    const next = nextValue(cell.value, habit.polarity);
    if (next === null) await unlogHabitEntry(habit.id, cell.date);
    else await setHabitEntry(habit.id, cell.date, next);
    refresh();
  }

  async function handleCreate(name: string) {
    await createHabit(name, draftPolarity);
    setDraftPolarity("positive");
    refresh();
  }

  async function handleDelete(id: number) {
    await deleteHabit(id);
    refresh();
  }

  return (
    <div style={{ marginTop: 28, fontFamily: FONT }}>
      <SectionHeader label="habits" onAdd={() => setAdding(true)} addTitle="Add a habit" />

      {habits.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {habits.map((h) => {
            const isBreak = h.polarity === "negative";
            return (
              <ItemCard key={h.id} onClick={() => setOpenId(h.id)}>
                {(hover) => (
                  <>
                    <StatusDot color={h.color || "#22C55E"} title={h.name} />
                    <span style={{
                      flex: 1, minWidth: 0,
                      fontSize: 14, color: "var(--gooni-text, #1C1C1E)",
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}>
                      {h.name}
                    </span>

                    {/* Build/break label — read-only here; edit in the modal. */}
                    <span style={{
                      fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
                      textTransform: "uppercase",
                      color: isBreak ? "#B91C1C" : "#15803D",
                      background: isBreak ? "rgba(239,68,68,0.10)" : "rgba(34,197,94,0.10)",
                      padding: "2px 7px", borderRadius: 99, flexShrink: 0,
                    }}>
                      {isBreak ? "break" : "build"}
                    </span>

                    <HabitWeekStrip habit={h} onCellClick={(c) => handleCellClick(h, c)} />

                    <span style={{
                      fontSize: 12, color: "#475569", fontVariantNumeric: "tabular-nums",
                      minWidth: 44, textAlign: "right", flexShrink: 0,
                    }}>
                      {streakLabel(h)}
                    </span>

                    <span
                      onClick={(e) => e.stopPropagation()}
                      style={{ visibility: hover ? "visible" : "hidden", flexShrink: 0 }}
                    >
                      <ConfirmDeleteButton
                        onConfirm={() => void handleDelete(h.id)}
                        size={14}
                        title="Delete habit"
                      />
                    </span>
                  </>
                )}
              </ItemCard>
            );
          })}
        </div>
      )}

      <AddItemRow
        pill="habit"
        open={adding}
        onOpenChange={setAdding}
        placeholder={draftPolarity === "negative" ? "e.g. vaping" : "e.g. went to gym"}
        onSubmit={(text) => void handleCreate(text)}
        trailing={
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault() /* keep input focus */}
            onClick={() => setDraftPolarity(draftPolarity === "negative" ? "positive" : "negative")}
            title="Toggle build / break"
            style={{
              fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
              color: draftPolarity === "negative" ? "#B91C1C" : "#15803D",
              background: draftPolarity === "negative" ? "rgba(239,68,68,0.10)" : "rgba(34,197,94,0.10)",
              border: "none", padding: "2px 7px", borderRadius: 99,
              cursor: "pointer", textTransform: "uppercase",
            }}
          >
            {draftPolarity === "negative" ? "break" : "build"}
          </button>
        }
      />

      {openHabit && (
        <HabitDetailModal habit={openHabit} onClose={() => setOpenId(null)} />
      )}
    </div>
  );
}
