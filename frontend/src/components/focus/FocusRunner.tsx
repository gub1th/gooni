import { useCallback, useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { FONT } from "../../ui";
import {
  fetchFocusCam,
  fetchFocusCamToday,
  setFocusCamControl,
  updateFocusReminder,
  type FocusCamBlob,
  type FocusReminder,
} from "../../services/api";
import type { FocusPalette } from "./focusPalette";

// A focus session, bound to ONE short-term promise (whiteboard, 2026-07-28).
//
// Two screens in sequence:
//   RUNNING  the promise, a clock, and nothing else. Everything the dashboard
//            was showing is deliberately gone — that's the point of focusing.
//   REPORT   what actually happened: the cam's presence/eyes-on/score if the
//            sidecar was alive, the device pickups either way, and one action —
//            mark the promise kept.
//
// Binding the session to a promise is what makes the report mean something: not
// "you focused for 25 minutes" but "you focused for 25 minutes ON THIS", with
// the close-the-loop action right there.
//
// The camera is opt-in per session by design: `control: running` asks the local
// sidecar to start sensing, and the privacy light is the honest signal that it
// did. If no sidecar is running, the session still works — you just get a timer
// and the Shortcuts roll-ups instead of the cam metrics.

const POLL_MS = 2_000;

type Phase = "running" | "report";

interface SessionReport {
  duration_sec?: number;
  focus_score?: number;
  presence_pct?: number;
  eyes_on_pct?: number;
  engaged_pct?: number;
  counts?: Record<string, number>;
  target_reminder_id?: number | null;
  session_id?: string;
  [k: string]: unknown;
}

export function FocusRunner({
  target,
  pal,
  onClose,
}: {
  target: FocusReminder;
  pal: FocusPalette;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("running");
  const [elapsed, setElapsed] = useState(0);
  const [cam, setCam] = useState<FocusCamBlob | null>(null);
  const [report, setReport] = useState<SessionReport | null>(null);
  const [pickups, setPickups] = useState<Record<string, number>>({});
  const [kept, setKept] = useState(false);
  const startedAtRef = useRef<number>(Date.now());

  // Ask the sidecar to start sensing FOR this promise. Failure is non-fatal —
  // a focus session without a webcam is still a focus session.
  useEffect(() => {
    void setFocusCamControl("running", target.id).catch(() => {});
    return () => {
      // Whatever happens (stop, Esc, unmount), the sidecar must not be left
      // sensing. Clearing control also clears the target server-side, so the
      // next session can't inherit this promise.
      void setFocusCamControl("idle", null).catch(() => {});
    };
  }, [target.id]);

  // Local clock. Independent of the sidecar so the timer runs even with no
  // sidecar alive.
  useEffect(() => {
    if (phase !== "running") return;
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  // Live cam state, if a sidecar is reporting.
  useEffect(() => {
    if (phase !== "running") return;
    const tick = () => void fetchFocusCam().then(setCam).catch(() => setCam(null));
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(id);
  }, [phase]);

  const stop = useCallback(async () => {
    setPhase("report");
    await setFocusCamControl("idle", null).catch(() => {});
    // The sidecar posts its summary on stop, so give it a beat before reading
    // today's sessions back. If it never posts (no sidecar), the report falls
    // back to the timer + pickups, which is still worth showing.
    window.setTimeout(() => {
      void fetchFocusCamToday()
        .then((t) => {
          const mine = (t.sessions as SessionReport[])
            .filter((s) => s?.target_reminder_id === target.id)
            .pop();
          setReport(mine ?? null);
          setPickups(t.events ?? {});
        })
        .catch(() => {});
    }, 1500);
  }, [target.id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (phase === "running") void stop();
      else onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, stop, onClose]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: pal.paper,
        color: pal.ink,
        fontFamily: FONT,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 26,
        padding: 40,
      }}
    >
      {phase === "running" ? (
        <Running target={target} pal={pal} elapsed={elapsed} cam={cam} onStop={() => void stop()} />
      ) : (
        <Report
          target={target}
          pal={pal}
          elapsed={elapsed}
          report={report}
          pickups={pickups}
          kept={kept}
          onKeep={async () => {
            await updateFocusReminder(target.id, { state: "kept" }).catch(() => {});
            setKept(true);
          }}
          onClose={onClose}
        />
      )}
    </div>
  );
}

// ── running ───────────────────────────────────────────────────────────────────

function Running({
  target,
  pal,
  elapsed,
  cam,
  onStop,
}: {
  target: FocusReminder;
  pal: FocusPalette;
  elapsed: number;
  cam: FocusCamBlob | null;
  onStop: () => void;
}) {
  // The sidecar is only believable while it's shipping frames. `control` alone
  // is a wish, not proof — a dead sidecar still reads running.
  const sensing = isFresh(cam?.frame_at) || isFresh(cam?.at);
  return (
    <>
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: pal.ink3,
        }}
      >
        focusing on
      </div>

      <div
        style={{
          fontSize: 30,
          lineHeight: 1.25,
          textAlign: "center",
          maxWidth: 760,
          color: pal.ink,
        }}
      >
        {target.content}
      </div>

      <div
        style={{
          fontSize: 68,
          fontWeight: 300,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "0.02em",
          color: pal.ink,
        }}
      >
        {fmtClock(elapsed)}
      </div>

      <div style={{ fontSize: 11.5, color: pal.ink3, display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: sensing ? pal.accent : pal.ink3,
            opacity: sensing ? 1 : 0.5,
          }}
        />
        {sensing ? (
          <>
            vision on{cam?.state ? ` · ${cam.state}` : ""}
            {typeof cam?.score === "number" ? ` · ${Math.round(cam.score)}` : ""}
          </>
        ) : (
          "no sidecar — timing only"
        )}
      </div>

      <button
        onClick={onStop}
        style={{
          marginTop: 14,
          fontFamily: FONT,
          fontSize: 12.5,
          padding: "9px 26px",
          borderRadius: 999,
          border: `1px solid ${pal.rule}`,
          background: "transparent",
          color: pal.ink2,
          cursor: "pointer",
        }}
      >
        stop
      </button>
    </>
  );
}

// ── report ────────────────────────────────────────────────────────────────────

function Report({
  target,
  pal,
  elapsed,
  report,
  pickups,
  kept,
  onKeep,
  onClose,
}: {
  target: FocusReminder;
  pal: FocusPalette;
  elapsed: number;
  report: SessionReport | null;
  pickups: Record<string, number>;
  kept: boolean;
  onKeep: () => void;
  onClose: () => void;
}) {
  const dur = report?.duration_sec ?? elapsed;
  const pickupRows = Object.entries(pickups).filter(([, n]) => n > 0);

  return (
    <>
      <div
        style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: pal.ink3 }}
      >
        session · {fmtDuration(dur)}
      </div>

      <div style={{ fontSize: 24, lineHeight: 1.3, textAlign: "center", maxWidth: 700 }}>
        {target.content}
      </div>

      {report ? (
        <div style={{ display: "flex", gap: 40, marginTop: 8 }}>
          <Stat pal={pal} label="focused" value={pct(report.eyes_on_pct)} />
          <Stat pal={pal} label="present" value={pct(report.presence_pct)} />
          <Stat pal={pal} label="away" value={pct(inverse(report.presence_pct))} />
          {typeof report.focus_score === "number" && (
            <Stat pal={pal} label="score" value={String(Math.round(report.focus_score))} />
          )}
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: pal.ink3, maxWidth: 420, textAlign: "center" }}>
          no cam data for this session — the sidecar wasn't sensing. The clock and
          your pickups below are still real.
        </div>
      )}

      {pickupRows.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", justifyContent: "center", maxWidth: 620 }}>
          {pickupRows.map(([k, n]) => (
            <span key={k} style={{ fontSize: 11.5, color: pal.ink2, fontVariantNumeric: "tabular-nums" }}>
              {k} <span style={{ color: pal.ink, fontWeight: 600 }}>{n}</span>
            </span>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        {kept ? (
          <span style={{ fontSize: 12.5, color: pal.accent, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Check size={14} strokeWidth={2.2} /> marked kept
          </span>
        ) : (
          <button
            onClick={onKeep}
            style={{
              fontFamily: FONT,
              fontSize: 12.5,
              padding: "9px 22px",
              borderRadius: 999,
              border: "none",
              background: pal.accent,
              color: pal.paper,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            <Check size={14} strokeWidth={2.4} /> mark kept
          </button>
        )}
        <button
          onClick={onClose}
          style={{
            fontFamily: FONT,
            fontSize: 12.5,
            padding: "9px 20px",
            borderRadius: 999,
            border: `1px solid ${pal.rule}`,
            background: "transparent",
            color: pal.ink2,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <X size={13} strokeWidth={2} /> done
        </button>
      </div>
    </>
  );
}

function Stat({ label, value, pal }: { label: string; value: string; pal: FocusPalette }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <span style={{ fontSize: 26, fontWeight: 300, fontVariantNumeric: "tabular-nums", color: pal.ink }}>
        {value}
      </span>
      <span style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: pal.ink3 }}>
        {label}
      </span>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtClock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function fmtDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function pct(v: number | undefined): string {
  return typeof v === "number" ? `${Math.round(v)}%` : "–";
}

function inverse(v: number | undefined): number | undefined {
  return typeof v === "number" ? Math.max(0, 100 - v) : undefined;
}

// A sidecar that stopped reporting >40s ago (4 missed frames) is dead, not
// quiet — the same freshness rule the focus widget uses.
function isFresh(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < 40_000;
}
