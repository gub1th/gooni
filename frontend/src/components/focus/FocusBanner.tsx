import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Pause, Play, X } from "lucide-react";
import { FONT, frostInk, z } from "../../ui";
import { ink } from "../ambient/ambientInk";
import {
  elapsedMs,
  useFocusSessionStore,
  type FocusMode,
} from "../../stores/useFocusSessionStore";
import { endFocusSession, fetchFocusTotals, fmtMinutes } from "../../services/focusTime";
import { useFocusOverlayStore } from "../../stores/useFocusOverlayStore";
import { FocusExpanded } from "./FocusExpanded";

// THE focus banner — one slot, two states, on every surface.
//
// Focus is a STATE, not a PLACE. The first cut made it a page, which conflated
// BEING in focus with LOOKING AT focus: the controls lived on a route, so the
// moment you navigated away you could not pause. Nobody opens a page to pause
// music. This strip is the fix — it follows you, so pause/resume/stop are
// always under your thumb no matter what surface you are on.
//
//   nothing running → `focused today`, the day summary this slot already showed
//   session running → task · elapsed · pause/resume · end · expand
//
// Expanding is a STATE OF THE BANNER, not a destination: it opens in place into
// a dimmed overlay over the current page. Dimmed and not full-screen on purpose
// — the home stays visible behind it and a task can still be ticked off there.
// It is mechanically a modal, and that is only safe BECAUSE this strip persists
// outside it; control never lives solely inside the overlay, which is exactly
// what made the page version fail.
//
// NOT a second source of truth: start, seal and write stay in the store and in
// `endFocusSession`. This is a control surface over them.

const TOTALS_POLL_MS = 30_000;

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** What the strip should say about a session that is not accruing focus. */
function stateLabel(mode: FocusMode, running: boolean): string | null {
  if (!running) return "paused";
  if (mode === "break") return "break";
  return null;
}

function StripButton({
  label,
  onClick,
  children,
  accent,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  accent?: boolean;
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
        color: accent ? frostInk.accent : hover ? ink(0.9) : ink(0.42),
        transition: "color 140ms ease",
      }}
    >
      {children}
    </button>
  );
}

export function FocusBanner() {
  const session = useFocusSessionStore((s) => s.session);
  const expanded = useFocusOverlayStore((s) => s.open);
  const setExpanded = useFocusOverlayStore((s) => s.setOpen);
  const [now, setNow] = useState(() => Date.now());
  const [today, setToday] = useState(0);
  const ending = useRef(false);

  const running = !!session?.running;
  const mode: FocusMode = session?.mode ?? "focus";

  // Tick only while something is actually accruing. A paused session freezes,
  // which is the honest reading — the number is not moving.
  useEffect(() => {
    if (!running) return;
    const iv = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(iv);
  }, [running]);

  const loadTotals = useCallback(async () => {
    try {
      setToday((await fetchFocusTotals()).today);
    } catch {
      /* ambient — the trackable may not exist yet, and 0 is honest */
    }
  }, []);

  useEffect(() => {
    void loadTotals();
    const iv = window.setInterval(() => void loadTotals(), TOTALS_POLL_MS);
    return () => window.clearInterval(iv);
  }, [loadTotals]);

  // A session ending writes its entry, so the day total moves — refresh when the
  // store drops back to null.
  useEffect(() => {
    if (session == null) {
      setExpanded(false);
      void loadTotals();
    }
  }, [session, loadTotals]);

  async function end() {
    if (ending.current) return;
    ending.current = true;
    try {
      await endFocusSession();
    } catch {
      /* the session survives a failed write by design; the expanded surface
         is where the error is explained, so leave the strip quiet */
    } finally {
      ending.current = false;
    }
  }

  // ── idle: the day summary this slot already showed ────────────────────────
  if (!session) {
    return (
      <div style={{ textAlign: "right", lineHeight: 1.15, fontFamily: FONT }}>
        <div style={{ fontSize: 19, fontWeight: 500, letterSpacing: "-0.01em", color: ink(0.92), fontVariantNumeric: "tabular-nums" }}>
          {fmtMinutes(today)}
        </div>
        <div style={{ fontSize: 10, letterSpacing: "0.02em", color: ink(0.38), marginTop: 2 }}>focused today</div>
      </div>
    );
  }

  // ── running: the session itself ───────────────────────────────────────────
  const label = stateLabel(mode, running);
  const clock = mmss(elapsedMs(session, mode, now));

  return (
    <>
      <div
        data-focus-banner
        style={{
          display: "flex", alignItems: "center", gap: 10, fontFamily: FONT,
          maxWidth: "min(46vw, 420px)",
        }}
      >
        {/* only a LIVE focus run gets the pulsing dot — a paused or break
            session is not accruing and must not borrow that signal */}
        {running && mode === "focus" ? (
          <span
            aria-hidden
            style={{ width: 7, height: 7, borderRadius: 999, background: frostInk.accent, flex: "none", animation: "gooni-banner-pulse 1.8s ease-in-out infinite" }}
          />
        ) : (
          <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, border: `1px solid ${ink(0.34)}`, flex: "none" }} />
        )}
        <style>{`@keyframes gooni-banner-pulse{0%,100%{opacity:1}50%{opacity:0.35}}`}</style>

        <button
          onClick={() => setExpanded(true)}
          title="expand the session"
          style={{
            display: "flex", alignItems: "baseline", gap: 8, minWidth: 0,
            border: "none", background: "transparent", padding: 0, cursor: "pointer", fontFamily: FONT,
          }}
        >
          <span
            style={{
              fontSize: 13, color: ink(0.9), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              textDecoration: session.kept ? "line-through" : "none",
            }}
          >
            {session.title}
          </span>
          <span style={{ fontSize: 13, color: running ? frostInk.accent : ink(0.42), fontVariantNumeric: "tabular-nums", flex: "none" }}>
            {clock}
          </span>
          {label && (
            <span style={{ fontSize: 10, letterSpacing: "0.06em", color: ink(0.38), flex: "none" }}>{label}</span>
          )}
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 2, flex: "none" }}>
          <StripButton
            label={running ? "Pause the session" : "Resume the session"}
            accent={!running}
            onClick={() =>
              running
                ? useFocusSessionStore.getState().pause()
                : useFocusSessionStore.getState().resume()
            }
          >
            {running ? <Pause size={13} fill="currentColor" strokeWidth={0} /> : <Play size={13} fill="currentColor" strokeWidth={0} />}
          </StripButton>
          <StripButton label="Expand the session" onClick={() => setExpanded(true)}>
            <Maximize2 size={12} strokeWidth={1.9} />
          </StripButton>
          <StripButton label="End the session" onClick={() => void end()}>
            <X size={13} strokeWidth={1.9} />
          </StripButton>
        </div>
      </div>

      {expanded &&
        createPortal(
          <div
            style={{
              position: "fixed", inset: 0, zIndex: z.modalScrim,
              // DIMMED, and the dim is VISUAL ONLY — pointerEvents none, so the
              // page behind stays live and a task can still be ticked off back
              // there. That is the explicit ask, and it is why this is not a
              // real modal: blocking the page would make the overlay a place
              // again, which is the whole thing being undone. Esc collapses.
              pointerEvents: "none",
              background: "rgba(0,0,0,0.45)",
              backdropFilter: "blur(3px)", WebkitBackdropFilter: "blur(3px)",
              display: "grid", placeItems: "center",
              animation: "gooni-focus-overlay-in 180ms ease-out",
            }}
          >
            <style>{`@keyframes gooni-focus-overlay-in{from{opacity:0}to{opacity:1}}`}</style>
            <div
              role="dialog"
              aria-label="Focus session"
              style={{
                // the card is the only live part of this layer
                pointerEvents: "auto",
                width: "min(560px, 92vw)", height: "min(620px, 88vh)",
                background: "rgb(var(--gooni-surf, 11 15 13))",
                border: `1px solid ${ink(0.12)}`,
                borderRadius: 18, overflow: "hidden",
                animation: "gooni-focus-card-in 200ms cubic-bezier(0.22,1,0.36,1)",
              }}
            >
              <style>{`@keyframes gooni-focus-card-in{from{opacity:0;transform:translateY(8px) scale(0.98)}to{opacity:1;transform:none}}`}</style>
              <FocusExpanded variant="overlay" onCollapse={() => setExpanded(false)} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
