import { useEffect, useRef, useState } from "react";
import { Pause, Play, X } from "lucide-react";
import { FONT, frostInk, z } from "../../ui";
import { ink } from "../ambient/ambientInk";
import { elapsedMs, useFocusSessionStore } from "../../stores/useFocusSessionStore";
import { endFocusSession } from "../../services/focusTime";
import { MarkKeptOffer } from "./MarkKeptOffer";

// THE session bar — a slim full-width band at the very top, its own row.
//
// It used to sit inline in the top-right beside the mic, the theme toggle and
// the log, which made a running session read as one more piece of chrome. A
// running session is a MODE, and a mode should read as one. So it is out of the
// corner cluster entirely and owns a band above everything else.
//
// The brief was "subtler but also eye catching", resolved as SUBTLE IN
// FOOTPRINT, LOUD IN SIGNAL: a short band, no heavy fill, no header weight —
// and the attention comes from the accent and the motion instead, the live
// pulse and the running clock. The controls are present but deliberately quiet
// so the row does not read as a toolbar.
//
// Present ONLY while a session runs; AppShell reserves its height only then, so
// the page returns to full height the moment it ends.
//
// Focus is a STATE, not a place: this band and its controls follow you across
// every surface, which is the whole reason the focus PAGE was retired.

export const SESSION_BAR_H = 34;

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function BarButton({
  label,
  onClick,
  accent,
  children,
}: {
  label: string;
  onClick: () => void;
  accent?: boolean;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 22, height: 22, padding: 0, borderRadius: 999, cursor: "pointer",
        border: "none", background: "transparent",
        display: "grid", placeItems: "center",
        color: accent ? frostInk.accent : hover ? ink(0.92) : ink(0.45),
        transition: "color 140ms ease",
      }}
    >
      {children}
    </button>
  );
}

export function FocusSessionBar() {
  const session = useFocusSessionStore((s) => s.session);
  const [now, setNow] = useState(() => Date.now());
  const ending = useRef(false);

  const running = !!session?.running;

  useEffect(() => {
    if (!running) return;
    const iv = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(iv);
  }, [running]);

  async function end() {
    if (ending.current) return;
    ending.current = true;
    try {
      await endFocusSession();
    } catch {
      /* the session survives a failed write by design; the expanded surface is
         where that is explained, so the band stays quiet */
    } finally {
      ending.current = false;
    }
  }

  // No session, but a just-stopped one may still be offering completion — the
  // band is the natural place for it on surfaces that have no wave slot.
  if (!session) {
    return (
      <div
        style={{
          position: "fixed", top: 0, left: 0, right: 0,
          zIndex: z.overlay + 4, display: "flex", justifyContent: "center",
          pointerEvents: "none", paddingTop: 8,
        }}
      >
        <div style={{ pointerEvents: "auto" }}>
          <MarkKeptOffer />
        </div>
      </div>
    );
  }

  const elapsed = elapsedMs(session, "focus", now);
  const remaining = Math.max(0, session.targetMs - elapsed);
  const shown = session.style === "timer" ? remaining : elapsed;

  return (
    <>
      <div
        data-focus-bar
        role="status"
        style={{
          position: "fixed", top: 0, left: 0, right: 0, height: SESSION_BAR_H,
          zIndex: z.overlay + 4,
          display: "flex", alignItems: "center", gap: 12,
          padding: "0 14px 0 18px",
          fontFamily: FONT,
          // a hairline and a whisper of accent, not a filled header — the band
          // should cost almost nothing in visual weight
          background: "rgb(var(--gooni-surf, 11 15 13) / 0.72)",
          backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
          borderBottom: `1px solid ${running ? "rgb(74 222 128 / 0.22)" : ink(0.1)}`,
        }}
      >
        {/* the motion IS the signal — only a live run pulses */}
        {running ? (
          <span
            aria-hidden
            style={{
              width: 6, height: 6, borderRadius: 999, flex: "none",
              background: frostInk.accent,
              animation: "gooni-bar-pulse 1.8s ease-in-out infinite",
            }}
          />
        ) : (
          <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, border: `1px solid ${ink(0.34)}`, flex: "none" }} />
        )}
        <style>{`@keyframes gooni-bar-pulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>

        <div
          style={{
            display: "flex", alignItems: "baseline", gap: 10, minWidth: 0, flex: 1,
            fontFamily: FONT, textAlign: "left",
          }}
        >
          <span
            style={{
              fontSize: 12.5, color: ink(0.88), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              textDecoration: session.kept ? "line-through" : "none",
            }}
          >
            {session.title}
          </span>
          <span
            style={{
              fontSize: 12.5, flex: "none", fontVariantNumeric: "tabular-nums",
              color: running ? frostInk.accent : ink(0.45),
            }}
          >
            {mmss(shown)}
          </span>
          {!running && (
            <span style={{ fontSize: 10, letterSpacing: "0.06em", color: ink(0.4), flex: "none" }}>paused</span>
          )}
          {session.style === "timer" && (
            <span style={{ fontSize: 10, letterSpacing: "0.06em", color: ink(0.32), flex: "none" }}>timer</span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 2, flex: "none" }}>
          <BarButton
            label={running ? "Pause the session" : "Resume the session"}
            accent={!running}
            onClick={() =>
              running
                ? useFocusSessionStore.getState().pause()
                : useFocusSessionStore.getState().resume()
            }
          >
            {running ? <Pause size={13} fill="currentColor" strokeWidth={0} /> : <Play size={13} fill="currentColor" strokeWidth={0} />}
          </BarButton>
          <BarButton label="End the session" onClick={() => void end()}>
            <X size={13} strokeWidth={1.9} />
          </BarButton>
        </div>
      </div>

    </>
  );
}
