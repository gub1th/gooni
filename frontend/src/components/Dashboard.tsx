import { useState, useEffect, useRef } from "react";
import {
  fetchDashboardStats, fetchGooniTake,
  type ApiNote, type DashboardStats,
} from "../services/api";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { useGooniThemeStore, THEME_PALETTES } from "../stores/useGooniThemeStore";
import { extractFirstImage, stripHtmlForExcerpt } from "../utils/notePreview";
import { NoteEditor } from "./notes/NoteEditor";
import { BrainOrb } from "./BrainOrb";
import { ExploreModal } from "./ExploreModal";
import { ActivityCard } from "./ActivityCard";
import { DevStreakStat } from "./DevStreakStat";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";
const GREEN = "#4ADE80";

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function getDateStr(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function formatNoteDate(iso: string | null): string {
  if (!iso) return "—";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  }
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

type InkState = {
  id: number;
  fromX: number; fromY: number;
  toX: number;   toY: number;
  angle: number;
  phase: "init" | "travel" | "absorb";
};

// ── Dashboard ──────────────────────────────────────────────────────────────────
// The dashboard itself:

export function Dashboard({ onOpenNote }: { onOpenNote: () => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [take, setTake] = useState<string>("");
  const [takeRefreshing, setTakeRefreshing] = useState(false);
  const [ink, setInk] = useState<InkState | null>(null);
  const [cardPulsing, setRowPulsing] = useState(false);
  const [typing, setTyping] = useState<{ noteId: number; revealed: number; total: number } | null>(null);
  const typingRaf = useRef<number | null>(null);
  const [exploreOpen, setExploreOpen] = useState(false);
  const { selectSpace, loadNotes, selectNote } = useNotesContentStore();
  const theme = useGooniThemeStore((s) => s.theme);
  const palette = THEME_PALETTES[theme];
  const firstCardRef = useRef<HTMLDivElement>(null);
  const dashRef = useRef<HTMLDivElement>(null);

  // Keep body/html background in sync with theme so any gap around the app fills correctly.
  useEffect(() => {
    document.body.style.background = palette.main;
    document.documentElement.style.background = palette.main;
  }, [palette.main]);

  useEffect(() => () => {
    if (typingRaf.current != null) cancelAnimationFrame(typingRaf.current);
  }, []);

  useEffect(() => {
    fetchDashboardStats().then(setStats).catch(console.error);
    fetchGooniTake().then((r) => setTake(r.take)).catch(console.error);
  }, []);

  function startTyping(noteId: number, total: number) {
    if (typingRaf.current != null) cancelAnimationFrame(typingRaf.current);
    if (total <= 0) return;
    setTyping({ noteId, revealed: 0, total });
    const duration = Math.min(1400, 350 + total * 6);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
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

  async function handleSubmitted(_note: ApiNote | null, buttonRect: DOMRect | null) {
    const target = firstCardRef.current?.getBoundingClientRect() ?? null;
    const refresh = fetchDashboardStats();

    if (buttonRect && target) {
      const fromX = buttonRect.left + buttonRect.width / 2;
      const fromY = buttonRect.top + buttonRect.height / 2;
      const toX = target.left + target.width / 2;
      const toY = target.top + target.height / 2;
      const angle = (Math.atan2(toY - fromY, toX - fromX) * 180) / Math.PI;
      const inkId = Date.now();
      setInk({ id: inkId, fromX, fromY, toX, toY, angle, phase: "init" });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setInk((s) => (s && s.id === inkId ? { ...s, phase: "travel" } : s));
        });
      });
      setTimeout(() => {
        setInk((s) => (s && s.id === inkId ? { ...s, phase: "absorb" } : s));
        setRowPulsing(true);
        refresh
          .then((s) => {
            setStats(s);
            const first = s.recent_notes[0];
            if (first) {
              const t = (first.title ?? "").trim() || "Untitled";
              const ex = stripHtml(first.content ?? "");
              startTyping(first.id, t.length + ex.length);
            }
          })
          .catch(console.error);
      }, 640);
      setTimeout(() => {
        setInk((s) => (s && s.id === inkId ? null : s));
        setRowPulsing(false);
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
    selectNote(noteId);
    loadNotes(sid);
    onOpenNote();
  }

  const activityPerDay = stats?.activity_per_day ?? [0, 0, 0, 0, 0, 0, 0];

  return (
    <div ref={dashRef} style={{ flex: 1, overflowY: "auto", background: palette.main, fontFamily: FONT, position: "relative" }}>
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
        @keyframes gooni-spin { to { transform: rotate(360deg); } }
        .gooni-caret {
          display: inline-block;
          color: #1C1C1E;
          animation: gooni-caret-blink 0.7s step-end infinite;
          margin-left: 1px;
          font-weight: 400;
        }
        /* Quiet hover on the 'add a todo' row — matches the per-row hover treatment above it. */
        .gooni-todo-add { transition: background 0.12s; }
        .gooni-todo-add:hover,
        .gooni-todo-add:focus-within { background: rgba(0,0,0,0.035); }
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
            transition:
              ink.phase === "absorb"
                ? "transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.4s ease-out"
                : "transform 0.6s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.35s ease-in",
          }}
        />
      )}

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "48px 40px 120px" }}>

        {/* Greeting + stats on the same row — greeting left, compact stat cards floated right */}
        <div style={{
          display: "flex", alignItems: "flex-start", justifyContent: "space-between",
          gap: 16, marginBottom: 26,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#1C1C1E", letterSpacing: "-0.5px", lineHeight: 1.2 }}>
              {getGreeting()}, Daniel.
            </div>
            <div style={{ fontSize: 13, color: "#8E8E93", marginTop: 4 }}>
              {getDateStr()}
              {(() => {
                // Headline counters live inside the new ActivityCard now —
                // keep this slot empty so the greeting line stays clean.
                return null;
              })()}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexShrink: 0, alignItems: "stretch", flexWrap: "wrap", justifyContent: "flex-end" }}>
            {/* 3D brain — opens the notes visualization. Left of the stat cards
                so it reads as a peer affordance, not buried in a toolbar. */}
            <BrainOrb size={60} onClick={() => setExploreOpen(true)} />

            {/* notes this week */}
            <div style={{
              background: "#fff", border: "0.5px solid rgba(0,0,0,0.08)",
              borderRadius: 10, padding: "10px 14px",
              display: "flex", flexDirection: "column", alignItems: "flex-start",
              minWidth: 110,
            }}>
              <div style={{ fontSize: 11, color: "#8E8E93", letterSpacing: 0.3 }}>notes this week</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "#1C1C1E", marginTop: 1, lineHeight: 1.1 }}>
                {stats?.notes_this_week ?? "—"}
              </div>
              {stats && (() => {
                const delta = stats.notes_this_week - stats.notes_last_week;
                if (delta === 0 && stats.notes_last_week === 0) return null;
                const isUp = delta > 0;
                const isFlat = delta === 0;
                return (
                  <div style={{
                    fontSize: 10.5, color: isFlat ? "#AEAEB2" : isUp ? "#2B8C4D" : "#C76B6B",
                    marginTop: 2, fontVariantNumeric: "tabular-nums",
                  }}>
                    {isFlat ? "→" : isUp ? "↑" : "↓"} {Math.abs(delta)} from last week
                  </div>
                );
              })()}
            </div>

            {/* day streak */}
            <div style={{
              background: "#fff", border: "0.5px solid rgba(0,0,0,0.08)",
              borderRadius: 10, padding: "10px 14px",
              display: "flex", flexDirection: "column", alignItems: "flex-start",
              minWidth: 110,
            }}>
              <div style={{ fontSize: 11, color: "#8E8E93", letterSpacing: 0.3 }}>day streak</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "#1C1C1E", marginTop: 1, lineHeight: 1.1 }}>
                {stats?.streak ?? "—"}
              </div>
              <div style={{ display: "flex", gap: 2.5, marginTop: 4 }}>
                {activityPerDay.map((v, i) => (
                  <div
                    key={i}
                    style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: v > 0 ? GREEN : "rgba(0,0,0,0.08)",
                    }}
                  />
                ))}
              </div>
            </div>

            {/* dev streak — fetches its own data, shows commits + adds/dels.
                Click to expand a commits panel that wraps below the stat row
                via flexBasis: 100% on the panel + flexWrap on the parent. */}
            <DevStreakStat />
          </div>
        </div>

        {/* Note input — embedded NoteEditor quick-input. */}
        <div style={{ marginBottom: 22 }}>
          <NoteEditor variant="embedded" onSubmitted={handleSubmitted} />
        </div>

        {/* Gooni's Take — small banner above the unified Activity card. */}
        <div style={{
          background: "#fff",
          border: "0.5px solid rgba(0,0,0,0.08)",
          borderRadius: 12,
          padding: 14,
          marginBottom: 14,
          position: "relative",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: GREEN, flexShrink: 0 }} />
            <span style={{
              fontSize: 11, color: "#8E8E93", letterSpacing: 0.6,
              textTransform: "uppercase",
            }}>
              Gooni's Take
            </span>
          </div>
          {take ? (
            <p style={{ fontSize: 12.5, color: "#3C3C43", lineHeight: 1.55, margin: 0, paddingRight: 24 }}>
              {take}
            </p>
          ) : (
            <p style={{ fontSize: 12.5, color: "#C7C7CC", lineHeight: 1.55, margin: 0 }}>
              No take yet — write a note and Gooni will weigh in.
            </p>
          )}
          <button
            onClick={refreshTake}
            disabled={takeRefreshing}
            title="Regenerate"
            style={{
              position: "absolute", top: 10, right: 10,
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
              style={{ animation: takeRefreshing ? "gooni-spin 0.8s linear infinite" : undefined, opacity: takeRefreshing ? 0.6 : 1 }}
            >
              <path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9L13 3v3.5H9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              <path d="M13.5 8a5.5 5.5 0 0 1-9.4 3.9L3 13v-3.5h3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            </svg>
          </button>
        </div>

        {/* Unified Activity card — Today + Focuses + Dev Activity. */}
        <ActivityCard />

        {/* Recent notes — two preview cards */}
        <div style={{ marginBottom: 44 }}>
          <div style={{
            fontSize: 12, color: "#8E8E93", letterSpacing: 0.6,
            textTransform: "uppercase", marginBottom: 10,
          }}>recent notes</div>
          {stats ? (
            stats.recent_notes.length === 0 ? (
              <p style={{ fontSize: 13.5, color: "#C7C7CC" }}>No notes yet.</p>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {stats.recent_notes.slice(0, 2).map((note, idx) => {
                  const fullTitle = note.title?.trim() || "Untitled";
                  const fullExcerpt = stripHtmlForExcerpt(note.content ?? "");
                  const thumbSrc = extractFirstImage(note.content ?? "");
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
                        // Use minHeight instead of fixed height so the card grows
                        // with its content up to the line-clamp ceiling. The grid
                        // row naturally stretches so both cards still match heights.
                        display: "flex", flexDirection: "column", alignItems: "stretch",
                        gap: 6, padding: "14px 16px", borderRadius: 12,
                        border: "1px solid rgba(0,0,0,0.07)", background: "#fff", cursor: "pointer",
                        textAlign: "left", width: "100%", minHeight: 160, boxSizing: "border-box",
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
                        {shownTitle || (isFirst && isTyping ? " " : "Untitled")}
                        {caretInTitle && <span className="gooni-caret">▍</span>}
                      </div>
                      <div
                        style={{
                          // NO `flex: 1` — that makes the div fill the remaining
                          // card height and breaks -webkit-line-clamp (you get
                          // mid-line clipping instead of a clean "…"). Without
                          // flex:1 the div is its intrinsic ~4-line height.
                          fontSize: 12.5, color: "#6C6C70", lineHeight: 1.5, fontFamily: FONT,
                          display: "-webkit-box",
                          WebkitLineClamp: 4,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          wordBreak: "break-word",
                        }}
                      >
                        {shownExcerpt || (isTyping ? "" : <span style={{ color: "#C7C7CC", fontStyle: "italic" }}>empty note</span>)}
                        {caretInExcerpt && <span className="gooni-caret">▍</span>}
                      </div>
                      {/* Image preview — small chip below the excerpt. Reads as
                          "card has an image" without dominating the layout. */}
                      {thumbSrc && (
                        <div style={{
                          width: 72,
                          height: 54,
                          borderRadius: 6,
                          overflow: "hidden",
                          flexShrink: 0,
                          background: "rgba(0,0,0,0.04)",
                          marginTop: 8,
                        }}>
                          <img
                            src={thumbSrc}
                            alt=""
                            style={{
                              width: "100%", height: "100%",
                              objectFit: "cover", display: "block",
                            }}
                          />
                        </div>
                      )}
                      {/* marginTop:auto pins the date to the bottom regardless of
                          how tall the excerpt ended up, so short-content cards
                          still show the timestamp at the card bottom. */}
                      <div style={{ fontSize: 11, color: "#AEAEB2", fontFamily: FONT, flexShrink: 0, marginTop: "auto" }}>
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

      {/* Mascot mounts at the route root now (see routes/index.tsx) so it
          appears on every view, not just the dashboard. */}

      {/* Semantic graph of all notes — opens as a full-screen modal */}
      <ExploreModal open={exploreOpen} onClose={() => setExploreOpen(false)} />
    </div>
  );
}
