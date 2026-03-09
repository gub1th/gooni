import { useEffect, useState } from "react";
import {
  fetchDashboardStats,
  fetchDashboardInsight,
  type DashboardStats,
  type ApiNote,
} from "../services/api";
import { useSpacesStore } from "../stores/useSpacesStore";

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
const DISPLAY_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface DashboardProps {
  onGoToNote: (noteId: number, spaceId: string) => void;
}

export function Dashboard({ onGoToNote }: DashboardProps) {
  const { spaces } = useSpacesStore();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [insight, setInsight] = useState<string | null>(null);
  const [loadingInsight, setLoadingInsight] = useState(false);
  const [insightFetched, setInsightFetched] = useState(false);

  useEffect(() => {
    fetchDashboardStats()
      .then(setStats)
      .catch(console.error)
      .finally(() => setLoadingStats(false));
  }, []);

  async function handleGetInsight() {
    if (insightFetched) return;
    setLoadingInsight(true);
    try {
      const r = await fetchDashboardInsight();
      setInsight(r.insight);
      setInsightFetched(true);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingInsight(false);
    }
  }

  // Build space lookup map
  const spaceMap: Record<string, { name: string; emoji: string }> = {
    general: { name: "General", emoji: "📥" },
  };
  spaces.forEach((s) => {
    if (s.id !== "general")
      spaceMap[String(s.id)] = { name: s.name, emoji: s.emoji ?? "🗂️" };
  });

  function noteSpace(note: ApiNote) {
    const id = note.space_id ? String(note.space_id) : "general";
    return { id, ...(spaceMap[id] ?? { name: "General", emoji: "📥" }) };
  }

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const statCards = [
    {
      value: loadingStats ? "—" : (stats?.notes_this_week ?? 0),
      label: "notes this week",
      accent: false,
    },
    {
      value: loadingStats ? "—" : (stats?.workouts_this_week ?? 0),
      label: "workouts this week",
      accent: false,
    },
    {
      value: loadingStats ? "—" : (stats?.active_goals_count ?? 0),
      label: "active goals",
      accent: false,
    },
    {
      value: loadingStats ? "—" : (stats?.streak ?? 0),
      label: "day streak",
      accent: !loadingStats && (stats?.streak ?? 0) > 0,
    },
  ];

  return (
    <div
      style={{
        flex: 1,
        height: "100vh",
        overflowY: "auto",
        background: "#FFFFFF",
      }}
    >
      <div
        style={{
          maxWidth: 860,
          margin: "0 auto",
          padding: "52px 48px 48px",
          boxSizing: "border-box",
        }}
      >
        {/* Header */}
        <div style={{ marginBottom: 36 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 30,
              fontWeight: 700,
              fontFamily: DISPLAY_FONT,
              color: "#1C1C1E",
              letterSpacing: "-0.5px",
            }}
          >
            {getGreeting()}.
          </h1>
          <p
            style={{
              margin: "5px 0 0",
              fontSize: 13,
              color: "#8E8E93",
              fontFamily: FONT,
            }}
          >
            {today}
          </p>
        </div>

        {/* Stat cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 12,
            marginBottom: 20,
          }}
        >
          {statCards.map((card) => (
            <div
              key={card.label}
              style={{
                background: "#F8F8FA",
                borderRadius: 14,
                padding: "18px 20px",
                border: "1px solid rgba(0,0,0,0.06)",
              }}
            >
              <div
                style={{
                  fontSize: 30,
                  fontWeight: 700,
                  fontFamily: DISPLAY_FONT,
                  color: "#1C1C1E",
                  lineHeight: 1,
                  marginBottom: 6,
                  letterSpacing: "-0.5px",
                }}
              >
                {card.value}
                {card.accent ? " 🔥" : ""}
              </div>
              <div
                style={{ fontSize: 12, color: "#8E8E93", fontFamily: FONT }}
              >
                {card.label}
              </div>
            </div>
          ))}
        </div>

        {/* Content grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
          }}
        >
          {/* Jarvis insight */}
          <div
            style={{
              background: "#F8F8FA",
              borderRadius: 14,
              padding: "22px 24px",
              border: "1px solid rgba(0,0,0,0.06)",
              display: "flex",
              flexDirection: "column",
              minHeight: 160,
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.07em",
                color: "#AEAEB2",
                fontFamily: FONT,
                marginBottom: 14,
                textTransform: "uppercase",
              }}
            >
              Jarvis
            </div>
            {insight ? (
              <p
                style={{
                  margin: 0,
                  fontSize: 14,
                  color: "#1C1C1E",
                  lineHeight: 1.65,
                  fontFamily: FONT,
                }}
              >
                {insight}
              </p>
            ) : (
              <>
                <p
                  style={{
                    margin: "0 0 16px",
                    fontSize: 13,
                    color: "#AEAEB2",
                    fontFamily: FONT,
                    lineHeight: 1.5,
                    flex: 1,
                  }}
                >
                  Get a brief, personalized briefing based on your recent
                  activity.
                </p>
                <button
                  onClick={handleGetInsight}
                  disabled={loadingInsight}
                  style={{
                    alignSelf: "flex-start",
                    padding: "8px 16px",
                    borderRadius: 10,
                    border: "none",
                    background: loadingInsight
                      ? "rgba(0,0,0,0.06)"
                      : "#1C1C1E",
                    color: loadingInsight ? "#AEAEB2" : "#FFFFFF",
                    fontSize: 13,
                    fontFamily: FONT,
                    cursor: loadingInsight ? "default" : "pointer",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => {
                    if (!loadingInsight)
                      (e.currentTarget as HTMLButtonElement).style.background =
                        "#3A3A3C";
                  }}
                  onMouseLeave={(e) => {
                    if (!loadingInsight)
                      (e.currentTarget as HTMLButtonElement).style.background =
                        "#1C1C1E";
                  }}
                >
                  {loadingInsight ? "Thinking…" : "Ask Jarvis"}
                </button>
              </>
            )}
          </div>

          {/* Recent notes */}
          <div
            style={{
              background: "#F8F8FA",
              borderRadius: 14,
              padding: "22px 24px",
              border: "1px solid rgba(0,0,0,0.06)",
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.07em",
                color: "#AEAEB2",
                fontFamily: FONT,
                marginBottom: 14,
                textTransform: "uppercase",
              }}
            >
              Recent Notes
            </div>
            {!stats || stats.recent_notes.length === 0 ? (
              <p
                style={{
                  margin: 0,
                  fontSize: 13,
                  color: "#AEAEB2",
                  fontFamily: FONT,
                }}
              >
                No notes yet.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {stats.recent_notes.map((note) => {
                  const space = noteSpace(note);
                  return (
                    <button
                      key={note.id}
                      onClick={() => onGoToNote(note.id, space.id)}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                        padding: "8px 10px",
                        borderRadius: 8,
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        textAlign: "left",
                        width: "100%",
                      }}
                      onMouseEnter={(e) =>
                        ((e.currentTarget as HTMLButtonElement).style.background =
                          "rgba(0,0,0,0.05)")
                      }
                      onMouseLeave={(e) =>
                        ((e.currentTarget as HTMLButtonElement).style.background =
                          "transparent")
                      }
                    >
                      <span
                        style={{
                          fontSize: 13.5,
                          fontWeight: 500,
                          color: "#1C1C1E",
                          fontFamily: FONT,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          width: "100%",
                          display: "block",
                        }}
                      >
                        {note.title?.trim() || "Untitled"}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          color: "#AEAEB2",
                          fontFamily: FONT,
                          marginTop: 1,
                        }}
                      >
                        {space.emoji} {space.name} · {shortDate(note.updated_at)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
