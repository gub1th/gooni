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
import { ModeToggle } from "./dashboard/ModeToggle";
import { BuildMode } from "./dashboard/BuildMode";
import { OpsMode } from "./dashboard/OpsMode";
import { PulseMode } from "./dashboard/PulseMode";
import { CapabilityProfileCard } from "./dashboard/CapabilityProfileCard";

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
  const activeMode = useDashboardStore((s) => s.activeMode);
  const modeColors = useDashboardStore((s) => s.modeColors);

  // Background for the dashboard is theme color unless the active mode
  // has a custom tint set — then that takes over so each mode reads
  // visually distinct.
  const modeBg = modeColors[activeMode] || palette.main;

  // Keep body/html background in sync. Use the mode tint when set so the
  // dashboard's bleed area picks it up too.
  useEffect(() => {
    document.body.style.background = modeBg;
    document.documentElement.style.background = modeBg;
  }, [modeBg]);

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
    <div style={{ flex: 1, overflowY: "auto", background: modeBg, fontFamily: FONT, position: "relative", transition: "background 0.2s" }}>
      <style>{`
        @keyframes gooni-spin { to { transform: rotate(360deg); } }
        /* Quiet hover on the 'add a todo' row — matches the per-row hover treatment above it. */
        .gooni-todo-add { transition: background 0.12s; }
        .gooni-todo-add:hover,
        .gooni-todo-add:focus-within { background: rgba(0,0,0,0.035); }
      `}</style>

      {/* Header band — greeting/date on the left, inline Whoop stats +
          day-streak on the right. Stays the same shape across all modes
          so the top-of-page anchor is constant. */}
      <div style={{ background: modeBg }}>
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 40px 8px" }}>
          <DashboardHeader stats={stats} onBrainClick={() => setExploreOpen(true)} />
        </div>
      </div>

      {/* Single-column body — content swaps based on activeMode. */}
      <div>
          <div style={{ maxWidth: 720, margin: "0 auto", padding: "12px 40px 120px" }}>

        {/* Top-tier mode toggle — Today | Build | Ops | Pulse. Per-mode
            bg color customizable via the palette button. */}
        <ModeToggle />

        {activeMode === "today" && (
          <>
            {/* Today mode = the existing dashboard. TakeTabs → composer →
                inner Todos/Focuses toggle → HabitsStrip. Unchanged. */}
            <TakeTabs />
            <div style={{ marginBottom: 14 }}>
              <NoteEditor variant="embedded" onSubmitted={handleSubmitted} />
            </div>
            <TabToggle active={activeTab} onChange={setActiveTab} />
            {activeTab === "todos" ? <TodoList /> : <FocusesView />}
            <HabitsStrip />
          </>
        )}

        {activeMode === "build" && (
          /* Build mode = Gooni health — 6-axis composite scores. Click
             any card → drill-down modal with per-component breakdown.
             Capability profile sits underneath: "Who I am right now"
             card surfaces the top functional/behavioral/architectural
             facets; drawer opens the full inventory (mechanical + everything)
             and lets Daniel edit status. Auto-populated from boot scan +
             per-turn reflection clustering. */
          <>
            <BuildMode />
            <CapabilityProfileCard />
          </>
        )}

        {activeMode === "ops" && (
          /* Ops mode = eval queue + backlog + tool-call failures.
             Where the maintenance/quality loops live. */
          <OpsMode />
        )}

        {activeMode === "pulse" && (
          /* Pulse mode = life-stats grid. Whoop / LeetCode / habits /
             commits / engagement etc, in a consistent stat-card chrome. */
          <PulseMode />
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

