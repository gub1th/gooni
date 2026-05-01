import { useState, useEffect, useRef } from "react";
import { Sparkles, ChevronLeft, ChevronRight } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchDashboardStats,
  type ApiNote, type DashboardStats,
} from "../services/api";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { useGooniThemeStore, THEME_PALETTES } from "../stores/useGooniThemeStore";
import { displayTitle, stripHtmlForExcerpt } from "../utils/notePreview";
import { NoteEditor } from "./notes/NoteEditor";
import { NeuralBrain } from "./animations/NeuralBrain";
import { ExploreModal } from "./ExploreModal";
import { ActivityCard } from "./ActivityCard";
import { DevStreakStat } from "./DevStreakStat";
import { Skeleton } from "./Skeleton";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
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

// First <img src="..."> in note content. TipTap stores pasted images as
// base64 data URLs inline, so we don't need to hit the network — just pluck
// the src and slap it in an <img>. Empty when no image present.
function extractFirstImageSrc(html: string): string | null {
  const m = html.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function pagerBtnStyle(enabled: boolean): React.CSSProperties {
  return {
    width: 22, height: 22,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: enabled ? "#fff" : "transparent",
    border: `1px solid ${enabled ? "rgba(0,0,0,0.10)" : "rgba(0,0,0,0.05)"}`,
    borderRadius: 6,
    color: enabled ? "#1C1C1E" : "#D1D1D6",
    cursor: enabled ? "pointer" : "default",
    transition: "background 0.1s, border-color 0.1s",
    padding: 0,
  };
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

export function Dashboard({ onOpenNote, onPlanNote }: {
  onOpenNote: () => void;
  onPlanNote?: (noteId: number) => void;
}) {
  const queryClient = useQueryClient();
  // Cached + de-duped via React Query. Navigating back to the dashboard hits
  // the in-memory cache first (instant render), then refetches in background
  // if data is stale (>30s). isLoading is only true on first ever fetch.
  const { data: stats, isLoading: statsLoading } = useQuery<DashboardStats>({
    queryKey: ["dashboard-stats"],
    queryFn: fetchDashboardStats,
  });
  // Helpers so the imperative submit/typing flow can still update + refetch.
  const setStats = (next: DashboardStats) => queryClient.setQueryData<DashboardStats>(["dashboard-stats"], next);
  const refetchStats = () => queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });

  const [ink, setInk] = useState<InkState | null>(null);
  const [cardPulsing, setRowPulsing] = useState(false);
  const [typing, setTyping] = useState<{ noteId: number; revealed: number; total: number } | null>(null);
  const typingRaf = useRef<number | null>(null);
  const [exploreOpen, setExploreOpen] = useState(false);
  // Page index for the recent-notes pager. Each page shows 2 cards. Reset to
  // 0 whenever fresh stats arrive so a newly-saved note lands in view (the
  // submit-flow animation also assumes the new card is at index 0).
  const [recentPage, setRecentPage] = useState(0);
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
        // Snap pager back to page 0 so the just-submitted note lands in view
        // — typing animation below targets recent_notes[0].
        setRecentPage(0);
        refresh
          .then((s) => {
            setStats(s);
            const first = s.recent_notes[0];
            if (first) {
              const t = displayTitle(first);
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
      // Classifier runs async (~2-4s). Re-fetch stats once it's likely
      // done so the new card picks up its `worth_expanding` pill without
      // a manual refresh.
      setTimeout(() => { refetchStats(); }, 4500);
    } else {
      refresh.then(setStats).catch(console.error);
      setTimeout(() => { refetchStats(); }, 4500);
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

      {/* Sticky header band — greeting + stats stay visible as the page
          scrolls. position:sticky works against the scroll ancestor (the
          outer overflow-y:auto div above). Full-width tinted band with the
          centered 720px content inside, so the background fills behind the
          inner container and content below scrolls cleanly underneath. */}
      <div style={{
        position: "sticky", top: 0, zIndex: 10,
        background: palette.main,
        borderBottom: "0.5px solid rgba(0,0,0,0.06)",
      }}>
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "28px 40px 14px" }}>
          {/* Greeting + stats on the same row. Greeting holds its natural width
              (whiteSpace:nowrap, flexShrink:0); stats container takes the
              remainder and wraps internally — its cards reflow before forcing
              the row itself to wrap. */}
          <div style={{
            display: "flex", alignItems: "flex-start", justifyContent: "space-between",
            gap: 16,
          }}>
          <div style={{ flexShrink: 0 }}>
            <div style={{
              fontSize: 28, fontWeight: 700, color: "#1C1C1E",
              letterSpacing: "-0.5px", lineHeight: 1.2, whiteSpace: "nowrap",
            }}>
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

          <div style={{ display: "flex", gap: 10, flex: 1, minWidth: 0, alignItems: "stretch", flexWrap: "wrap", justifyContent: "flex-end" }}>
            {/* 3D brain — opens the notes visualization. Left of the stat cards
                so it reads as a peer affordance, not buried in a toolbar. */}
            <NeuralBrain size={60} onClick={() => setExploreOpen(true)} />

            {/* notes this week */}
            <div style={{
              background: "#fff", border: "0.5px solid rgba(0,0,0,0.08)",
              borderRadius: 10, padding: "10px 14px",
              display: "flex", flexDirection: "column", alignItems: "flex-start",
              minWidth: 92,
            }}>
              <div style={{ fontSize: 11, color: "#8E8E93", letterSpacing: 0.3 }}>notes this week</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "#1C1C1E", marginTop: 1, lineHeight: 1.1 }}>
                {stats ? stats.notes_this_week : <Skeleton width={32} height={20} />}
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
              minWidth: 92,
            }}>
              <div style={{ fontSize: 11, color: "#8E8E93", letterSpacing: 0.3 }}>day streak</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "#1C1C1E", marginTop: 1, lineHeight: 1.1 }}>
                {stats ? stats.streak : <Skeleton width={28} height={20} />}
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
        </div>
      </div>
      {/* /sticky header */}

      {/* Below-the-fold content — scrolls under the sticky band. */}
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "20px 40px 120px" }}>

        {/* Note input — embedded NoteEditor quick-input. */}
        <div style={{ marginBottom: 14 }}>
          <NoteEditor variant="embedded" onSubmitted={handleSubmitted} />
        </div>

        {/* Recent notes — compact 2x2 grid directly under the composer so a
            new note's animation lands in Daniel's eyeline. Cards in a "topic /
            idea" shape get an 'Expand' pill that hands off to Gooni. While
            loading the first time, render skeleton cards in the same slot
            shape so layout doesn't shift on data arrival. */}
        {(statsLoading && !stats) ? (
          <div style={{ marginBottom: 18 }}>
            <div style={{
              fontSize: 11, color: "#8E8E93", letterSpacing: 0.6,
              textTransform: "uppercase", marginBottom: 8, fontWeight: 600,
            }}>recent notes</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {[0, 1].map((i) => (
                <div key={i} style={{
                  padding: "10px 12px", borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.07)", background: "#fff",
                  minHeight: 96, display: "flex", flexDirection: "column", gap: 6,
                }}>
                  <Skeleton width="60%" height={14} />
                  <Skeleton width="100%" height={11} />
                  <Skeleton width="80%" height={11} />
                </div>
              ))}
            </div>
          </div>
        ) : stats && stats.recent_notes.length > 0 && (() => {
          // Pager math — clamp page so it can't read past the end (e.g.
          // after stats refetch shrinks the list).
          const PER_PAGE = 2;
          const totalPages = Math.max(1, Math.ceil(stats.recent_notes.length / PER_PAGE));
          const page = Math.min(recentPage, totalPages - 1);
          const start = page * PER_PAGE;
          const visible = stats.recent_notes.slice(start, start + PER_PAGE);
          const canPrev = page > 0;
          const canNext = page < totalPages - 1;
          return (
          <div style={{ marginBottom: 18 }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              marginBottom: 8,
            }}>
              <div style={{
                fontSize: 11, color: "#8E8E93", letterSpacing: 0.6,
                textTransform: "uppercase", fontWeight: 600,
              }}>
                recent notes
                {totalPages > 1 && (
                  <span style={{ marginLeft: 8, color: "#C7C7CC", fontWeight: 500, letterSpacing: 0.3 }}>
                    {page + 1} / {totalPages}
                  </span>
                )}
              </div>
              {totalPages > 1 && (
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    aria-label="older recent notes"
                    onClick={() => setRecentPage((p) => Math.max(0, p - 1))}
                    disabled={!canPrev}
                    style={pagerBtnStyle(canPrev)}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    aria-label="newer recent notes"
                    onClick={() => setRecentPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={!canNext}
                    style={pagerBtnStyle(canNext)}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {visible.map((note, idx) => {
                const fullTitle = displayTitle(note);
                const fullExcerpt = stripHtmlForExcerpt(note.content ?? "");
                // First inline image — shows as a small thumb so notes with
                // pasted screenshots/sketches read at a glance instead of
                // looking like an empty title row.
                const firstImage = extractFirstImageSrc(note.content ?? "");
                // Animation targets stats.recent_notes[0] (the absolute newest);
                // a card on a later page must NOT pulse / hold the firstCardRef.
                const isFirst = page === 0 && idx === 0;
                const isTyping = typing !== null && typing.noteId === note.id;
                const revealed = isTyping ? typing!.revealed : Infinity;
                const shownTitle = isTyping ? fullTitle.slice(0, Math.min(revealed, fullTitle.length)) : fullTitle;
                const excerptBudget = isTyping ? Math.max(0, revealed - fullTitle.length) : Infinity;
                const shownExcerpt = isTyping ? fullExcerpt.slice(0, excerptBudget) : fullExcerpt;
                const caretInTitle = isTyping && revealed <= fullTitle.length;
                const caretInExcerpt = isTyping && revealed > fullTitle.length;
                const worthExpanding = note.classify_signals?.worth_expanding === true;
                return (
                  <div
                    key={note.id}
                    ref={isFirst ? firstCardRef : undefined}
                    onClick={() => openNote(note.space_id, note.id)}
                    style={{
                      display: "flex", flexDirection: "column", alignItems: "stretch",
                      gap: 4, padding: "10px 12px", borderRadius: 10,
                      border: "1px solid rgba(0,0,0,0.07)", background: "#fff", cursor: "pointer",
                      textAlign: "left", width: "100%", minHeight: 96, boxSizing: "border-box",
                      transition: "background 0.12s, border-color 0.12s",
                      animation: isFirst && cardPulsing ? `gooni-card-pulse 0.6s cubic-bezier(0.22,1,0.36,1)` : undefined,
                      position: "relative",
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
                    {firstImage && (
                      <div style={{
                        width: "100%", height: 70, marginBottom: 6,
                        borderRadius: 6, overflow: "hidden",
                        background: "#F4F4F5",
                        flexShrink: 0,
                      }}>
                        <img
                          src={firstImage}
                          alt=""
                          loading="lazy"
                          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                        />
                      </div>
                    )}
                    <div style={{
                      fontSize: 13, fontWeight: 600, color: "#1C1C1E", fontFamily: FONT,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}>
                      {shownTitle || (isFirst && isTyping ? " " : "Untitled")}
                      {caretInTitle && <span className="gooni-caret">▍</span>}
                    </div>
                    <div
                      style={{
                        fontSize: 12, color: "#6C6C70", lineHeight: 1.45, fontFamily: FONT,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        wordBreak: "break-word",
                      }}
                    >
                      {shownExcerpt || (isTyping ? "" : <span style={{ color: "#C7C7CC", fontStyle: "italic" }}>empty note</span>)}
                      {caretInExcerpt && <span className="gooni-caret">▍</span>}
                    </div>
                    <div style={{
                      display: "flex", alignItems: "center", gap: 6,
                      marginTop: "auto", paddingTop: 4,
                    }}>
                      <span style={{ fontSize: 10.5, color: "#AEAEB2", fontFamily: FONT, flex: 1 }}>
                        {formatNoteDate(note.updated_at)}
                      </span>
                      {worthExpanding && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (onPlanNote) {
                              onPlanNote(note.id);
                            } else {
                              // Fallback: if mounted somewhere without the
                              // plan handler, just open the note.
                              openNote(note.space_id, note.id);
                            }
                          }}
                          style={{
                            fontSize: 10.5, fontWeight: 500, fontFamily: FONT,
                            color: "#15803D",
                            background: "rgba(74,222,128,0.14)",
                            border: "0.5px solid rgba(74,222,128,0.45)",
                            borderRadius: 999, padding: "2px 9px",
                            cursor: "pointer",
                            display: "inline-flex", alignItems: "center", gap: 4,
                          }}
                          title="Expand on this with Gooni"
                        >
                          <Sparkles size={11} strokeWidth={2} />
                          Expand
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          );
        })()}

        {/* Primary focus treatment now lives inline in ActivityCard's focus
            list (green left rail + tint + pulsing dot). The old heading-style
            PrimaryFocusCard was removed. */}

        {/* Unified Activity card — Today + Focuses + Dev Activity. */}
        <ActivityCard />

      </div>

      {/* Mascot mounts at the route root now (see routes/index.tsx) so it
          appears on every view, not just the dashboard. */}

      {/* Semantic graph of all notes — opens as a full-screen modal */}
      <ExploreModal open={exploreOpen} onClose={() => setExploreOpen(false)} />
    </div>
  );
}
