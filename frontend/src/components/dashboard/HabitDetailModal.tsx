import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import {
  patchHabit,
  deleteHabit,
  setHabitEntry,
  unlogHabitEntry,
  type ApiHabit,
  type ApiHabitCell,
} from "../../services/api";
import { Modal, FONT, color as ctok } from "../../ui";
import {
  HabitWeekStrip,
  streakLabel,
  checkMeaning,
  nextValue,
  type Polarity,
} from "./habitCells";

// Full-details view for a habit — mirrors TodoEditModal's role for todos.
// Edit name, flip build/break (with a plain-language explainer of what ✓
// means so the break-habit inversion stops confusing), recolor, log days
// on the strip, see the streak, delete.

// Mirrors backend habit_service._COLOR_PALETTE.
const PALETTE = [
  "#22C55E", "#3B82F6", "#F59E0B", "#A855F7", "#EF4444",
  "#06B6D4", "#EC4899", "#84CC16", "#F97316", "#14B8A6",
];

export function HabitDetailModal({
  habit,
  onClose,
}: {
  habit: ApiHabit;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(habit.name);
  const [polarity, setPolarity] = useState<Polarity>(habit.polarity);
  const [color, setColor] = useState(habit.color || PALETTE[0]);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ["habits"] });

  const dirty =
    name.trim() !== habit.name ||
    polarity !== habit.polarity ||
    color !== (habit.color || PALETTE[0]);

  async function onSave() {
    if (saving || !name.trim()) return;
    setSaving(true);
    try {
      await patchHabit(habit.id, { name: name.trim(), polarity, color });
      refresh();
      onClose();
    } catch (e) {
      console.error("save habit failed", e);
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    try {
      await deleteHabit(habit.id);
      refresh();
      onClose();
    } catch (e) {
      console.error("delete habit failed", e);
    }
  }

  async function onCellClick(cell: ApiHabitCell) {
    // Use the in-modal polarity so toggling build/break previews correctly
    // before save isn't needed — entries are polarity-agnostic (✓ always
    // = did the action); we just need the cycle rule for the next value.
    const next = nextValue(cell.value, habit.polarity);
    try {
      if (next === null) await unlogHabitEntry(habit.id, cell.date);
      else await setHabitEntry(habit.id, cell.date, next);
      refresh();
    } catch (e) {
      console.error("log habit entry failed", e);
    }
  }

  const isBreak = polarity === "negative";

  return (
    <Modal open onClose={onClose} title="Habit" width={460} disableBackdropClose
      footer={
        <>
          <button
            onClick={() => setConfirmDel((v) => !v)}
            title="Delete habit"
            style={{
              marginRight: "auto",
              background: "none", border: "none", padding: 0, cursor: "pointer",
              fontSize: 12, color: confirmDel ? "#B91C1C" : ctok.muted,
              display: "inline-flex", alignItems: "center", gap: 5, fontFamily: FONT,
            }}
          >
            <Trash2 size={12} />
            {confirmDel ? "click confirm →" : "delete"}
          </button>
          {confirmDel && (
            <button onClick={onDelete} style={btnDanger}>Confirm delete</button>
          )}
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button
            onClick={() => void onSave()}
            disabled={saving || !name.trim() || !dirty}
            style={{
              ...btnPrimary,
              opacity: saving || !name.trim() || !dirty ? 0.5 : 1,
              cursor: saving || !name.trim() || !dirty ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 18, fontFamily: FONT }}>
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. went to gym"
            style={inputStyle}
          />
        </Field>

        <Field label="Type">
          <div style={{ display: "flex", gap: 6 }}>
            {(["positive", "negative"] as Polarity[]).map((p) => {
              const active = polarity === p;
              const label = p === "positive" ? "Build" : "Break";
              return (
                <button
                  key={p}
                  onClick={() => setPolarity(p)}
                  style={{
                    flex: 1, padding: "8px 10px", borderRadius: 8,
                    border: active ? "1px solid rgba(15,23,42,0.85)" : "0.5px solid rgba(0,0,0,0.10)",
                    background: active ? "rgba(15,23,42,0.05)" : "transparent",
                    color: active ? "var(--gooni-text, #0F172A)" : ctok.muted,
                    fontWeight: active ? 600 : 500, fontSize: 13,
                    cursor: "pointer", fontFamily: FONT,
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div style={{
            marginTop: 8, fontSize: 12, lineHeight: 1.5,
            color: ctok.muted,
            background: isBreak ? "rgba(239,68,68,0.06)" : "rgba(34,197,94,0.06)",
            border: `0.5px solid ${isBreak ? "rgba(239,68,68,0.18)" : "rgba(34,197,94,0.18)"}`,
            borderRadius: 8, padding: "8px 10px",
          }}>
            {checkMeaning(polarity)}
          </div>
        </Field>

        <Field label="Color">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {PALETTE.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                aria-label={`color ${c}`}
                style={{
                  width: 24, height: 24, borderRadius: "50%",
                  background: c, cursor: "pointer",
                  border: color === c ? "2px solid #0F172A" : "2px solid transparent",
                  outline: color === c ? "none" : "0.5px solid rgba(0,0,0,0.10)",
                  padding: 0,
                }}
              />
            ))}
          </div>
        </Field>

        <Field label="Last 7 days">
          <div style={{ display: "flex", alignItems: "flex-end", gap: 16 }}>
            <HabitWeekStrip habit={habit} onCellClick={onCellClick} />
            <span style={{
              fontSize: 13, color: "var(--gooni-muted, #475569)", fontVariantNumeric: "tabular-nums",
              paddingBottom: 2,
            }}>
              {streakLabel(habit)}
            </span>
          </div>
        </Field>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{
        fontSize: 10, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase",
        color: ctok.muted,
      }}>
        {label}
      </span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 8,
  border: "0.5px solid rgba(0,0,0,0.14)",
  background: "var(--gooni-card, #fff)", color: "var(--gooni-text, #1C1C1E)",
  fontSize: 13, fontFamily: FONT, outline: "none", boxSizing: "border-box",
};

const btnSecondary: React.CSSProperties = {
  padding: "8px 14px", borderRadius: 8,
  border: "0.5px solid rgba(0,0,0,0.12)", background: "transparent",
  color: "var(--gooni-text, #1C1C1E)", fontSize: 13, fontWeight: 500,
  cursor: "pointer", fontFamily: FONT,
};

const btnPrimary: React.CSSProperties = {
  padding: "8px 16px", borderRadius: 8, border: "none",
  background: "#0F172A", color: "#fff", fontSize: 13, fontWeight: 600,
  cursor: "pointer", fontFamily: FONT,
};

const btnDanger: React.CSSProperties = {
  padding: "8px 14px", borderRadius: 8, border: "none",
  background: "#C76B6B", color: "#fff", fontSize: 13, fontWeight: 600,
  cursor: "pointer", fontFamily: FONT,
};
