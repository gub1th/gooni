import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { FONT } from "../../ui";
import { FOCUS_PALETTES } from "./focusPalette";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { FocusEvidenceGallery } from "./FocusEvidenceGallery";
import { FocusCameraStatus } from "./FocusCameraStatus";
import { type SessionRecapData } from "./FocusSessionRecap";
import {
  elapsedMs,
  sealedSegments,
  sessionStartedAt,
  useFocusSessionStore,
  type FocusSession,
  type FocusStyle,
} from "../../stores/useFocusSessionStore";
import { useFocusRecapStore } from "../../stores/useFocusRecapStore";
import { useSessionActivity } from "./useSessionActivity";
import {
  endFocusSession,
  fmtDuration,
  fmtMinutes,
  splitSegmentsByDay,
} from "../../services/focusTime";
import {
  fetchSessionActivity,
  updateFocusReminder,
  type ServerFocusSession,
  type SessionActivity,
} from "../../services/api";

// The expanded focus surface — the ring, FOCUS/BREAK, the sensor line, mark
// kept. ONE component, two hosts:
//
// ONE host now: the `/focus` kiosk, chromeless, for a second monitor — a WINDOW
// onto the session rather than the place focus happens. The dimmed overlay this
// also served was deleted in pass 5: on the home the session takes the WAVE's
// slot instead, so there is exactly one main thing on screen and no second
// anchor stacked over the first.
//
// Focus is a STATE, not a PLACE (prototype pass 2). Making it a page conflated
// BEING in focus with LOOKING AT focus, and the controls ended up stranded on a
// route you had navigated away from — you could not pause. Nothing here owns
// lifecycle: start/seal/write live in the store and `endFocusSession`, and this
// is a control surface over them. The banner outlives this component, which is
// what makes it safe for this to be a modal.

const R = 160;
const CIRC = 2 * Math.PI * R;

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export interface Sensors {
  browser: string | null;
  camera: string | null;
  cameraOn: boolean;
  phone: string | null;
}

/**
 * The quiet line, now SESSION-SCOPED.
 *
 * It used to read three endpoints at three scopes — `/focus/cam/today` and the
 * dashboard `rollups` both answer for the local DAY, and the browser leg was a
 * newest-first list bounded client-side against the session's start. So a
 * twenty-minute session reported "17 signals today" and "whatsapp open · 16",
 * numbers about the day sitting under a clock about the session. All three legs
 * now fold from the ONE window `useSessionActivity` polls, so they describe the
 * same period by construction rather than by three separate bounds agreeing.
 *
 * Still deliberately AFTER-THE-FACT (the same `FEED_REFRESH_MS` cadence): the
 * timer bounds the window, so a periodic read of what the sensors last said is
 * the entire answer.
 *
 * A FAILED read is `null` (rendered "—"), never "quiet": an unreachable server
 * is not evidence of a calm session, the same rule the extension popup follows
 * when it refuses to fall back to `0s`.
 */
export function sensorsFrom(activity: SessionActivity | null): Sensors {
  if (!activity) return { browser: null, camera: null, cameraOn: false, phone: null };

  const host = activity.browser.top[0];
  const browser = host ? `${host.label} ${fmtDuration(host.seconds)}` : "quiet";

  const signals = activity.camera_events.reduce((n, e) => n + e.count, 0);
  const camera = signals > 0 ? `${signals} this session` : "quiet";

  // Device telemetry arrives PRE-AGGREGATED — the count IS the analysis,
  // computed deterministically and never summarised.
  const top = activity.device.top[0];
  const phone = top ? `${top.label} · ${top.count}` : "quiet";

  return { browser, camera, cameraOn: signals > 0, phone };
}

export function FocusExpanded() {
  const theme = useGooniThemeStore((s) => s.theme);
  const pal = FOCUS_PALETTES[theme];

  const session = useFocusSessionStore((s) => s.session);
  const [now, setNow] = useState(() => Date.now());
  const [saveError, setSaveError] = useState(false);
  const setRecap = useFocusRecapStore((s) => s.setRecap);
  const stopping = useRef(false);

  const kept = session?.kept ?? false;
  const running = !!session?.running;
  const startedAt = sessionStartedAt(session);
  // ONE poll for the whole surface — the footer, the camera indicator and the
  // evidence strip all read this, so they cannot disagree about the window.
  const activity = useSessionActivity(!!session, startedAt);
  const sensors = useMemo(() => sensorsFrom(activity.data), [activity.data]);

  // The ring's clock ticks in BOTH modes — it is the mode's own stopwatch, so a
  // break counting up is what it should show.
  useEffect(() => {
    if (!running) return;
    const iv = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(iv);
  }, [running]);

  // NOTE: this component does NOT drive the focus-cam reconcile target. That
  // moved to `useFocusCamControl`, mounted once in AppShell — control follows
  // the SESSION, and this view comes and goes (collapse, kiosk) while the
  // session keeps running. See that hook for the full reasoning.

  const style: FocusStyle = session?.style ?? "stopwatch";
  const targetMs = session?.targetMs ?? 0;
  const elapsed = useMemo(() => elapsedMs(session, "focus", now), [session, now]);
  // A stopwatch has nothing to fill, so it has no ring — the elapsed time IS
  // the display. Only a timer has a target to run against.
  const remaining = Math.max(0, targetMs - elapsed);
  const frac = style === "timer" && targetMs > 0 ? Math.min(1, elapsed / targetMs) : 0;
  const shown = style === "timer" ? remaining : elapsed;

  // A claim about what gets STORED, so it goes through the same closer and
  // day-fold the write path does. The big mm:ss stays a plain stopwatch.
  const storedMinutes = useMemo(() => {
    if (!session) return 0;
    return splitSegmentsByDay(sealedSegments(session, now)).reduce((n, d) => n + d.minutes, 0);
  }, [session, now]);

  /** Build the recap from data the session itself produced — no invented score.
   *
   * The activity half is a FRESH read of the session's exact `[start, stop)`
   * window, not the polled one: the poll's `until` is "now at poll time", so
   * reusing it would drop whatever happened between the last tick and the stop.
   * It also used to fold `/focus/cam/evidence` — a table the sidecar does not
   * write to yet — which is the whole of why the recap always said "nothing
   * flagged" even when the camera had fired all session. It reads the EVENTS
   * now (which the sidecar does write) and the evidence frames beside them.
   *
   * A failed read leaves the activity fields empty rather than failing the
   * stop: the session's own numbers (minutes, timeline, per-day) are already in
   * hand, and losing the recap must never cost the write. */
  async function buildRecap(
    s: FocusSession,
    stopMs: number,
    stopped: ServerFocusSession | null,
  ): Promise<SessionRecapData> {
    const spanStart = sessionStartedAt(s) ?? stopMs;
    const sealed = sealedSegments(s, stopMs);
    const perDay = splitSegmentsByDay(sealed);
    const timeline = sealed
      .filter((seg) => seg.mode === "focus")
      .map((seg) => ({ start: seg.start, end: seg.end, truncated: seg.truncated === true }));

    // The STOP response already carries the session-scoped activity, computed
    // over the server's own runs — so the recap no longer makes a second read
    // that could describe a slightly different window than the one that just
    // ended. Falling back to the window read keeps the recap working if the
    // stop response somehow arrived without it.
    const act =
      stopped?.activity ??
      (await fetchSessionActivity(new Date(spanStart), new Date(stopMs)).catch(() => null));
    const eventsByKind: Record<string, number> = {};
    for (const e of act?.camera_events ?? []) eventsByKind[e.kind] = e.count;

    return {
      title: s.title,
      // The SERVER's minutes when we have them: it sealed the runs and wrote
      // the entry, so a client/server clock difference must not leave the recap
      // disagreeing with the log matrix.
      totalMinutes: stopped?.focused_minutes ?? perDay.reduce((n, d) => n + d.minutes, 0),
      spanMs: Math.max(0, stopMs - spanStart),
      spanStart,
      spanEnd: stopMs,
      perDay,
      timeline,
      eventsByKind,
      evidence: act?.camera_evidence ?? [],
      browser: act?.browser.top ?? [],
      apps: act?.app.top ?? [],
      device: act?.device.top ?? [],
      browserOtherSec: act?.browser.other_sec ?? 0,
      appOtherSec: act?.app.other_sec ?? 0,
      // `null` means the read FAILED — distinct from `0`, which means the
      // sensors genuinely observed nothing. The recap renders them differently.
      observedSeconds: act ? act.observed_seconds : null,
      warnings: act?.warnings ?? [],
      completionFrame: stopped?.completion_frame ?? null,
      // The score. `undefined` (no scored read) and `null` (scored, nothing
      // observed) are DIFFERENT answers and the recap says so — unknown versus
      // unmeasured. Neither is ever rendered as a number.
      focusScore: act?.focus_score,
      presencePct: act?.presence_pct,
      scoreBasis: act?.score_basis,
      scoreCoverage: act?.score_coverage,
      sensorTimeline: act?.timeline_segments,
    };
  }

  async function stop() {
    if (stopping.current || !session) return;
    stopping.current = true;
    setSaveError(false);
    const stopMs = Date.now();
    // Stopping — as opposed to pausing — means the task is DONE: this is the
    // one completion gesture (no separate "mark kept" click). Read before the
    // await: `endFocusSession` clears the store, so `session` here is the
    // closure's snapshot, not a live ref.
    const s = session;
    const alreadyKept = kept;
    try {
      // ONE call. It seals the runs, writes the entry, releases the camera,
      // grabs the victory selfie and hands back the sensor breakdown — so
      // nothing here can show a recap for a session whose minutes had not
      // landed, and there is no second window read to disagree with the first.
      const stopped = await endFocusSession();
      if (s.promiseId != null && !alreadyKept) {
        // Best-effort: the session's own write already landed, so a failure
        // here shouldn't read as the whole stop having failed. A session with
        // no promise behind it has nothing to mark.
        await updateFocusReminder(s.promiseId, { state: "kept" }).catch(() => {});
      }
      setRecap(await buildRecap(s, stopMs, stopped));
    } catch {
      setSaveError(true);
    } finally {
      stopping.current = false;
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
      <FocusCameraStatus activity={activity.data} />

      <div style={{ position: "absolute", top: 22, right: 26, display: "flex", alignItems: "center", gap: 16, fontSize: 12, color: pal.ink3 }}>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtMinutes(storedMinutes)}</span>
      </div>

      <FocusEvidenceGallery items={activity.data?.camera_evidence ?? []} />

      <div role="tablist" style={{ display: "flex", gap: 26, marginBottom: 8 }}>
        {(["stopwatch", "timer"] as FocusStyle[]).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={style === m}
            onClick={() => useFocusSessionStore.getState().setStyle(m)}
            style={{
              border: "none", background: "transparent", padding: 0, cursor: "pointer",
              fontFamily: FONT, fontSize: 12, fontWeight: 700, letterSpacing: "0.13em",
              color: style === m ? pal.ink : pal.ink3,
              transition: "color 150ms ease",
            }}
          >
            {m.toUpperCase()}
          </button>
        ))}
      </div>

      <div style={{ position: "relative", width: 340, height: 340, display: "grid", placeItems: "center" }}>
        {/* ring ONLY in timer mode — a stopwatch has nothing to fill, so a ring
            there would draw progress against a target that does not exist */}
        {style === "timer" && (
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
        )}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, zIndex: 1 }}>
          <div style={{ fontSize: style === "timer" ? 62 : 74, fontWeight: 500, letterSpacing: "-0.035em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
            {mmss(shown)}
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
    </div>
  );
}
