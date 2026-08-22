import { useCallback, useEffect, useMemo, useState } from "react";
import { FONT, frostInk } from "../../ui";
import { GooniAsleep } from "./GooniAsleep";
import { FOCUS_PALETTES } from "./focusPalette";
import { FocusExpanded } from "./FocusExpanded";
import { FocusSessionList } from "./FocusSessionList";
import { FocusSessionRecapView } from "./FocusSessionRecapView";
import { TodayList, type TodayRow } from "../ambient/TodayList";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { useFocusSessionStore } from "../../stores/useFocusSessionStore";
import { useFocusRecapStore } from "../../stores/useFocusRecapStore";
import {
  fetchFocusTotals,
  switchFocusSession,
  type FocusTotals,
} from "../../services/focusTime";
import {
  createFocusReminder,
  fetchFocusDashboard,
  updateFocusReminder,
  SHORT_BUCKETS,
  type FocusReminder,
} from "../../services/api";

const DASH_POLL_MS = 30_000;
const EMPTY_TOTALS: FocusTotals = { today: 0, byPromise: {} };

// `/focus` — grown from a chromeless second-monitor kiosk into a real hub
// (2026-08-15): today's tasks (+ add), a clickable recent-sessions list, and
// the same start-a-session gesture the home's task rows use. It's a normal
// shell citizen now — the shared IconRail, AppHeader and FooterIsland all
// render around it (via __root's SurfacePanel, no longer `fullBleed`), so
// this component owns none of that chrome itself.
//
// GooniAsleep stays the idle-state centrepiece — 2D SVG, low-opacity,
// pointer-events:none, unchanged — with the task list and session list laid
// over the lower half of the screen the same way the old "focus starts from
// a task" caption used to sit there.
//
// `recapSessionId` (2026-08-21) replaced a promise-attribution history list
// (`FocusHistory.tsx`, deleted) with the analytics DASHBOARD itself: clicking
// any past session in `FocusSessionList` — or a session that just stopped —
// addresses it by id here rather than by an in-memory recap object, which is
// what makes the dashboard survive a reload and reachable for any session,
// not just the one that just ended in this tab. See `useFocusRecapStore`.
export function FocusKiosk() {
  const theme = useGooniThemeStore((s) => s.theme);
  const pal = FOCUS_PALETTES[theme];
  const session = useFocusSessionStore((s) => s.session);
  const recapSessionId = useFocusRecapStore((s) => s.sessionId);
  const clearRecap = useFocusRecapStore((s) => s.clear);
  const showRecap = useFocusRecapStore((s) => s.show);

  const [shortTerm, setShortTerm] = useState<FocusReminder[]>([]);
  const [totals, setTotals] = useState<FocusTotals>(EMPTY_TOTALS);

  const loadCommitments = useCallback(async () => {
    try {
      const d = await fetchFocusDashboard();
      setShortTerm(SHORT_BUCKETS.flatMap((b) => d.short_term[b] ?? []));
    } catch {
      /* focus hub — never throw at the user */
    }
  }, []);

  const loadTotals = useCallback(async () => {
    try {
      setTotals(await fetchFocusTotals());
    } catch {
      /* the focus trackable may not exist yet — zero is honest here */
    }
  }, []);

  useEffect(() => {
    void loadCommitments();
    void loadTotals();
    const iv = window.setInterval(() => { void loadCommitments(); void loadTotals(); }, DASH_POLL_MS);
    return () => window.clearInterval(iv);
  }, [loadCommitments, loadTotals]);

  // A finished session bumps the totals — reload whenever the store drops
  // back to null, same trigger the home uses.
  useEffect(() => {
    if (session == null) void loadTotals();
  }, [session, loadTotals]);

  // A new session starting is what makes the previous one's recap stale —
  // clear it so landing back on `/focus` mid-session never shows an old recap.
  useEffect(() => {
    if (session != null) clearRecap();
  }, [session, clearRecap]);

  const rows: TodayRow[] = useMemo(
    () => shortTerm
      .filter((item) => item.state !== "kept")
      .map((item) => ({ item, minutes: totals.byPromise[item.id] ?? 0 })),
    [shortTerm, totals],
  );

  async function onTick(item: FocusReminder) {
    const next = item.state === "kept" ? "active" : "kept";
    setShortTerm((prev) => prev.map((r) => (r.id === item.id ? { ...r, state: next, done: next === "kept" } : r)));
    try {
      await updateFocusReminder(item.id, { state: next });
    } finally {
      void loadCommitments();
    }
  }

  async function onAdd(title: string) {
    try {
      await createFocusReminder({ content: title });
    } finally {
      void loadCommitments();
    }
  }

  // Same door the home's task rows use: click a task, it starts the session
  // (ending whatever ran before it, if anything), and the running view takes
  // the whole screen.
  async function onFocus(item: FocusReminder) {
    if (session?.promiseId === item.id) return;
    try {
      await switchFocusSession(item.id, item.content);
    } finally {
      void loadTotals();
    }
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: frostInk.sheet, fontFamily: FONT, overflow: "hidden" }}>
      {session ? (
        <FocusExpanded />
      ) : recapSessionId != null ? (
        <FocusSessionRecapView sessionId={recapSessionId} onClose={clearRecap} />
      ) : (
        <>
          <GooniAsleep pal={pal} />
          <div
            style={{
              position: "absolute", bottom: 40, left: 0, right: 0,
              display: "flex", flexDirection: "column", alignItems: "center", gap: 30,
              padding: "0 24px", maxHeight: "70vh", overflowY: "auto",
            }}
          >
            <div style={{ width: "min(92vw, 420px)" }}>
              <TodayList
                rows={rows}
                laterCount={0}
                laterRows={[]}
                sessionRow={null}
                onTick={onTick}
                onAdd={onAdd}
                onFocus={onFocus}
                onTogglePause={() => {}}
                onStop={() => {}}
              />
            </div>

            <div style={{ width: "min(92vw, 460px)" }}>
              <FocusSessionList pal={pal} onOpen={showRecap} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
