import { useCallback, useEffect, useRef, useState } from "react";
import { FONT } from "../../ui";
import { fetchDisplay, setDisplayState, type DisplayState } from "../../services/api";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { FOCUS_PALETTES } from "./focusPalette";
import { FocusDashboard } from "./FocusDashboard";
import { GooniAsleep } from "./GooniAsleep";

// The kiosk state machine (whiteboard, 2026-07-28).
//
//   deep_rest  away from home        · dimmest, barely moving
//   rest       home, Gooni asleep    · the default; ~90% of the day
//   awake      Gooni up behind the desk, still NO data
//   dash       the dashboard
//
// The load-bearing idea is that `awake` is a real state and not a transition.
// Presence alone (walking past, nudging the mouse) only rouses him — it does
// NOT put your promises, your calendar, and your habits on a screen anyone in
// the room can read. Data costs a deliberate act: the desk button.
//
// Two clocks drive it:
//   LOCAL   mouse / key at the desk → awake. Idle → back to rest. Kept in the
//           browser because it fires constantly and belongs to this viewport.
//   REMOTE  GET /display, polled. Carries the intents that can't originate here
//           — the desk button, and Shortcuts on leaving/arriving home.
//
// Mounted ONLY by the /focus kiosk. On `/` the dashboard renders bare: opening
// a tab is already the deliberate act, and a sleeping character in a browser
// window is friction, not presence.

const POLL_MS = 2_000;
const IDLE_TO_REST_MS = 5 * 60_000; // no input at the desk for 5m → he settles
const STIR_MS = 900; // the head-lift beat before `awake` proper

export function AmbientShell() {
  const theme = useGooniThemeStore((s) => s.theme);
  const pal = FOCUS_PALETTES[theme];

  const [state, setState] = useState<DisplayState>("rest");
  const [stirring, setStirring] = useState(false);
  // Last state the SERVER told us. Only a change to this should override what's
  // on screen — otherwise every 2s poll would stomp a local wake.
  const lastRemoteRef = useRef<DisplayState | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const stateRef = useRef<DisplayState>("rest");
  stateRef.current = state;

  const settle = useCallback(() => {
    // Never yank the dashboard away mid-read on an idle timer — you might be
    // looking at it from across the room, which is the entire point of a kiosk.
    if (stateRef.current === "awake") setState("rest");
  }, []);

  const bumpIdle = useCallback(() => {
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(settle, IDLE_TO_REST_MS);
  }, [settle]);

  // LOCAL: presence at the desk wakes him (never straight to dash).
  useEffect(() => {
    function onActivity() {
      bumpIdle();
      if (stateRef.current === "rest" || stateRef.current === "deep_rest") {
        setStirring(true);
        window.setTimeout(() => {
          setStirring(false);
          // Guard: a remote intent may have landed during the stir.
          if (stateRef.current === "rest" || stateRef.current === "deep_rest") setState("awake");
        }, STIR_MS);
      }
    }
    window.addEventListener("mousemove", onActivity);
    window.addEventListener("keydown", onActivity);
    window.addEventListener("pointerdown", onActivity);
    bumpIdle();
    return () => {
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("pointerdown", onActivity);
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    };
  }, [bumpIdle]);

  // REMOTE: the desk button + the leave/arrive-home automations.
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const blob = await fetchDisplay();
        if (!alive) return;
        // EDGE-triggered, not level-triggered. If the server still says "dash"
        // from ten minutes ago, a local settle must be allowed to stand.
        if (blob.desired !== lastRemoteRef.current) {
          lastRemoteRef.current = blob.desired;
          setState(blob.desired);
        }
      } catch {
        /* offline → hold whatever's on screen; never blank the display */
      }
    }
    void tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  // Own the page ground while mounted, like the dashboard does.
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = pal.paper;
    document.body.style.margin = "0";
    return () => {
      document.body.style.background = prev;
    };
  }, [pal.paper]);

  if (state === "dash") return <FocusDashboard />;

  const summon = async () => {
    setState("dash");
    // Mirror it server-side so the state survives a kiosk refresh, and so the
    // desk button and the on-screen affordance can't disagree.
    lastRemoteRef.current = "dash";
    await setDisplayState("dash", "ui").catch(() => {});
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: pal.paper,
        color: pal.ink,
        fontFamily: FONT,
        overflow: "hidden",
        cursor: state === "awake" ? "default" : "none",
      }}
    >
      <GooniAsleep pal={pal} deep={state === "deep_rest"} stirring={stirring || state === "awake"} />

      {/* The summon affordance exists only once he's awake — at rest the screen
          is a sleeping character and nothing else. */}
      {state === "awake" && (
        <button
          onClick={() => void summon()}
          style={{
            position: "absolute",
            left: "50%",
            bottom: "17%",
            transform: "translateX(-50%)",
            fontFamily: FONT,
            fontSize: 12,
            letterSpacing: "0.06em",
            padding: "9px 24px",
            borderRadius: 999,
            border: `1px solid ${pal.rule}`,
            background: "transparent",
            color: pal.ink2,
            cursor: "pointer",
            animation: "gooni-fade-in 700ms ease both",
          }}
        >
          show me the day
        </button>
      )}

      <style>{`@keyframes gooni-fade-in { from { opacity: 0 } to { opacity: 1 } }`}</style>
    </div>
  );
}
