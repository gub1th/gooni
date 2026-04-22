import { useState, useEffect, useRef } from "react";
import { fetchDashboardStats, fetchGooniTake, type ApiNote, type DashboardStats } from "../services/api";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { GooniLogo } from "./GooniLogo";
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

type InkState = {
  id: number;                 // unique key so CSS transition re-triggers per submit
  fromX: number; fromY: number;
  toX: number;   toY: number;
  angle: number;              // degrees — rotation of the stretched droplet
  phase: "init" | "travel" | "absorb";
};

export function Dashboard({ onOpenNote }: { onOpenNote: () => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [take, setTake] = useState<string>("");
  const [takeRefreshing, setTakeRefreshing] = useState(false);
  const [ink, setInk] = useState<InkState | null>(null);
  const [cardPulsing, setCardPulsing] = useState(false);
  const [typing, setTyping] = useState<{ noteId: number; revealed: number; total: number } | null>(null);
  const typingRaf = useRef<number | null>(null);
  const { selectSpace, loadNotes, selectNote } = useNotesContentStore();
  const firstCardRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => {
    if (typingRaf.current != null) cancelAnimationFrame(typingRaf.current);
  }, []);

  function startTyping(noteId: number, total: number) {
    if (typingRaf.current != null) cancelAnimationFrame(typingRaf.current);
    if (total <= 0) return;
    setTyping({ noteId, revealed: 0, total });
    const duration = Math.min(1400, 350 + total * 6); // scale with length, capped
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // ease-out-cubic for a "settling" feel at the end of the typing
      const eased = 1 - Math.pow(1 - t, 3);
      const revealed = Math.floor(eased * total);
      setTyping((s) => (s && s.noteId === noteId ? { ...s, revealed } : s));
      if (t < 1) {
        typingRaf.current = requestAnimationFrame(tick);
      } else {
        typingRaf.current = null;
        setTyping(null);
      }
    };
    typingRaf.current = requestAnimationFrame(tick);
  }

  useEffect(() => {
    fetchDashboardStats().then(setStats).catch(console.error);
    fetchGooniTake().then((r) => setTake(r.take)).catch(console.error);
  }, []);

  async function handleSubmitted(_note: ApiNote | null, buttonRect: DOMRect | null) {
    const target = firstCardRef.current?.getBoundingClientRect() ?? null;
    const refresh = fetchDashboardStats();

    if (buttonRect && target) {
      const fromX = buttonRect.left + buttonRect.width / 2;
      const fromY = buttonRect.top + buttonRect.height / 2;
      const toX = target.left + target.width / 2;
      const toY = target.top + 24; // aim for top of the card
      const angle = (Math.atan2(toY - fromY, toX - fromX) * 180) / Math.PI;
      const inkId = Date.now();
      // Phase 1 — render at origin, stretched and small. No transition yet.
      setInk({ id: inkId, fromX, fromY, toX, toY, angle, phase: "init" });
      // Phase 2 — flip to "travel" on the next frame so CSS transition animates.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setInk((s) => (s && s.id === inkId ? { ...s, phase: "travel" } : s));
        });
      });
      // Phase 3 — landed: absorb into card, pulse the card, swap the data,
      // and start the "typing" reveal animation on the new first-card text.
      setTimeout(() => {
        setInk((s) => (s && s.id === inkId ? { ...s, phase: "absorb" } : s));
        setCardPulsing(true);
        refresh
          .then((s) => {
            setStats(s);
            const first = s.recent_notes[0];
            if (first) {
              const t = (first.title ?? "").trim() || "Untitled";
              const ex = (first.content ?? "")
                .replace(/<[^>]+>/g, " ")
                .replace(/&nbsp;/g, " ")
                .replace(/\s+/g, " ")
                .trim();
              startTyping(first.id, t.length + ex.length);
            }
          })
          .catch(console.error);
      }, 640);
      // Phase 4 — clean up the ink element + pulse flag.
      setTimeout(() => {
        setInk((s) => (s && s.id === inkId ? null : s));
        setCardPulsing(false);
      }, 1280);
    } else {
      refresh.then(setStats).catch(console.error);
    }
  }

  async function refreshTake() {
    if (takeRefreshing) return;
    setTakeRefreshing(true);
    try {
      const r = await fetchGooniTake({ force: true });
      setTake(r.take);
    } catch (e) {
      console.error(e);
    } finally {
      setTakeRefreshing(false);
    }
  }

  function openNote(spaceId: number | null, noteId: number) {
    const sid = spaceId == null ? "general" : String(spaceId);
    selectSpace(sid);
    selectNote(noteId); // set eagerly; avoids flashing the most-recent note before the target loads
    loadNotes(sid);     // fire-and-forget refresh
    onOpenNote();
  }

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "#FAFAFA", fontFamily: FONT, position: "relative" }}>
      {/* Keyframes for the submit → recent-note ink flourish */}
      <style>{`
        @keyframes gooni-card-pulse {
          0%   { transform: scale(1);    box-shadow: 0 0 0 0 rgba(28,28,30,0.0); border-color: rgba(0,0,0,0.07); }
          22%  { transform: scale(1.035); box-shadow: 0 0 0 6px rgba(28,28,30,0.06); border-color: rgba(28,28,30,0.28); }
          60%  { transform: scale(1);    box-shadow: 0 0 0 2px rgba(28,28,30,0.03); border-color: rgba(28,28,30,0.18); }
          100% { transform: scale(1);    box-shadow: 0 0 0 0 rgba(28,28,30,0.0); border-color: rgba(0,0,0,0.07); }
        }
        @keyframes gooni-caret-blink {
          0%, 49% { opacity: 1; }
          50%, 100% { opacity: 0; }
        }
        .gooni-caret {
          display: inline-block;
          color: #1C1C1E;
          animation: gooni-caret-blink 0.7s step-end infinite;
          margin-left: 1px;
          font-weight: 400;
        }
      `}</style>

      {ink && (
        <div
          style={{
            position: "fixed",
            left: ink.fromX,
            top: ink.fromY,
            width: 14,
            height: 14,
            marginLeft: -7,
            marginTop: -7,
            borderRadius: "50%",
            background: "radial-gradient(circle at 35% 35%, #3A3A3C 0%, #1C1C1E 60%, #0A0A0B 100%)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.28), 0 0 2px rgba(0,0,0,0.35)",
            filter: "blur(0.3px)",
            pointerEvents: "none",
            zIndex: 9999,
            willChange: "transform, opacity",
            transform:
              ink.phase === "init"
                ? `translate(0px, 0px) rotate(${ink.angle}deg) scale(0.5, 0.5)`
                : ink.phase === "travel"
                ? `translate(${ink.toX - ink.fromX}px, ${ink.toY - ink.fromY}px) rotate(${ink.angle}deg) scale(1.55, 0.6)`
                : `translate(${ink.toX - ink.fromX}px, ${ink.toY - ink.fromY}px) rotate(0deg) scale(2.1, 2.1)`,
            opacity: ink.phase === "init" ? 0.55 : ink.phase === "absorb" ? 0 : 0.92,
            // Keep transform transition consistent from init → travel so CSS reliably animates
            // between them (swapping transition-property mid-render can suppress the animation).
            transition:
              ink.phase === "absorb"
                ? "transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.4s ease-out"
                : "transform 0.6s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.35s ease-in",
          }}
        />
      )}

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

        {/* Gooni's Take — minimal: 1-2 sentences on the most recent notes. */}
        {take && (
          <div style={{
            display: "flex", gap: 10, alignItems: "flex-start",
            padding: "14px 16px", marginBottom: 24,
            border: "1px solid rgba(0,0,0,0.07)", borderRadius: 12, background: "#FAFAFA",
            position: "relative",
          }}>
            <GooniLogo size={22} />
            <p style={{ flex: 1, fontSize: 13.5, color: "#3C3C43", lineHeight: 1.55, margin: 0, fontFamily: FONT, paddingRight: 22 }}>
              {take}
            </p>
            <button
              onClick={refreshTake}
              disabled={takeRefreshing}
              title="Regenerate"
              style={{
                position: "absolute", top: 8, right: 8,
                width: 22, height: 22, borderRadius: 6, border: "none",
                background: "transparent", color: "#8E8E93", cursor: takeRefreshing ? "default" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "background 0.1s, color 0.1s",
              }}
              onMouseEnter={(e) => { if (!takeRefreshing) { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)"; (e.currentTarget as HTMLButtonElement).style.color = "#3C3C43"; } }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; (e.currentTarget as HTMLButtonElement).style.color = "#8E8E93"; }}
            >
              <svg
                width="12" height="12" viewBox="0 0 16 16" fill="none"
                style={{
                  animation: takeRefreshing ? "gooni-spin 0.8s linear infinite" : undefined,
                  opacity: takeRefreshing ? 0.6 : 1,
                }}
              >
                <path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9L13 3v3.5H9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                <path d="M13.5 8a5.5 5.5 0 0 1-9.4 3.9L3 13v-3.5h3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              </svg>
              <style>{`@keyframes gooni-spin { to { transform: rotate(360deg); } }`}</style>
            </button>
          </div>
        )}

        {/* Quick note */}
        <div style={{ marginBottom: 24 }}>
          <NoteEditor variant="embedded" onSubmitted={handleSubmitted} />
        </div>

        {/* Recent notes — two preview cards */}
        <div style={{ marginBottom: 44 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#8E8E93", letterSpacing: 0.5, marginBottom: 10 }}>RECENT NOTES</div>
          {stats ? (
            stats.recent_notes.length === 0 ? (
              <p style={{ fontSize: 13.5, color: "#C7C7CC" }}>No notes yet.</p>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {stats.recent_notes.slice(0, 2).map((note, idx) => {
                  const fullTitle = note.title?.trim() || "Untitled";
                  const fullExcerpt = (note.content ?? "")
                    .replace(/<[^>]+>/g, " ")
                    .replace(/&nbsp;/g, " ")
                    .replace(/\s+/g, " ")
                    .trim();
                  const isFirst = idx === 0;
                  const isTyping = typing !== null && typing.noteId === note.id;
                  const revealed = isTyping ? typing!.revealed : Infinity;
                  const shownTitle = isTyping ? fullTitle.slice(0, Math.min(revealed, fullTitle.length)) : fullTitle;
                  const excerptBudget = isTyping ? Math.max(0, revealed - fullTitle.length) : Infinity;
                  const shownExcerpt = isTyping ? fullExcerpt.slice(0, excerptBudget) : fullExcerpt;
                  const caretInTitle = isTyping && revealed <= fullTitle.length;
                  const caretInExcerpt = isTyping && revealed > fullTitle.length;
                  return (
                    <div
                      key={note.id}
                      ref={isFirst ? firstCardRef : undefined}
                      onClick={() => openNote(note.space_id, note.id)}
                      style={{
                        display: "flex", flexDirection: "column", alignItems: "stretch",
                        gap: 6, padding: "14px 16px", borderRadius: 12,
                        border: "1px solid rgba(0,0,0,0.07)", background: "#fff", cursor: "pointer",
                        textAlign: "left", width: "100%", height: 160, boxSizing: "border-box",
                        transition: "background 0.12s, border-color 0.12s",
                        animation: isFirst && cardPulsing ? `gooni-card-pulse 0.6s cubic-bezier(0.22,1,0.36,1)` : undefined,
                      }}
                      onMouseEnter={(e) => {
                        const el = e.currentTarget;
                        el.style.borderColor = "rgba(0,0,0,0.15)";
                        el.style.background = "#FDFDFD";
                      }}
                      onMouseLeave={(e) => {
                        const el = e.currentTarget;
                        el.style.borderColor = "rgba(0,0,0,0.07)";
                        el.style.background = "#fff";
                      }}
                    >
                      <div style={{
                        fontSize: 14, fontWeight: 600, color: "#1C1C1E", fontFamily: FONT,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}>
                        {shownTitle || (isFirst && isTyping ? " " : "Untitled")}
                        {caretInTitle && <span className="gooni-caret">▍</span>}
                      </div>
                      <div
                        style={{
                          flex: 1, fontSize: 12.5, color: "#6C6C70", lineHeight: 1.5, fontFamily: FONT,
                          overflowY: "auto", overscrollBehavior: "contain",
                        }}
                      >
                        {shownExcerpt || (isTyping ? "" : <span style={{ color: "#C7C7CC", fontStyle: "italic" }}>empty note</span>)}
                        {caretInExcerpt && <span className="gooni-caret">▍</span>}
                      </div>
                      <div style={{ fontSize: 11, color: "#AEAEB2", fontFamily: FONT, flexShrink: 0 }}>
                        {formatNoteDate(note.updated_at)}
                      </div>
                    </div>
                  );
                })}
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
