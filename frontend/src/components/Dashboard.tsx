import { useState, useEffect } from "react";
import { fetchDashboardStats, type DashboardStats } from "../services/api";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { NoteEditor } from "./notes/NoteEditor";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";
const DISPLAY_FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function getDateStr(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

// GitHub contribution-graph palette (light mode)
const CHART_COLORS = ["#EBEDF0", "#9BE9A8", "#40C463", "#30A14E", "#216E39"];

function DayChart({ notes, activity, mode }: { notes: number[]; activity: number[]; mode: "bars" | "squares" }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...notes);
  const now = new Date();
  const series = mode === "squares" ? activity : notes;

  const tooltipText = (i: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (6 - i));
    const dayLabel = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    if (mode === "squares") {
      return `${dayLabel} — ${activity[i] ? "active" : "no activity"}`;
    }
    return `${dayLabel} — ${notes[i]} note${notes[i] === 1 ? "" : "s"}`;
  };

  return (
    <div style={{ position: "relative", display: "flex", alignItems: mode === "bars" ? "flex-end" : "center", gap: 3, height: 36 }}>
      {series.map((val, i) => {
        let color: string;
        let width: number;
        let height: number;
        if (mode === "squares") {
          color = val > 0 ? CHART_COLORS[2] : CHART_COLORS[0];
          width = 10;
          height = 10;
        } else {
          const level = val === 0 ? 0 : val <= 2 ? 1 : val <= 5 ? 2 : val <= 9 ? 3 : 4;
          color = CHART_COLORS[level];
          width = 6;
          height = Math.max(4, (val / max) * 36);
        }
        return (
          <div
            key={i}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered((h) => (h === i ? null : h))}
            style={{ width, height, background: color, borderRadius: 2, cursor: "default" }}
          />
        );
      })}
      {hovered !== null && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            right: 0,
            background: "#1C1C1E",
            color: "#fff",
            fontSize: 11.5,
            padding: "4px 8px",
            borderRadius: 6,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            zIndex: 10,
          }}
        >
          {tooltipText(hovered)}
        </div>
      )}
    </div>
  );
}

function formatNoteDate(iso: string | null): string {
  if (!iso) return "—";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const diffDays = Math.floor((Date.now() - new Date(hasOffset ? iso : iso + "Z").getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 14) return "1w ago";
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

export function Dashboard({ onOpenNote }: { onOpenNote: () => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const { selectSpace, loadNotes, selectNote } = useNotesContentStore();

  useEffect(() => {
    fetchDashboardStats().then(setStats).catch(console.error);
  }, []);

  function openNote(spaceId: number | null, noteId: number) {
    const sid = spaceId == null ? "general" : String(spaceId);
    selectSpace(sid);
    loadNotes(sid).then(() => selectNote(noteId));
    onOpenNote();
  }

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "#FAFAFA", fontFamily: FONT }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "48px 40px 120px" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 32 }}>
          <div style={{ fontSize: 34, fontWeight: 700, fontFamily: DISPLAY_FONT, color: "#1C1C1E", letterSpacing: "-0.5px", lineHeight: 1.15 }}>
            {getGreeting()}, Daniel.
          </div>
          <div style={{ fontSize: 12.5, color: "#8E8E93", display: "flex", alignItems: "center", gap: 4, paddingTop: 10 }}>
            <span>◷</span><span>{getDateStr()}</span>
          </div>
        </div>

        {/* Stats row */}
        <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
          {[
            { label: "notes this week", value: stats?.notes_this_week ?? "—", mode: "bars" as const },
            { label: "day streak", value: stats?.streak ?? "—", mode: "squares" as const },
          ].map(({ label, value, mode }) => (
            <div key={label} style={{
              flex: 1, background: "#fff", border: "1px solid rgba(0,0,0,0.07)",
              borderRadius: 12, padding: "16px 20px",
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14,
            }}>
              <div>
                <div style={{ fontSize: 26, fontWeight: 700, color: "#1C1C1E", fontFamily: DISPLAY_FONT }}>{value}</div>
                <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 2 }}>{label}</div>
              </div>
              <DayChart
                notes={stats?.notes_per_day ?? [0, 0, 0, 0, 0, 0, 0]}
                activity={stats?.activity_per_day ?? [0, 0, 0, 0, 0, 0, 0]}
                mode={mode}
              />
            </div>
          ))}
        </div>

        {/* Quick note */}
        <div style={{ marginBottom: 24 }}>
          <NoteEditor variant="embedded" />
        </div>

        {/* Gooni's Take */}
        {stats?.gooni_take && (
          <div style={{ border: "2px solid #1C1C1E", borderRadius: 14, padding: "18px 22px", marginBottom: 36, background: "#fff" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <div style={{
                width: 24, height: 24, borderRadius: "50%", background: "#1C1C1E",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#fff", fontSize: 11, fontWeight: 700, flexShrink: 0,
              }}>G</div>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "#1C1C1E" }}>Gooni's Take</span>
            </div>
            <p style={{ fontSize: 14.5, color: "#1C1C1E", lineHeight: 1.7, margin: 0 }}>
              {stats.gooni_take}
            </p>
          </div>
        )}

        {/* Recent notes */}
        <div style={{ marginBottom: 44 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#8E8E93", letterSpacing: 0.5, marginBottom: 10 }}>RECENT NOTES</div>
          {stats ? (
            stats.recent_notes.length === 0 ? (
              <p style={{ fontSize: 13.5, color: "#C7C7CC" }}>No notes yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {stats.recent_notes.map((note) => (
                  <button
                    key={note.id}
                    onClick={() => openNote(note.space_id, note.id)}
                    style={{
                      display: "flex", alignItems: "baseline", justifyContent: "space-between",
                      gap: 12, padding: "10px 12px", borderRadius: 8,
                      border: "none", background: "transparent", cursor: "pointer",
                      textAlign: "left", width: "100%",
                    }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)")}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
                  >
                    <span style={{
                      fontSize: 14, color: "#1C1C1E", fontFamily: FONT,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
                    }}>
                      {note.title || "Untitled"}
                    </span>
                    <span style={{ fontSize: 12, color: "#AEAEB2", flexShrink: 0 }}>
                      {formatNoteDate(note.updated_at)}
                    </span>
                  </button>
                ))}
              </div>
            )
          ) : (
            <p style={{ fontSize: 13.5, color: "#C7C7CC" }}>Loading…</p>
          )}
        </div>

      </div>
    </div>
  );
}
