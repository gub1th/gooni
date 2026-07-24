import { useCallback, useEffect, useRef, useState } from "react";
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

const STATE_COLOR: Record<Exclude<FocusCamState, null>, string> = {
  focused: "rgba(74,222,128,0.9)", // green
  distracted: "rgba(230,190,140,0.9)", // amber
  away: "rgba(160,170,180,0.7)", // dim
  paused: "rgba(150,180,255,0.7)", // blue
};

function stateColor(s: FocusCamState): string {
  return s ? STATE_COLOR[s] : "rgb(var(--gooni-ink, 244 245 244) / 0.35)";
}

function stateLabel(blob: FocusCamBlob): string {
  if (blob.control !== "running") return "idle";
  return blob.state ?? "…";
}

// ── Compact ──────────────────────────────────────────────────────────────────

export function FocusCamCompact({ onExpand }: WidgetCompactProps) {
  const [blob, setBlob] = useState<FocusCamBlob | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    // Don't stomp an in-flight optimistic control flip with a stale poll.
    if (busyRef.current) return;
    try {
      setBlob(await fetchFocusCam());
    } catch {
      /* transient — keep last */
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [load]);

  const running = blob?.control === "running";

  const toggle = useCallback(async () => {
    if (!blob) return;
    const next = running ? "idle" : "running";
    setBusy(true);
    busyRef.current = true;
    setBlob({ ...blob, control: next }); // optimistic
    try {
      const res = await setFocusCamControl(next);
      setBlob((b) => (b ? { ...b, control: res.control } : b));
    } catch {
      setBlob((b) => (b ? { ...b, control: running ? "running" : "idle" } : b));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }, [blob, running]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: stateColor(blob?.state ?? null),
            boxShadow: running ? `0 0 8px ${stateColor(blob?.state ?? null)}` : "none",
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 13.5, color: "rgb(var(--gooni-ink, 244 245 244) / 0.9)" }}>
          {blob ? stateLabel(blob) : "…"}
        </span>
        {running && blob?.score != null && (
          <span
            style={{
              marginLeft: "auto",
              fontSize: 12,
              fontVariantNumeric: "tabular-nums",
              color: "rgb(var(--gooni-ink, 244 245 244) / 0.55)",
            }}
          >
            {Math.round(blob.score)}
          </span>
        )}
      </div>

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
            background: running ? "rgba(230,190,140,0.14)" : "rgba(74,222,128,0.14)",
            border: `1px solid ${running ? "rgba(230,190,140,0.4)" : "rgba(74,222,128,0.4)"}`,
            borderRadius: 8,
            padding: "4px 12px",
            cursor: busy ? "default" : "pointer",
            fontSize: 12,
            color: running ? "rgba(230,190,140,0.95)" : "rgba(74,222,128,0.95)",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {running ? "Stop" : "Start"}
        </button>
        <button
          onClick={onExpand}
          style={{
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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [b, t] = await Promise.all([fetchFocusCam(), fetchFocusCamToday()]);
        if (cancelled) return;
        setBlob(b);
        setToday(t);
      } catch {
        /* keep last */
      }
    }
    load();
    const id = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const running = blob?.control === "running";
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
        <span
          style={{
            marginLeft: 10,
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontSize: 12.5,
            color: "rgb(var(--gooni-ink, 244 245 244) / 0.7)",
          }}
        >
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: stateColor(blob?.state ?? null),
              boxShadow: running ? `0 0 8px ${stateColor(blob?.state ?? null)}` : "none",
            }}
          />
          {blob ? stateLabel(blob) : "…"}
          {running && blob?.score != null && (
            <span style={{ opacity: 0.6, fontVariantNumeric: "tabular-nums" }}>
              · {Math.round(blob.score)}
            </span>
          )}
        </span>
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
            color: "rgba(74,222,128,0.85)",
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
