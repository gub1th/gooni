import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, X } from "lucide-react";
import { FONT } from "../../ui";
import { FOCUS_PALETTES } from "./focusPalette";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import {
  elapsedMs,
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
  updateFocusReminder,
} from "../../services/api";

// The expanded focus surface — the ring, FOCUS/BREAK, the sensor line, mark
// kept. ONE component, two hosts:
//
//   overlay → summoned by `FocusBanner` as a dimmed layer over whatever page
//             you are on. Deliberately NOT full-screen: the home stays visible
//             behind it and a task can still be ticked off back there.
//   kiosk   → the `/focus` route, chromeless, for a second monitor. A WINDOW
//             onto the session rather than the place focus happens.
//
// Focus is a STATE, not a PLACE (prototype pass 2). Making it a page conflated
// BEING in focus with LOOKING AT focus, and the controls ended up stranded on a
// route you had navigated away from — you could not pause. Nothing here owns
// lifecycle: start/seal/write live in the store and `endFocusSession`, and this
// is a control surface over them. The banner outlives this component, which is
// what makes it safe for this to be a modal.

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

export function FocusExpanded({
  variant,
  onCollapse,
}: {
  variant: "overlay" | "kiosk";
  /** overlay only — the strip is still there behind this, so this just closes */
  onCollapse?: () => void;
}) {
  const theme = useGooniThemeStore((s) => s.theme);
  const pal = FOCUS_PALETTES[theme];

  const session = useFocusSessionStore((s) => s.session);
  const [now, setNow] = useState(() => Date.now());
  const [saveError, setSaveError] = useState(false);
  const stopping = useRef(false);

  const kept = session?.kept ?? false;
  const running = !!session?.running;
  const startedAt = sessionStartedAt(session);
  const sensors = useSensors(!!session, startedAt);

  // The ring's clock ticks in BOTH modes — it is the mode's own stopwatch, so a
  // break counting up is what it should show.
  useEffect(() => {
    if (!running) return;
    const iv = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(iv);
  }, [running]);

  // Esc collapses the overlay back to the strip. The kiosk has nothing to
  // collapse to, so it does not listen.
  useEffect(() => {
    if (variant !== "overlay" || !onCollapse) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCollapse!();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [variant, onCollapse]);

  // NOTE: this component does NOT drive the focus-cam reconcile target. That
  // moved to `useFocusCamControl`, mounted once in AppShell — control follows
  // the SESSION, and this view comes and goes (collapse, kiosk) while the
  // session keeps running. See that hook for the full reasoning.

  const mode: FocusMode = session?.mode ?? "focus";
  const elapsed = useMemo(() => elapsedMs(session, mode, now), [session, mode, now]);
  const frac = Math.min(1, elapsed / TARGET_MS[mode]);

  // A claim about what gets STORED, so it goes through the same closer and
  // day-fold the write path does. The big mm:ss stays a plain stopwatch.
  const storedMinutes = useMemo(() => {
    if (!session) return 0;
    return splitSegmentsByDay(sealedSegments(session, now)).reduce((n, d) => n + d.minutes, 0);
  }, [session, now]);

  async function stop() {
    if (stopping.current) return;
    stopping.current = true;
    setSaveError(false);
    try {
      await endFocusSession();
      onCollapse?.();
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

  if (!session) return null;

  return (
    <div
      style={{
        position: "relative", width: "100%", height: "100%",
        fontFamily: FONT, color: pal.ink,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      }}
    >
      <div style={{ position: "absolute", top: 22, right: 26, display: "flex", alignItems: "center", gap: 16, fontSize: 12, color: pal.ink3 }}>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtMinutes(storedMinutes)}</span>
        {variant === "overlay" && (
          <button
            onClick={onCollapse}
            aria-label="Collapse to the strip"
            title="collapse (esc)"
            style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", color: pal.ink3, display: "grid", placeItems: "center" }}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
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

      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 16 }}>
        <button
          onClick={() => (running ? useFocusSessionStore.getState().pause() : useFocusSessionStore.getState().resume())}
          aria-label={running ? "Pause" : "Resume"}
          style={{
            width: 46, height: 46, borderRadius: 999, border: "none", cursor: "pointer",
            background: pal.accent, color: pal.paper, display: "grid", placeItems: "center", padding: 0,
          }}
        >
          {running ? <Pause size={16} fill="currentColor" strokeWidth={0} /> : <Play size={16} fill="currentColor" strokeWidth={0} />}
        </button>
        <button
          onClick={() => void stop()}
          aria-label="End the session"
          style={{
            border: `1px solid ${pal.rule}`, background: "transparent", cursor: "pointer",
            borderRadius: 999, padding: "7px 14px", fontFamily: FONT, fontSize: 11.5, color: pal.ink2,
          }}
        >
          end
        </button>
      </div>

      {saveError && (
        <div role="alert" style={{ marginTop: 14, fontSize: 11.5, color: pal.warn, textAlign: "center" }}>
          couldn't save this session — it's paused, not lost. try ending it again
        </div>
      )}

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
