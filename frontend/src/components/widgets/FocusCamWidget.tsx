import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Video, X } from "lucide-react";
import {
  fetchFocusCam,
  setFocusCamControl,
  fetchFocusCamToday,
  type FocusCamBlob,
  type FocusCamState,
  type FocusCamToday,
} from "../../services/api";
import { FONT } from "../../ui";
import type { WidgetCompactProps, WidgetPanelProps } from "./registry";

// The focus-cam widget — live face of the local webcam focus sidecar. The
// sidecar senses focus + reports up to Gooni; this reads GET /focus/cam and
// flips control with the Start/Stop button (declarative — the sidecar polls +
// reconciles, so a click while it's asleep still takes effect on wake). Focus
// data is walled off from every other trackable surface; this widget + the
// /focus/cam endpoints are the ONLY readers.
//
// The widget's whole job is to communicate the SESSION LIFECYCLE at a glance:
// running-vs-idle, how long it's been going (from session_id), and the live
// focus state — all server-side, so a page refresh mid-session re-hydrates the
// same running clock (nothing lives in component-only state that resets).

const POLL_MS = 2000; // GET /focus/cam — matches the app's polling convention (no SSE)
const TODAY_MS = 10_000; // GET /focus/cam/today — slower; also refetched when a session ends

// A dedicated "recording" red for the session-active signal — deliberately
// INDEPENDENT of the focus-state color (green/amber), so "the camera is on" and
// "you're currently focused" read as two separate facts, not one.
const LIVE = "rgba(240,90,90,0.95)";

const STATE_META: Record<Exclude<FocusCamState, null>, { color: string; label: string }> = {
  focused: { color: "rgba(74,222,128,0.95)", label: "FOCUSED" },
  distracted: { color: "rgba(230,190,140,0.95)", label: "DISTRACTED" },
  away: { color: "rgba(170,178,188,0.85)", label: "AWAY" },
  paused: { color: "rgba(150,180,255,0.85)", label: "PAUSED" },
};

function stateColor(s: FocusCamState): string {
  return s ? STATE_META[s].color : "rgb(var(--gooni-ink, 244 245 244) / 0.35)";
}

function stateLabel(s: FocusCamState): string {
  return s ? STATE_META[s].label : "—";
}

// Live score grade, same thresholds the sidecar contract implies (≥70 good,
// 40–70 middling, <40 poor). Grey when there's no score yet.
function scoreColor(score: number | null | undefined): string {
  if (score == null) return "rgb(var(--gooni-ink, 244 245 244) / 0.5)";
  if (score >= 70) return "rgba(74,222,128,0.95)";
  if (score >= 40) return "rgba(230,190,140,0.95)";
  return "rgba(240,120,120,0.95)";
}

// session_id encodes the session START as YYYYMMDDTHHMMSS in Daniel's LOCAL tz
// (e.g. 20260724T011219). Parse to a real local Date so the elapsed clock is
// correct + refresh-safe. Anything that doesn't match → null (hide the clock;
// never crash on an unexpected id shape).
const SID_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;
function parseSessionStart(sessionId: string | null): Date | null {
  if (!sessionId) return null;
  const m = SID_RE.exec(sessionId);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const dt = new Date(+y, +mo - 1, +d, +h, +mi, +s);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function fmtStart(date: Date): string {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function fmtElapsed(secs: number): string {
  const m = Math.floor(secs / 60);
  if (m < 1) return `${Math.floor(secs)}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Ticks once/sec (client-side, no fetch) while running, so the elapsed clock
// counts up smoothly between the 2s server polls. Returns null when idle or the
// session_id can't be parsed.
function useElapsed(running: boolean, sessionId: string | null): { start: Date; secs: number } | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  const start = useMemo(() => parseSessionStart(sessionId), [sessionId]);
  if (!running || !start) return null;
  return { start, secs: Math.max(0, (Date.now() - start.getTime()) / 1000) };
}

// The live "recording" dot pulses; injected once + disabled under
// prefers-reduced-motion (a kiosk-y widget must respect it).
const PULSE_STYLE_ID = "focus-cam-pulse";
function ensurePulseStyle() {
  if (typeof document === "undefined" || document.getElementById(PULSE_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = PULSE_STYLE_ID;
  el.textContent =
    "@keyframes focusCamPulse{0%,100%{opacity:1}50%{opacity:.3}}" +
    "@media (prefers-reduced-motion:reduce){.focus-cam-live-dot{animation:none!important}}";
  document.head.appendChild(el);
}

// Shared control-flip: optimistic, refetch-safe. Returns {running, busy, toggle}.
function useControl(blob: FocusCamBlob | null, setBlob: (u: (b: FocusCamBlob | null) => FocusCamBlob | null) => void, busyRef: React.MutableRefObject<boolean>) {
  const [busy, setBusy] = useState(false);
  const running = blob?.control === "running";
  const toggle = useCallback(async () => {
    if (!blob) return;
    const next = running ? "idle" : "running";
    setBusy(true);
    busyRef.current = true;
    setBlob((b) => (b ? { ...b, control: next } : b)); // optimistic
    try {
      const res = await setFocusCamControl(next);
      setBlob((b) => (b ? { ...b, control: res.control } : b));
    } catch {
      setBlob((b) => (b ? { ...b, control: running ? "running" : "idle" } : b));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }, [blob, running, setBlob, busyRef]);
  return { running, busy, toggle };
}

// ── Compact ──────────────────────────────────────────────────────────────────

export function FocusCamCompact({ onExpand }: WidgetCompactProps) {
  const [blob, setBlob] = useState<FocusCamBlob | null>(null);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    if (busyRef.current) return; // don't stomp an in-flight optimistic flip
    try {
      setBlob(await fetchFocusCam());
    } catch {
      /* transient — keep last */
    }
  }, []);

  useEffect(() => {
    ensurePulseStyle();
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const { running, busy, toggle } = useControl(blob, setBlob, busyRef);
  const elapsed = useElapsed(running, blob?.session_id ?? null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {/* running/idle badge + elapsed */}
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span
          className="focus-cam-live-dot"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            flexShrink: 0,
            background: running ? LIVE : "transparent",
            border: running ? "none" : "1.5px solid rgb(var(--gooni-ink, 244 245 244) / 0.35)",
            boxShadow: running ? `0 0 7px ${LIVE}` : "none",
            animation: running ? "focusCamPulse 1.6s ease-in-out infinite" : "none",
          }}
        />
        <span
          style={{
            fontSize: 10.5,
            letterSpacing: 0.8,
            fontWeight: 600,
            color: running ? LIVE : "rgb(var(--gooni-ink, 244 245 244) / 0.45)",
          }}
        >
          {running ? "REC" : "IDLE"}
        </span>
        {elapsed && (
          <span
            style={{
              marginLeft: "auto",
              fontSize: 11,
              fontVariantNumeric: "tabular-nums",
              color: "rgb(var(--gooni-ink, 244 245 244) / 0.5)",
            }}
          >
            {fmtStart(elapsed.start)} · {fmtElapsed(elapsed.secs)}
          </span>
        )}
      </div>

      {/* big live state — the hero when running */}
      {running ? (
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 19, fontWeight: 600, letterSpacing: 0.3, color: stateColor(blob?.state ?? null) }}>
            {stateLabel(blob?.state ?? null)}
          </span>
          {blob?.score != null && (
            <span
              style={{
                marginLeft: "auto",
                fontSize: 15,
                fontWeight: 600,
                fontVariantNumeric: "tabular-nums",
                color: scoreColor(blob.score),
              }}
            >
              {Math.round(blob.score)}
            </span>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "rgb(var(--gooni-ink, 244 245 244) / 0.5)" }}>
          press Start to begin a session
        </div>
      )}

      {running && blob?.app && (
        <div
          style={{
            fontSize: 11,
            color: "rgb(var(--gooni-ink, 244 245 244) / 0.45)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {blob.app}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button
          onClick={toggle}
          disabled={busy || !blob}
          style={{
            background: running ? "rgba(240,90,90,0.14)" : "rgba(74,222,128,0.14)",
            border: `1px solid ${running ? "rgba(240,90,90,0.4)" : "rgba(74,222,128,0.4)"}`,
            borderRadius: 8,
            padding: "4px 14px",
            cursor: busy ? "default" : "pointer",
            fontSize: 12,
            fontWeight: 500,
            color: running ? "rgba(240,120,120,0.95)" : "rgba(74,222,128,0.95)",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {running ? "Stop" : "Start"}
        </button>
        <button
          onClick={onExpand}
          style={{
            marginLeft: "auto",
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            fontSize: 11,
            color: "rgb(var(--gooni-ink, 244 245 244) / 0.5)",
          }}
        >
          today ▸
        </button>
      </div>
    </div>
  );
}

// ── Panel ──────────────────────────────────────────────────────────────────

const EVENT_ORDER = ["distracted", "phone", "vape", "stand", "left_desk"] as const;

export function FocusCamPanel({ onClose }: WidgetPanelProps) {
  const [blob, setBlob] = useState<FocusCamBlob | null>(null);
  const [today, setToday] = useState<FocusCamToday | null>(null);
  const busyRef = useRef(false);
  const prevRunningRef = useRef(false);

  const loadBlob = useCallback(async () => {
    if (busyRef.current) return;
    try {
      setBlob(await fetchFocusCam());
    } catch {
      /* keep last */
    }
  }, []);

  const loadToday = useCallback(async () => {
    try {
      setToday(await fetchFocusCamToday());
    } catch {
      /* keep last */
    }
  }, []);

  useEffect(() => {
    ensurePulseStyle();
    loadBlob();
    loadToday();
    const b = setInterval(loadBlob, POLL_MS);
    const t = setInterval(loadToday, TODAY_MS);
    return () => {
      clearInterval(b);
      clearInterval(t);
    };
  }, [loadBlob, loadToday]);

  const { running, busy, toggle } = useControl(blob, setBlob, busyRef);
  const elapsed = useElapsed(running, blob?.session_id ?? null);

  // A session just ended (running → idle) → its summary is now in /today.
  useEffect(() => {
    if (prevRunningRef.current && !running) loadToday();
    prevRunningRef.current = running;
  }, [running, loadToday]);

  const sessions = today?.sessions ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", fontFamily: FONT }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "16px 20px",
          borderBottom: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.1)",
        }}
      >
        <Video size={17} style={{ opacity: 0.7 }} />
        <span style={{ fontSize: 15, fontWeight: 500 }}>Focus</span>
        <Badge running={running} />
        <button
          onClick={onClose}
          style={{
            marginLeft: "auto",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "rgb(var(--gooni-ink, 244 245 244) / 0.6)",
            display: "flex",
          }}
        >
          <X size={18} />
        </button>
      </div>

      <div style={{ padding: 20, overflowY: "auto", display: "flex", flexDirection: "column", gap: 22 }}>
        {/* hero: live state while running, else a start prompt */}
        <section
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: "16px 18px",
            borderRadius: 12,
            background: "rgb(var(--gooni-ink, 244 245 244) / 0.05)",
            border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.08)",
          }}
        >
          {running ? (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
                <span style={{ fontSize: 27, fontWeight: 600, letterSpacing: 0.4, color: stateColor(blob?.state ?? null) }}>
                  {stateLabel(blob?.state ?? null)}
                </span>
                {blob?.score != null && (
                  <span style={{ marginLeft: "auto", display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                    <span style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: "tabular-nums", color: scoreColor(blob.score) }}>
                      {Math.round(blob.score)}
                    </span>
                    <span style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: "rgb(var(--gooni-ink, 244 245 244) / 0.4)" }}>
                      score
                    </span>
                  </span>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: "rgb(var(--gooni-ink, 244 245 244) / 0.55)" }}>
                {elapsed && (
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    running since {fmtStart(elapsed.start)} · {fmtElapsed(elapsed.secs)}
                  </span>
                )}
                {blob?.app && (
                  <span
                    style={{
                      marginLeft: "auto",
                      maxWidth: "50%",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      color: "rgb(var(--gooni-ink, 244 245 244) / 0.7)",
                    }}
                  >
                    {blob.app}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 14, color: "rgb(var(--gooni-ink, 244 245 244) / 0.55)" }}>
              No session running. Start one to track focus.
            </div>
          )}
          <button
            onClick={toggle}
            disabled={busy || !blob}
            style={{
              alignSelf: "flex-start",
              marginTop: 2,
              background: running ? "rgba(240,90,90,0.14)" : "rgba(74,222,128,0.14)",
              border: `1px solid ${running ? "rgba(240,90,90,0.4)" : "rgba(74,222,128,0.4)"}`,
              borderRadius: 8,
              padding: "6px 18px",
              cursor: busy ? "default" : "pointer",
              fontSize: 13,
              fontWeight: 500,
              color: running ? "rgba(240,120,120,0.95)" : "rgba(74,222,128,0.95)",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {running ? "Stop session" : "Start session"}
          </button>
        </section>

        {/* Today's event counts */}
        <section>
          <SectionLabel>today · events</SectionLabel>
          {today && Object.keys(today.events).length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {EVENT_ORDER.filter((k) => today.events[k]).map((k) => (
                <span
                  key={k}
                  style={{
                    display: "inline-flex",
                    alignItems: "baseline",
                    gap: 6,
                    padding: "4px 10px",
                    borderRadius: 8,
                    background: "rgb(var(--gooni-ink, 244 245 244) / 0.06)",
                    border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.1)",
                    fontSize: 12.5,
                  }}
                >
                  <span style={{ color: "rgb(var(--gooni-ink, 244 245 244) / 0.65)" }}>
                    {k.replace("_", " ")}
                  </span>
                  <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                    {today.events[k]}
                  </span>
                </span>
              ))}
            </div>
          ) : (
            <Muted>no events yet today</Muted>
          )}
        </section>

        {/* Today's sessions */}
        <section>
          <SectionLabel>today · sessions</SectionLabel>
          {sessions.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {sessions.map((s, i) => (
                <SessionRow key={i} s={s} />
              ))}
            </div>
          ) : (
            <Muted>no sessions logged today</Muted>
          )}
        </section>
      </div>
    </div>
  );
}

// RUNNING / IDLE pill for the panel header.
function Badge({ running }: { running: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 10.5,
        letterSpacing: 0.8,
        fontWeight: 600,
        color: running ? LIVE : "rgb(var(--gooni-ink, 244 245 244) / 0.5)",
        background: running ? "rgba(240,90,90,0.12)" : "rgb(var(--gooni-ink, 244 245 244) / 0.06)",
        border: `1px solid ${running ? "rgba(240,90,90,0.35)" : "rgb(var(--gooni-ink, 244 245 244) / 0.12)"}`,
      }}
    >
      <span
        className="focus-cam-live-dot"
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: running ? LIVE : "rgb(var(--gooni-ink, 244 245 244) / 0.4)",
          boxShadow: running ? `0 0 6px ${LIVE}` : "none",
          animation: running ? "focusCamPulse 1.6s ease-in-out infinite" : "none",
        }}
      />
      {running ? "RECORDING" : "IDLE"}
    </span>
  );
}

function SessionRow({ s }: { s: Record<string, unknown> }) {
  const score = typeof s.focus_score === "number" ? Math.round(s.focus_score) : null;
  const dur = typeof s.duration_sec === "number" ? Math.round(s.duration_sec / 60) : null;
  const start = typeof s.started_at === "string" ? s.started_at : null;
  const t = start ? new Date(start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 12px",
        borderRadius: 9,
        background: "rgb(var(--gooni-ink, 244 245 244) / 0.05)",
        fontSize: 12.5,
      }}
    >
      <span style={{ color: "rgb(var(--gooni-ink, 244 245 244) / 0.55)", minWidth: 62 }}>{t}</span>
      {dur != null && (
        <span style={{ color: "rgb(var(--gooni-ink, 244 245 244) / 0.75)" }}>{dur}m</span>
      )}
      {score != null && (
        <span
          style={{
            marginLeft: "auto",
            fontVariantNumeric: "tabular-nums",
            color: scoreColor(score),
          }}
        >
          score {score}
        </span>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        color: "rgb(var(--gooni-ink, 244 245 244) / 0.4)",
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 12.5, color: "rgb(var(--gooni-ink, 244 245 244) / 0.4)" }}>{children}</div>
  );
}
