import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchDashboardStats,
  type ApiNote, type DashboardStats,
} from "../services/api";
import { useGooniThemeStore, THEME_PALETTES } from "../stores/useGooniThemeStore";
import { useDashboardStore } from "../stores/useDashboardStore";
import { NoteEditor } from "./notes/NoteEditor";
import { ExploreModal } from "./ExploreModal";
import { TodoList } from "./dashboard/TodoList";
import { HabitsStrip } from "./dashboard/HabitsStrip";
import { TakeTabs } from "./dashboard/TakeTabs";
import { DashboardHeader } from "./dashboard/DashboardHeader";
import { TabToggle } from "./dashboard/TabToggle";
import { FocusesView } from "./dashboard/FocusesView";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

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
  const activeTab = useDashboardStore((s) => s.activeTab);
  const setActiveTab = useDashboardStore((s) => s.setActiveTab);

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

  return (
    <div style={{ flex: 1, overflowY: "auto", background: palette.main, fontFamily: FONT, position: "relative" }}>
      <style>{`
        @keyframes gooni-spin { to { transform: rotate(360deg); } }
        /* Quiet hover on the 'add a todo' row — matches the per-row hover treatment above it. */
        .gooni-todo-add { transition: background 0.12s; }
        .gooni-todo-add:hover,
        .gooni-todo-add:focus-within { background: rgba(0,0,0,0.035); }
      `}</style>

      {/* Header band — greeting/date on the left, inline Whoop stats +
          day-streak on the right. Whoop stats only render when Whoop
          is connected; the standalone WhoopStrip below the composer
          was removed when this consolidation landed (the data lives
          in the header now, full stop). */}
      <div style={{ background: palette.main }}>
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 40px 14px" }}>
          <DashboardHeader stats={stats} onBrainClick={() => setExploreOpen(true)} />
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

        {/* Todos / Focuses toggle replaces the prior always-on dual
            stack. Active tab persists via useDashboardStore so reload
            doesn't snap back to default. */}
        <TabToggle active={activeTab} onChange={setActiveTab} />

        {activeTab === "todos" ? (
          /* Todo list — primary at top (clickable crown to demote), open
             list w/ age tints, Done today section underneath. Dev activity
             section dropped — moved up into the take card's tab. */
          <TodoList />
        ) : (
          /* Focuses view — synthesizer audit pills (promote/dismiss
             inline) above the 3-col focus card grid w/ drift /
             dormant / lineage states. Click a card → drill-down modal. */
          <FocusesView />
        )}

        {/* Habits — daily binary trackers, 7-day strip. Sits at bottom
            of the dashboard so it's a glance-and-tap surface, not
            something Daniel has to navigate to. Stays visible across
            both tabs since habits are orthogonal to todos/focuses. */}
        <HabitsStrip />

        </div>
      </div>

      {/* Mascot mounts at the route root now (see routes/index.tsx) so it
          appears on every view, not just the dashboard. */}

      {/* Semantic graph of all notes — opens as a full-screen modal */}
      <ExploreModal open={exploreOpen} onClose={() => setExploreOpen(false)} />

    </div>
  );
}

