import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Pause, Play, Square } from "lucide-react";
import { FONT, frostInk } from "../../ui";
import { ink } from "./ambientInk";
import { elapsedMs, useFocusSessionStore, type FocusStyle } from "../../stores/useFocusSessionStore";

// The session, IN THE WAVE'S SLOT.
//
// The home works because it has exactly ONE anchor. Expanding into a modal
// stacked a second main thing on top of the first, so that is gone: while a
// session runs, the session IS the wave. Same slot, same geometry — only what
// it displays changes, and when the session ends it goes back to being a wave.
//
// That deletes three problems rather than solving them: no overlay, no dimming,
// and no exposure to the modal stacking bug. The home also stays fully
// interactive underneath, so a task can be ticked off mid-session.
//
// THE WAVE'S OTHER TWO JOBS SURVIVE, and they are the part that breaks if this
// is rushed:
//
//   • capture — `/` and hover still open the box out of this slot. `MorphLine`
//     stays mounted and simply hides its resting stroke while this shows, so
//     the box still morphs out of the same rect. This display fades as the box
//     opens; neither capture nor voice is disabled during a session.
//   • the pending-signal glow — the wave tints green off `energyRef` (driven by
//     pending accept/deny items). Hiding the stroke would have silently dropped
//     a live prod behaviour, so the SAME ref tints this display instead: the
//     clock warms toward the accent as items pile up. Read per frame off the
//     ref, never through React state, exactly as the line does it.

const RING_R = 92;
const RING_C = 2 * Math.PI * RING_R;

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function CtlButton({
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
        width: 30, height: 30, padding: 0, borderRadius: 999, cursor: "pointer",
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

export function SessionInWave({
  cx,
  cy,
  hidden,
  energyRef,
  onStop,
}: {
  cx: number;
  cy: number;
  /** the capture box is open — this yields the slot to it */
  hidden: boolean;
  /** the pending-signal energy the wave would otherwise be showing */
  energyRef: MutableRefObject<number>;
  /** the host owns the stop, because it also refreshes the day totals */
  onStop: () => void;
}) {
  const session = useFocusSessionStore((s) => s.session);
  const [now, setNow] = useState(() => Date.now());
  const glowRef = useRef<HTMLDivElement>(null);

  const running = !!session?.running;

  useEffect(() => {
    if (!running) return;
    const iv = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(iv);
  }, [running]);

  // The glow, carried over from the line. Per-frame off the ref, no re-render.
  //
  // It MIXES, it does not switch. The line does `mixColor(rest, GREEN, energy)`,
  // and the resting energy is already 0.14 (`energyFor(0)`), so a hard
  // `energy > 0 ? accent : ink` reads as a permanently green clock — which is
  // exactly what it did on first run. Two stacked layers give the same
  // proportional mix without needing to resolve the accent CSS var in JS: the
  // accent layer's opacity IS the mix factor.
  useEffect(() => {
    let raf = 0;
    let cur = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      cur += (energyRef.current - cur) * Math.min(1, dt * 3);
      if (glowRef.current) glowRef.current.style.opacity = String(Math.min(1, Math.max(0, cur)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [energyRef]);

  if (!session) return null;

  const style: FocusStyle = session.style;
  const elapsed = elapsedMs(session, "focus", now);
  const shown = style === "timer" ? Math.max(0, session.targetMs - elapsed) : elapsed;
  const frac = style === "timer" && session.targetMs > 0 ? Math.min(1, elapsed / session.targetMs) : 0;

  return (
    <div
      data-session-slot
      style={{
        position: "absolute",
        left: cx, top: cy,
        transform: "translate(-50%, -50%)",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
        fontFamily: FONT, zIndex: 2,
        opacity: hidden ? 0 : 1,
        pointerEvents: hidden ? "none" : "auto",
        transition: "opacity 240ms ease",
      }}
    >
      <div style={{ position: "relative", display: "grid", placeItems: "center", width: 200, height: 200 }}>
        {/* the ring belongs to the TIMER only — a stopwatch has no target, so a
            ring there would draw progress against nothing */}
        {style === "timer" && (
          <svg viewBox="0 0 200 200" width={200} height={200} style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }} aria-hidden>
            <circle cx="100" cy="100" r={RING_R} fill="none" stroke={ink(0.12)} strokeWidth={1.5} />
            <circle
              cx="100" cy="100" r={RING_R} fill="none"
              stroke={frostInk.accent} strokeWidth={1.5} strokeLinecap="round"
              strokeDasharray={RING_C}
              strokeDashoffset={RING_C * (1 - frac)}
              style={{ transition: "stroke-dashoffset 600ms linear" }}
            />
          </svg>
        )}
        {/* base ink, with the accent layered over it at the mix factor */}
        <div style={{ position: "relative", display: "grid", placeItems: "center" }}>
          <div
            style={{
              fontSize: style === "timer" ? 52 : 62,
              fontWeight: 500, letterSpacing: "-0.035em", lineHeight: 1,
              fontVariantNumeric: "tabular-nums", color: ink(0.92),
            }}
          >
            {mmss(shown)}
          </div>
          <div
            ref={glowRef}
            aria-hidden
            style={{
              position: "absolute", inset: 0, display: "grid", placeItems: "center",
              fontSize: style === "timer" ? 52 : 62,
              fontWeight: 500, letterSpacing: "-0.035em", lineHeight: 1,
              fontVariantNumeric: "tabular-nums", color: frostInk.accent,
              opacity: 0, pointerEvents: "none",
            }}
          >
            {mmss(shown)}
          </div>
        </div>
      </div>

      <div
        style={{
          fontSize: 16, fontWeight: 450, letterSpacing: "-0.012em",
          maxWidth: "22ch", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          color: session.kept ? ink(0.45) : ink(0.72),
          textDecoration: session.kept ? "line-through" : "none",
        }}
        title={session.title}
      >
        {session.title}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
        <CtlButton
          label={running ? "Pause the session" : "Resume the session"}
          accent={!running}
          onClick={() =>
            running
              ? useFocusSessionStore.getState().pause()
              : useFocusSessionStore.getState().resume()
          }
        >
          {running ? <Pause size={15} fill="currentColor" strokeWidth={0} /> : <Play size={15} fill="currentColor" strokeWidth={0} />}
        </CtlButton>
        <CtlButton label="Stop the session" onClick={onStop}>
          <Square size={12} fill="currentColor" strokeWidth={0} />
        </CtlButton>
      </div>

      {!running && (
        <div style={{ fontSize: 10, letterSpacing: "0.06em", color: ink(0.38) }}>paused</div>
      )}
      {style === "timer" && (
        <div style={{ fontSize: 10, letterSpacing: "0.06em", color: ink(0.3) }}>timer</div>
      )}
    </div>
  );
}
