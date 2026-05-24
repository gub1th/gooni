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
import { PromiseDrawer } from "./dashboard/PromiseDrawer";
import { TakeTabs } from "./dashboard/TakeTabs";
import { DashboardHeader } from "./dashboard/DashboardHeader";
// G3.9 loop-close: TabToggle import retained for the future re-enable.
// Hidden in render below; tsc complains about the unused import so a
// trailing reference keeps it alive.
import { TabToggle as _TabToggle } from "./dashboard/TabToggle";
void _TabToggle;
import { FocusesView } from "./dashboard/FocusesView";
import { SynthesizerSection } from "./dashboard/SynthesizerSection";
import { ModeToggle } from "./dashboard/ModeToggle";
import { OpsMode } from "./dashboard/OpsMode";
import { ReviewMode } from "./dashboard/ReviewMode";
import { TvMode } from "./dashboard/TvMode";
import { PrimaryBacklogBanner } from "./dashboard/PrimaryBacklogBanner";
import { StatsMode } from "./dashboard/StatsMode";
import { FONT } from "../ui";


// ── Dashboard ──────────────────────────────────────────────────────────────────
// The dashboard itself:

export function Dashboard({ onOpenNote: _onOpenNote }: {
  onOpenNote: () => void;
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
  const _activeTab = useDashboardStore((s) => s.activeTab); void _activeTab;
  const _setActiveTab = useDashboardStore((s) => s.setActiveTab); void _setActiveTab;
  const activeMode = useDashboardStore((s) => s.activeMode);
  const composerFocused = useDashboardStore((s) => s.composerFocused);
  const setComposerFocused = useDashboardStore((s) => s.setComposerFocused);

  const pageBg = palette.main;

  // Keep body/html background in sync with the theme. Mode-specific
  // tints were removed — global theme bg owns the page surface.
  useEffect(() => {
    document.body.style.background = pageBg;
    document.documentElement.style.background = pageBg;
  }, [pageBg]);

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
    <div style={{ flex: 1, overflowY: "auto", background: pageBg, fontFamily: FONT, position: "relative", transition: "background 0.2s" }}>
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
      <div style={{ background: pageBg }}>
        <div style={{ maxWidth: activeMode === "ops" ? 960 : 720, margin: "0 auto", padding: "24px 40px 8px", transition: "max-width 220ms ease" }}>
          <DashboardHeader stats={stats} onBrainClick={() => setExploreOpen(true)} />
        </div>
      </div>

      {/* Single-column body — content swaps based on activeMode.
          Ops widens ~35% so backlog kanban + eval bubbles breathe. */}
      <div>
          <div style={{ maxWidth: activeMode === "ops" ? 960 : 720, margin: "0 auto", padding: "12px 40px 120px", transition: "max-width 220ms ease" }}>

        {/* North-star banner. Pinned singleton backlog ticket; rendered
            above the mode toggle so it's visible in every mode (today /
            ops / stats). Empty state offers a picker. */}
        <PrimaryBacklogBanner />

        {/* Top-tier mode toggle — Today | Build | Ops | Pulse. */}
        <ModeToggle />

        {activeMode === "today" && (
          <>
            {/* Today mode. When the composer is focused, TakeTabs collapses
                to a thin row and dims so the writing surface gets the eye.
                Mounted as `display: grid` w/ a single 0/1fr row that we
                transition for a smooth squish. */}
            <div
              style={{
                display: "grid",
                gridTemplateRows: composerFocused ? "0fr" : "1fr",
                opacity: composerFocused ? 0.15 : 1,
                transition: "grid-template-rows 280ms ease, opacity 220ms ease",
                pointerEvents: composerFocused ? "none" : "auto",
              }}
            >
              <div style={{ minHeight: 0, overflow: "hidden" }}>
                <TakeTabs />
              </div>
            </div>
            <div style={{ marginBottom: 14, position: "relative", zIndex: 2 }}>
              <NoteEditor
                variant="embedded"
                onSubmitted={(note, rect) => {
                  setComposerFocused(false);
                  handleSubmitted(note, rect);
                }}
                onFocusChange={setComposerFocused}
              />
            </div>
            <div
              style={{
                opacity: composerFocused ? 0.15 : 1,
                transition: "opacity 220ms ease",
                pointerEvents: composerFocused ? "none" : "auto",
              }}
            >
              {/* G3.9 loop-close: Todos|Focuses TabToggle hidden. Both
                  blocks now render together — todos first (daily-action
                  anchor), focuses next, synthesizer demoted to its own
                  card below since it's audit-shaped, not daily-action. */}
              <TodoList />
              <div style={{ marginTop: 14 }}>
                <FocusesView />
              </div>
              <div style={{
                marginTop: 14,
                background: "var(--gooni-card, #fff)",
                border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
                borderRadius: 12, padding: "12px 16px",
              }}>
                <SynthesizerSection />
              </div>
              <HabitsStrip />
              <div style={{ marginTop: 14 }}>
                <PromiseDrawer />
              </div>
            </div>
          </>
        )}

        {activeMode === "review" && (
          /* Review mode = the ambient-loop triage surface: navigable
             session summaries (5am batch output) + the limbo queue with
             promote→{todo|focus|promise|memory} / dismiss. Additive. */
          <ReviewMode />
        )}

        {activeMode === "tv" && (
          /* TV mode = read-only ambient display (todos/promises/cut/whoop),
             big fonts, 5-min auto-refresh. Additive — new tab, no kiosk
             route (per Daniel). */
          <TvMode />
        )}

        {activeMode === "ops" && (
          /* Ops mode = Gooni-health cards + capability profile + eval
             drilldown + backlog kanban + tool-call failures. Single
             "operator's console" — Build was folded in. */
          <OpsMode />
        )}

        {activeMode === "stats" && (
          /* Stats mode = merged life-stats + dev-activity surface. Absorbs
             the old Pulse tab AND the standalone Stats sidebar page so
             there's one place to look for Whoop / LeetCode / Dev Take /
             usage / activity counters. */
          <StatsMode />
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

