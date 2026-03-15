import { useEffect, useRef, useState } from "react";
import { fetchGoalNotes, linkNoteToGoal as apiLinkNoteToGoal, type ApiNote } from "../services/api";
import { useGoalsStore } from "../stores/useGoalsStore";
import { useJarvisStore } from "../stores/useJarvisStore";

interface GoalViewProps {
  onOpenNote: (noteId: number, spaceId: string) => void;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function GoalView({ onOpenNote }: GoalViewProps) {
  const { goals, selectedGoalId, update: updateGoal } = useGoalsStore();
  const { isOpen: jarvisOpen, toggle: toggleJarvis, send: sendJarvis } = useJarvisStore();

  const goal = goals.find((g) => g.id === selectedGoalId) ?? null;

  const [localTitle, setLocalTitle] = useState(goal?.title ?? "");
  const [localMotivation, setLocalMotivation] = useState(goal?.motivation ?? "");
  const [linkedNotes, setLinkedNotes] = useState<ApiNote[]>([]);
  const [newMilestone, setNewMilestone] = useState("");
  const [addingMilestone, setAddingMilestone] = useState(false);
  const milestoneInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLocalTitle(goal?.title ?? "");
    setLocalMotivation(goal?.motivation ?? "");
    setLinkedNotes([]);
    if (goal) {
      fetchGoalNotes(goal.id).then(setLinkedNotes).catch(() => {});
    }
  }, [selectedGoalId]);

  if (!goal) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ color: "#AEAEB2", fontSize: 15, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>
          Select a goal
        </span>
      </div>
    );
  }

  async function handleTitleBlur() {
    const t = localTitle.trim();
    if (t && t !== goal?.title) {
      await updateGoal(goal!.id, { title: t });
    }
  }

  async function handleMotivationBlur() {
    const m = localMotivation.trim() || null;
    if (m !== goal?.motivation) {
      await updateGoal(goal!.id, { motivation: m ?? undefined });
    }
  }

  async function handleStatusChange(e: React.ChangeEvent<HTMLSelectElement>) {
    await updateGoal(goal!.id, { status: e.target.value as "active" | "completed" | "paused" | "abandoned" });
  }

  async function toggleMilestone(id: string) {
    const updated = goal!.milestones.map((m) =>
      m.id === id ? { ...m, done: !m.done } : m
    );
    await updateGoal(goal!.id, { milestones: updated });
  }

  async function addMilestone() {
    const text = newMilestone.trim();
    if (!text) { setAddingMilestone(false); return; }
    const newM = { id: String(Date.now()), text, done: false };
    await updateGoal(goal!.id, { milestones: [...goal!.milestones, newM] });
    setNewMilestone("");
    setAddingMilestone(false);
  }

  function handleMilestoneKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") addMilestone();
    if (e.key === "Escape") { setAddingMilestone(false); setNewMilestone(""); }
  }

  async function handleHowAmIDoing() {
    const notesSummary = linkedNotes.slice(0, 10).map((n) => {
      const text = (n.content ?? "").replace(/<[^>]+>/g, " ").trim().slice(0, 300);
      return `Note: "${n.title || "Untitled"}"\n${text}`;
    }).join("\n\n");

    const prompt = [
      `My goal: "${goal!.title}"`,
      goal!.motivation ? `Why: ${goal!.motivation}` : null,
      linkedNotes.length > 0
        ? `\nRecent notes for this goal:\n\n${notesSummary}`
        : `\n(No notes linked yet.)`,
      `\nHow am I doing on this goal? Be honest, specific, and encouraging.`,
    ].filter(Boolean).join("\n");

    if (!jarvisOpen) toggleJarvis();
    await sendJarvis(prompt);
  }

  async function handleUnlinkNote(noteId: number) {
    await apiLinkNoteToGoal(noteId, null);
    setLinkedNotes((prev) => prev.filter((n) => n.id !== noteId));
  }

  const statusColors: Record<string, string> = {
    active: "#34C759",
    completed: "#007AFF",
    paused: "#FF9500",
    abandoned: "#FF3B30",
  };

  const font = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";

  return (
    <div style={{ flex: 1, height: "100vh", background: "#FFFFFF", display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
      {/* Header bar */}
      <div style={{ height: 52, padding: "0 20px", borderBottom: "1px solid rgba(0,0,0,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: "#8E8E93", fontFamily: font }}>
            {goal.goal_type === "avoid" ? "AVOID" : "ACHIEVE"}
          </span>
          <select
            value={goal.status}
            onChange={handleStatusChange}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: statusColors[goal.status] ?? "#8E8E93",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontFamily: font,
              outline: "none",
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
          >
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="paused">Paused</option>
            <option value="abandoned">Abandoned</option>
          </select>
        </div>
        <button
          onClick={toggleJarvis}
          title={jarvisOpen ? "Close Jarvis" : "Open Jarvis"}
          style={{
            padding: "5px 12px", borderRadius: 16, border: "none",
            background: jarvisOpen ? "rgba(0,0,0,0.08)" : "rgba(0,0,0,0.05)",
            cursor: "pointer", fontSize: 13,
            color: jarvisOpen ? "#1C1C1E" : "#636366",
            fontFamily: font, fontWeight: jarvisOpen ? 600 : 400,
            display: "flex", alignItems: "center", gap: 5,
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.10)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = jarvisOpen ? "rgba(0,0,0,0.08)" : "rgba(0,0,0,0.05)")}
        >
          💬 Jarvis
        </button>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "32px 48px", boxSizing: "border-box", maxWidth: 740, width: "100%", margin: "0 auto" }}>

        {/* Title */}
        <input
          value={localTitle}
          onChange={(e) => setLocalTitle(e.target.value)}
          onBlur={handleTitleBlur}
          placeholder="Goal title"
          style={{
            display: "block", width: "100%", fontSize: 28, fontWeight: 700,
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
            color: "#1C1C1E", border: "none", outline: "none",
            background: "transparent", marginBottom: 24, padding: 0, lineHeight: 1.3,
            boxSizing: "border-box",
          }}
        />

        {/* WHY section */}
        <div style={{ marginBottom: 24 }}>
          <p style={{ fontSize: 11, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.6, margin: "0 0 8px", fontFamily: font }}>WHY</p>
          <textarea
            value={localMotivation}
            onChange={(e) => setLocalMotivation(e.target.value)}
            onBlur={handleMotivationBlur}
            placeholder="Why does this goal matter to you?"
            rows={3}
            style={{
              width: "100%", fontSize: 15, fontFamily: font, color: "#1C1C1E",
              border: "none", outline: "none", background: "rgba(0,0,0,0.03)",
              borderRadius: 8, padding: "10px 12px", boxSizing: "border-box",
              resize: "vertical", lineHeight: 1.6,
            }}
          />
        </div>

        {/* How am I doing button */}
        <button
          onClick={handleHowAmIDoing}
          style={{
            padding: "8px 20px", borderRadius: 20, border: "none",
            background: "#007AFF", color: "#fff", fontSize: 14, fontWeight: 600,
            cursor: "pointer", fontFamily: font, marginBottom: 32,
            display: "inline-flex", alignItems: "center", gap: 6,
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "#0066DD")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "#007AFF")}
        >
          🤔 How am I doing?
        </button>

        {/* Milestones */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.6, margin: 0, fontFamily: font }}>MILESTONES</p>
            <button
              onClick={() => { setAddingMilestone(true); setTimeout(() => milestoneInputRef.current?.focus(), 0); }}
              style={{ fontSize: 12, color: "#007AFF", background: "none", border: "none", cursor: "pointer", fontFamily: font, padding: "2px 6px" }}
            >+ Add</button>
          </div>
          {goal.milestones.map((m) => (
            <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={m.done}
                onChange={() => toggleMilestone(m.id)}
                style={{ width: 16, height: 16, cursor: "pointer", flexShrink: 0 }}
              />
              <span style={{
                fontSize: 14, fontFamily: font, color: m.done ? "#AEAEB2" : "#1C1C1E",
                textDecoration: m.done ? "line-through" : "none",
              }}>
                {m.text}
              </span>
            </label>
          ))}
          {addingMilestone && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
              <input
                ref={milestoneInputRef}
                value={newMilestone}
                onChange={(e) => setNewMilestone(e.target.value)}
                onKeyDown={handleMilestoneKeyDown}
                onBlur={addMilestone}
                placeholder="New milestone..."
                style={{
                  flex: 1, fontSize: 14, fontFamily: font, color: "#1C1C1E",
                  border: "none", outline: "1px solid rgba(0,122,255,0.4)",
                  borderRadius: 6, padding: "5px 8px", background: "#fff",
                }}
              />
            </div>
          )}
          {goal.milestones.length === 0 && !addingMilestone && (
            <p style={{ fontSize: 13, color: "#AEAEB2", fontFamily: font, margin: 0 }}>No milestones yet.</p>
          )}
        </div>

        {/* Linked notes */}
        <div>
          <p style={{ fontSize: 11, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.6, margin: "0 0 10px", fontFamily: font }}>NOTES</p>
          {linkedNotes.length === 0 ? (
            <p style={{ fontSize: 13, color: "#AEAEB2", fontFamily: font, margin: 0 }}>No notes linked yet. Open a note and use the 🎯 chip to link it.</p>
          ) : (
            linkedNotes.map((n) => {
              const spaceId = n.space_id ? String(n.space_id) : "general";
              return (
                <div key={n.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid rgba(0,0,0,0.05)" }}>
                  <button
                    onClick={() => onOpenNote(n.id, spaceId)}
                    style={{ background: "none", border: "none", cursor: "pointer", textAlign: "left", flex: 1, padding: 0 }}
                  >
                    <span style={{ fontSize: 14, color: "#1C1C1E", fontFamily: font }}>
                      {n.title || "Untitled"}
                    </span>
                    <span style={{ fontSize: 12, color: "#AEAEB2", fontFamily: font, marginLeft: 10 }}>
                      {formatDate(n.updated_at)}
                    </span>
                  </button>
                  <button
                    onClick={() => handleUnlinkNote(n.id)}
                    title="Unlink note from goal"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#AEAEB2", fontSize: 16, padding: "0 4px", lineHeight: 1 }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#FF3B30")}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#AEAEB2")}
                  >×</button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
