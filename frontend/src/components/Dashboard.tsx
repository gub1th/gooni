import { useState, useEffect } from "react";
import { fetchDashboardStats, fetchPublicProfile, updatePublicProfile, type DashboardStats } from "../services/api";
import { useNotesContentStore } from "../stores/useNotesContentStore";

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
const DISPLAY_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function getDateStr(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
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
  const [bio, setBio] = useState("");
  const [bioSaved, setBioSaved] = useState(false);
  const [bioSaving, setBioSaving] = useState(false);
  const { selectSpace, loadNotes, selectNote } = useNotesContentStore();

  useEffect(() => {
    fetchDashboardStats().then(setStats).catch(console.error);
    fetchPublicProfile().then((p) => setBio(p.bio ?? "")).catch(() => {});
  }, []);

  async function handleSaveBio() {
    setBioSaving(true);
    try {
      await updatePublicProfile(bio);
      setBioSaved(true);
      setTimeout(() => setBioSaved(false), 2500);
    } finally {
      setBioSaving(false);
    }
  }

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
        <div style={{ display: "flex", gap: 12, marginBottom: 28 }}>
          {[
            { label: "notes this week", value: stats?.notes_this_week ?? "—" },
            { label: "day streak", value: stats?.streak ?? "—" },
          ].map(({ label, value }) => (
            <div key={label} style={{
              flex: 1, background: "#fff", border: "1px solid rgba(0,0,0,0.07)",
              borderRadius: 12, padding: "16px 20px",
            }}>
              <div style={{ fontSize: 26, fontWeight: 700, color: "#1C1C1E", fontFamily: DISPLAY_FONT }}>{value}</div>
              <div style={{ fontSize: 12, color: "#8E8E93", marginTop: 2 }}>{label}</div>
            </div>
          ))}
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

        {/* Public bio */}
        <div style={{ paddingTop: 32, borderTop: "1px solid rgba(0,0,0,0.07)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#8E8E93", letterSpacing: 0.5, marginBottom: 10 }}>PUBLIC BIO</div>
          <p style={{ fontSize: 12.5, color: "#8E8E93", margin: "0 0 12px" }}>
            What visitors see on your public portfolio page.
          </p>
          <textarea
            value={bio}
            onChange={(e) => { setBio(e.target.value); setBioSaved(false); }}
            placeholder="Write a short bio — who you are, what you're building..."
            rows={4}
            style={{
              width: "100%", padding: "10px 14px", borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.12)", fontSize: 14, fontFamily: FONT,
              color: "#1C1C1E", outline: "none", resize: "vertical",
              boxSizing: "border-box", lineHeight: 1.65,
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
            <button
              onClick={handleSaveBio}
              disabled={bioSaving}
              style={{
                padding: "8px 18px", borderRadius: 8, border: "none",
                background: "#1C1C1E", color: "#fff", fontSize: 13,
                fontFamily: FONT, cursor: "pointer", fontWeight: 500,
              }}
            >
              {bioSaving ? "Saving..." : "Save bio"}
            </button>
            {bioSaved && <span style={{ fontSize: 12.5, color: "#34C759", fontFamily: FONT }}>Saved ✓</span>}
          </div>
        </div>

      </div>
    </div>
  );
}
