import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchDashboardStats,
  createItem,
  type ApiNote, type DashboardStats,
} from "../services/api";
import { useGooniThemeStore, THEME_PALETTES } from "../stores/useGooniThemeStore";
import { NoteEditor } from "./notes/NoteEditor";
import { NeuralBrain } from "./animations/NeuralBrain";
import { ExploreModal } from "./ExploreModal";
import { Skeleton } from "./Skeleton";
import { WhoopStrip } from "./dashboard/WhoopStrip";
import { FocusCardsRow } from "./dashboard/FocusCardsRow";
import { TodoList } from "./dashboard/TodoList";
import { TakeTabs } from "./dashboard/TakeTabs";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function getDateStr(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

// Compact card variant of the original right-column stat tile. Used in
// the header (Notes, Streak) and the side column (Claude). DevStreakStat
// renders its own card chrome so it doesn't go through this helper.
function StatCard({ label, value, children, width }: {
  label: string;
  value: React.ReactNode;
  children?: React.ReactNode;
  width?: number | string;
}) {
  return (
    <div style={{
      background: "var(--gooni-card, #fff)",
      border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
      borderRadius: 10, padding: "10px 14px",
      display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "space-between",
      width: width ?? "auto", flexShrink: 0,
      minHeight: 66,
    }}>
      <div style={{ fontSize: 11, color: "var(--gooni-muted, #8E8E93)", letterSpacing: 0.3 }}>{label}</div>
      <div style={{
        fontSize: 20, fontWeight: 600,
        color: "var(--gooni-text, #1C1C1E)", marginTop: 1, lineHeight: 1.1,
        fontVariantNumeric: "tabular-nums",
      }}>
        {value}
      </div>
      {children}
    </div>
  );
}

// ── Dashboard ──────────────────────────────────────────────────────────────────
// The dashboard itself:

export function Dashboard({ onOpenNote: _onOpenNote }: {
  onOpenNote: () => void;
  onOpenStats?: () => void;
}) {
  const queryClient = useQueryClient();
  // Cached + de-duped via React Query. Navigating back to the dashboard hits
  // the in-memory cache first (instant render), then refetches in background
  // if data is stale (>30s). isLoading is only true on first ever fetch.
  const { data: stats } = useQuery<DashboardStats>({
    queryKey: ["dashboard-stats"],
    queryFn: fetchDashboardStats,
  });
  // Today's focus take. Persisted server-side (one row per UTC day in
  // gooni_takes), so re-mounting the dashboard during the day is a cheap
  // DB read; first request after midnight regenerates and writes a new row.
  // Take queries moved into TakeTabs (mounted at the top of the dashboard)
  // — that component owns its own React-Query subscriptions for the focus
  // + dev takes. Same query keys, so cache stays shared if anything else
  // ever subscribes.
  // Helpers so the imperative submit/typing flow can still update + refetch.
  const setStats = (next: DashboardStats) => queryClient.setQueryData<DashboardStats>(["dashboard-stats"], next);
  const refetchStats = () => queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });

  const [exploreOpen, setExploreOpen] = useState(false);
  const theme = useGooniThemeStore((s) => s.theme);
  const palette = THEME_PALETTES[theme];

  // Keep body/html background in sync with theme so any gap around the app fills correctly.
  useEffect(() => {
    document.body.style.background = palette.main;
    document.documentElement.style.background = palette.main;
  }, [palette.main]);

  // Quick-capture composer (Cmd+E) saves notes outside the dashboard's
  // own submit flow, so listen for its event and re-pull stats so the
  // header counters reflect the new note.
  useEffect(() => {
    const onCreated = () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
    };
    window.addEventListener("gooni:note-created", onCreated);
    return () => window.removeEventListener("gooni:note-created", onCreated);
  }, [queryClient]);

  // Composer submit — the recent-notes grid + ink/typing animation moved to
  // Sidebar. Dashboard now just refreshes header stats and forwards the
  // submit-button rect so the sidebar can run the ink-fly-to-row animation.
  async function handleSubmitted(_note: ApiNote | null, buttonRect: DOMRect | null) {
    window.dispatchEvent(new CustomEvent("gooni:note-submitted", { detail: { buttonRect } }));
    try {
      const s = await fetchDashboardStats();
      setStats(s);
    } catch (e) {
      console.error(e);
    }
    // Classifier runs async (~2-4s). Re-fetch stats once it's likely done
    // so any header counters or downstream surfaces pick up the new note.
    setTimeout(() => { refetchStats(); }, 4500);
  }

  const activityPerDay = stats?.activity_per_day ?? [0, 0, 0, 0, 0, 0, 0];

  return (
    <div style={{ flex: 1, overflowY: "auto", background: palette.main, fontFamily: FONT, position: "relative" }}>
      <style>{`
        @keyframes gooni-spin { to { transform: rotate(360deg); } }
        /* Quiet hover on the 'add a todo' row — matches the per-row hover treatment above it. */
        .gooni-todo-add { transition: background 0.12s; }
        .gooni-todo-add:hover,
        .gooni-todo-add:focus-within { background: rgba(0,0,0,0.035); }
      `}</style>

      {/* Header band — greeting/date on the left, brain + Notes + Streak
          cards on the right. Centered at the same 720px column as the rest
          of the dashboard so the title row visually anchors the content
          width. Notes + Streak are real cards (same chrome as before),
          NOT the inline borderless variant — Daniel wants them readable
          as discrete tiles. */}
      <div style={{ background: palette.main }}>
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 40px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 28, fontWeight: 700, color: "var(--gooni-text, #1C1C1E)",
                letterSpacing: "-0.5px", lineHeight: 1.2,
              }}>
                {getGreeting()}, Daniel.
              </div>
              <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)", marginTop: 4 }}>
                {getDateStr()}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <NeuralBrain size={66} onClick={() => setExploreOpen(true)} />
              {/* notes-this-week dropped per dashboard revamp — Daniel
                  cared more about today's todos+focuses than weekly note
                  velocity. Streak stays as the at-a-glance momentum tile. */}
              <StatCard
                label="day streak"
                value={stats ? stats.streak : <Skeleton width={28} height={20} />}
              >
                <div style={{ display: "flex", gap: 2.5, marginTop: 4 }}>
                  {activityPerDay.map((v, i) => (
                    <div key={i} style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: v > 0 ? "#30A14E" : "rgba(0,0,0,0.10)",
                    }} />
                  ))}
                </div>
              </StatCard>
            </div>
          </div>
        </div>
      </div>

      {/* Single-column body. Dev + OpenAI usage live in the dedicated
          Stats view (sidebar → Stats, or the "Stats →" card above). */}
      <div>
          <div style={{ maxWidth: 720, margin: "0 auto", padding: "20px 40px 120px" }}>

        {/* Gooni's Take — single card with tabs at the TOP of the
            dashboard. Sparkle = focus take ("what are my current
            focuses?"); Hammer = dev take ("what did I ship this week?",
            now weekly per take_service v2). */}
        <TakeTabs />

        {/* Note input — embedded NoteEditor quick-input. The recent-notes
            grid that used to live here moved to the Sidebar's RECENT
            section, including the post-submit ink + typewriter animation. */}
        <div style={{ marginBottom: 14 }}>
          <NoteEditor variant="embedded" onSubmitted={handleSubmitted} />
        </div>

        {/* Whoop strip (renders nothing when not connected). */}
        <WhoopStrip />

        {/* Focus cards — 3-col grid above the todo list. */}
        <div style={{ marginBottom: 16 }}>
          <FocusCardsRow
            onAdd={async () => {
              const text = window.prompt("New focus name?");
              if (!text?.trim()) return;
              try {
                await createItem({ text: text.trim(), committed: true });
                queryClient.invalidateQueries({ queryKey: ["focuses"] });
              } catch (e) { console.error(e); }
            }}
          />
        </div>

        {/* Todo list — primary at top (clickable crown to demote), open
            list w/ age tints, Done today section underneath. Dev activity
            section dropped — moved up into the take card's tab. */}
        <TodoList />

        </div>
      </div>

      {/* Mascot mounts at the route root now (see routes/index.tsx) so it
          appears on every view, not just the dashboard. */}

      {/* Semantic graph of all notes — opens as a full-screen modal */}
      <ExploreModal open={exploreOpen} onClose={() => setExploreOpen(false)} />

    </div>
  );
}

