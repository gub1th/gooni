import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Pause, Play, X } from "lucide-react";
import { FONT } from "../../ui";
import { GooniAsleep } from "./GooniAsleep";
import { FOCUS_PALETTES, type FocusPalette } from "./focusPalette";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import {
  elapsedMs,
  isAccruingFocus,
  sealedSegments,
  sessionStartedAt,
  useFocusSessionStore,
  type FocusMode,
} from "../../stores/useFocusSessionStore";
import {
  endFocusSession,
  fmtMinutes,
  fetchRecentBrowserIntervals,
  splitSegmentsByDay,
} from "../../services/focusTime";
import { parseServerDate } from "../../utils/date";
import {
  FEED_REFRESH_MS,
  fetchFocusCamToday,
  fetchFocusDashboard,
  setFocusCamControl,
  updateFocusReminder,
} from "../../services/api";

// The focus session — reached only from a task row, which is the whole point.
//
// A named task plus a running timer is the attribution mechanism: everything
// inside the window belongs to that Promise, by construction, with no
// classifier and no guessing. That is why there is no "start a session" door
// anywhere else, and why the rail carries no focus entry.
//
// IDLE is a real state, not a redirect. With no session running this route
// shows Gooni asleep rather than bouncing you away: it was written for an
// always-on second monitor (2D SVG, slow drift, low contrast — burn-in, not
// nostalgia), and a screen that flings you elsewhere is not a resting state.

/** Ring targets. A session is not capped by them — the ring just laps. */
const TARGET_MS: Record<FocusMode, number> = {
  focus: 25 * 60_000,
  break: 5 * 60_000,
};

const R = 160;
const CIRC = 2 * Math.PI * R;

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface Sensors {
  browser: string | null;
  camera: string | null;
  cameraOn: boolean;
  phone: string | null;
}

/**
 * The quiet line. Deliberately AFTER-THE-FACT: the most recent known values on
 * the existing feed cadence, not a realtime "what am I looking at right now"
 * endpoint. The timer already bounds the window, so a periodic read of what the
 * sensors last said is the entire answer, and it costs no new backend surface.
 *
 * All three legs describe the SAME period. Camera (`/focus/cam/today`) and phone
 * (the dashboard rollups) are local-day scoped by the backend; the browser read
 * is newest-first and otherwise unbounded, so it is bounded here against the
 * session's own start. Without that bound an extension that is uninstalled,
 * disabled, or has stopped flushing renders a days-old host identically to a
 * live one — the one leg that could imply currency it doesn't have.
 */
function useSensors(active: boolean, sinceMs: number | null): Sensors {
  const [s, setS] = useState<Sensors>({ browser: null, camera: null, cameraOn: false, phone: null });

  const load = useCallback(async () => {
    const [browser, cam, dash] = await Promise.allSettled([
      fetchRecentBrowserIntervals(1),
      fetchFocusCamToday(),
      fetchFocusDashboard(),
    ]);

    // Newest-first, so one row settles it: if the latest interval ended before
    // the session began, nothing has been recorded inside the window.
    let host: string | null = null;
    if (browser.status === "fulfilled" && browser.value.length > 0) {
      const latest = browser.value[0];
      const endedAt = parseServerDate(latest.ended_at)?.getTime() ?? null;
      if (sinceMs != null && endedAt != null && endedAt >= sinceMs) host = latest.host;
    }

    let camera: string | null = null;
    let cameraOn = false;
    if (cam.status === "fulfilled") {
      const counts = Object.entries(cam.value.events ?? {});
      const total = counts.reduce((n, [, v]) => n + (Number(v) || 0), 0);
      cameraOn = (cam.value.sessions ?? []).length > 0 || total > 0;
      camera = cameraOn ? `${total} signals today` : "quiet";
    }

    // Device telemetry arrives PRE-AGGREGATED (`instagram open · 12`) — the
    // count is the analysis, computed deterministically, never summarised.
    let phone: string | null = null;
    if (dash.status === "fulfilled") {
      const top = (dash.value.rollups ?? [])[0];
      phone = top ? `${top.label} · ${top.count}` : "quiet";
    }

    setS({ browser: host, camera, cameraOn, phone });
  }, [sinceMs]);

  useEffect(() => {
    if (!active) return;
    void load();
    const iv = window.setInterval(() => void load(), FEED_REFRESH_MS);
    return () => window.clearInterval(iv);
  }, [active, load]);

  return s;
}

export function FocusSession() {
  const navigate = useNavigate();
  const theme = useGooniThemeStore((s) => s.theme);
  const pal = FOCUS_PALETTES[theme];

  const session = useFocusSessionStore((s) => s.session);
  const [now, setNow] = useState(() => Date.now());
  const [saveError, setSaveError] = useState(false);
  const stopping = useRef(false);

  // Kept lives in the SESSION store, not here: `/` has to keep showing this row
  // struck through and running, and it may be a reload away from this click.
  const kept = session?.kept ?? false;
  const running = !!session?.running;
  const accruing = isAccruingFocus(session);
  const startedAt = sessionStartedAt(session);
  const sensors = useSensors(!!session, startedAt);

  // The ring's clock ticks in BOTH modes — it is the mode's own stopwatch, so a
  // break counting up is what it should show. `running` is the right gate here.
  useEffect(() => {
    if (!running) return;
    const iv = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(iv);
  }, [running]);

  // The sidecar is a RECONCILE-POLL target: we declare desired control, it
  // catches up on its own ~2s poll. It senses during LIVE FOCUS ONLY — never on
  // a break, never while paused — because nothing should be sensed for a window
  // that will never be written, and break segments are exactly such a window.
  // Keyed on the promise AND that derivation, which move on start/pause/resume/
  // mode-flip only — not on the per-second tick, which updates `now` and not the
  // store object.
  useEffect(() => {
    if (!session) return;
    void setFocusCamControl(
      accruing ? "running" : "idle",
      accruing ? session.promiseId : null,
    ).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.promiseId, accruing]);

  // Unmount ALWAYS clears control, so a closed tab can never leave the camera
  // sensing. Deliberately its own effect: folded into the one above, a resume
  // would fire cleanup(idle) and setup(running) as two racing posts, and an idle
  // landing last would leave the sidecar asleep for the rest of the session.
  useEffect(() => {
    return () => { void setFocusCamControl("idle", null).catch(() => {}); };
  }, []);

  const mode: FocusMode = session?.mode ?? "focus";
  const elapsed = useMemo(() => elapsedMs(session, mode, now), [session, mode, now]);
  const frac = Math.min(1, elapsed / TARGET_MS[mode]);

  // The header total is a claim about what gets STORED, so it goes through the
  // same closer and day-fold the write path does — an uncapped 9h here against a
  // stored 6h would break the one invariant `sealedSegments` promises. The big
  // mm:ss on the ring stays a plain stopwatch.
  const storedMinutes = useMemo(() => {
    if (!session) return 0;
    return splitSegmentsByDay(sealedSegments(session, now)).reduce((n, d) => n + d.minutes, 0);
  }, [session, now]);

  // Write-then-clear lives in `endFocusSession` — the SAME path starting focus
  // on another task goes through, so there is one place that decides a session
  // may only be dropped once its entry has landed.
  async function stop() {
    if (stopping.current) return;
    stopping.current = true;
    setSaveError(false);
    try {
      await endFocusSession();
      navigate({ to: "/", search: { note: undefined, conv: undefined, audit: undefined, segment: undefined, view: undefined, trackables: undefined } });
    } catch {
      setSaveError(true);
    } finally {
      stopping.current = false;
    }
  }

  async function markKept() {
    if (!session || kept) return;
    useFocusSessionStore.getState().setKept(true);
    try {
      await updateFocusReminder(session.promiseId, { state: "kept" });
    } catch {
      useFocusSessionStore.getState().setKept(false);
    }
  }

  if (!session) {
    return (
      <div style={{ position: "fixed", inset: 0, background: pal.paper, fontFamily: FONT, overflow: "hidden" }}>
        <GooniAsleep pal={pal} />
        <div
          style={{
            position: "absolute", bottom: 44, left: 0, right: 0, textAlign: "center",
            fontSize: 12, color: pal.ink3,
          }}
        >
          focus starts from a task
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: pal.paper, fontFamily: FONT, color: pal.ink,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        overflow: "hidden",
      }}
    >
      <div style={{ position: "absolute", top: 22, right: 26, display: "flex", alignItems: "center", gap: 16, fontSize: 12, color: pal.ink3 }}>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {fmtMinutes(storedMinutes)}
        </span>
        <button
          onClick={() => void stop()}
          aria-label="End the session"
          title="end the session"
          style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", color: pal.ink3, display: "grid", placeItems: "center" }}
        >
          <X size={15} strokeWidth={1.8} />
        </button>
      </div>

      <div role="tablist" style={{ display: "flex", gap: 26, marginBottom: 8 }}>
        {(["focus", "break"] as FocusMode[]).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            onClick={() => useFocusSessionStore.getState().setMode(m)}
            style={{
              border: "none", background: "transparent", padding: 0, cursor: "pointer",
              fontFamily: FONT, fontSize: 12, fontWeight: 700, letterSpacing: "0.13em",
              color: mode === m ? pal.ink : pal.ink3,
              transition: "color 150ms ease",
            }}
          >
            {m.toUpperCase()}
          </button>
        ))}
      </div>

      <div style={{ position: "relative", width: 340, height: 340, display: "grid", placeItems: "center" }}>
        <svg viewBox="0 0 340 340" style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }} aria-hidden>
          <circle cx="170" cy="170" r={R} fill="none" stroke={pal.rule} strokeWidth={2} />
          <circle
            cx="170" cy="170" r={R} fill="none"
            stroke={pal.accent} strokeWidth={2} strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - frac)}
            style={{ transition: "stroke-dashoffset 600ms linear" }}
          />
        </svg>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, zIndex: 1 }}>
          <div style={{ fontSize: 62, fontWeight: 500, letterSpacing: "-0.035em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
            {mmss(elapsed)}
          </div>
          <div
            style={{
              fontSize: 23, fontWeight: 450, letterSpacing: "-0.012em", marginTop: 4,
              maxWidth: "14ch", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              color: kept ? pal.ink2 : pal.ink,
              textDecoration: kept ? "line-through" : "none",
              textDecorationThickness: kept ? 1.5 : undefined,
            }}
            title={session.title}
          >
            {session.title}
          </div>
        </div>
      </div>

      <button
        onClick={() => (running ? useFocusSessionStore.getState().pause() : useFocusSessionStore.getState().resume())}
        aria-label={running ? "Pause" : "Resume"}
        style={{
          marginTop: 16, width: 46, height: 46, borderRadius: 999, border: "none", cursor: "pointer",
          background: pal.accent, color: pal.paper, display: "grid", placeItems: "center", padding: 0,
        }}
      >
        {running ? <Pause size={16} fill="currentColor" strokeWidth={0} /> : <Play size={16} fill="currentColor" strokeWidth={0} />}
      </button>

      {/* the write failed, so the session still holds its minutes — but `seal`
          already paused it, so say paused rather than implying it still runs */}
      {saveError && (
        <div role="alert" style={{ marginTop: 14, fontSize: 11.5, color: pal.warn, textAlign: "center" }}>
          couldn't save this session — it's paused, not lost. try ending it again
        </div>
      )}

      {/* one quiet sensor line — browser · camera · phone */}
      <div
        style={{
          position: "absolute", bottom: 74, left: "50%", transform: "translateX(-50%)",
          display: "flex", gap: 22, fontSize: 11.5, color: pal.ink3, whiteSpace: "nowrap",
        }}
      >
        <span>browser <b style={{ fontWeight: 450, color: pal.ink2 }}>{sensors.browser ?? "—"}</b></span>
        <span>camera <b style={{ fontWeight: 450, color: sensors.cameraOn ? pal.accent : pal.ink2 }}>{sensors.camera ?? "—"}</b></span>
        <span>phone <b style={{ fontWeight: 450, color: pal.ink2 }}>{sensors.phone ?? "—"}</b></span>
      </div>

      <button
        onClick={() => void markKept()}
        disabled={kept}
        style={{
          position: "absolute", bottom: 44, right: 30,
          border: "none", background: "transparent", padding: 0,
          cursor: kept ? "default" : "pointer",
          fontFamily: FONT, fontSize: 12, color: kept ? pal.accent : pal.ink3,
        }}
      >
        {kept ? "kept" : "mark kept"}
      </button>
    </div>
  );
}

export type { FocusPalette };
