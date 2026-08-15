import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { FONT } from "../../ui";
import { ink } from "./ambientInk";
import {
  PROACTIVE_POLL_MS,
  dismissProactiveObservation,
  fetchProactiveObservation,
  type ProactiveObservation,
} from "../../services/api";

// ONE line Gooni wrote without being asked.
//
// It sits above the wave with `CurrentActivityLine`, and the pair reads as a
// sentence: the activity line is the MIRROR (what you're on), this is the
// REMARK (what that means next to what you said you'd do). The remark goes
// above the mirror because it is the one you'd want to read first.
//
// Same treatment as everything else that is not the wave: plain text on the
// void, no frost, no card, no shadow, dim at rest, brighter on hover. It is
// deliberately NOT a notification — no badge, no chime, no slide-in, no accent
// colour. It appears the way a thought appears.
//
// SILENCE IS THE DEFAULT AND IT LOOKS LIKE SILENCE. `null` renders an empty
// slot of fixed height rather than a placeholder: the whole design rests on
// nothing being said most of the time, and a line that always says SOMETHING is
// a line you stop reading (the grindstone lesson, and the log dot's). The fixed
// height is so the layout doesn't twitch when one arrives — the groups above
// and below are pinned to viewport fractions, but a growing element between
// them still shifts what's inside its own slot.
//
// The dismiss × is hover-only and OPTIMISTIC: the observation is gone from the
// screen the instant it's clicked, and the POST that makes the dismissal
// durable (and buys the longer no-repeat cooldown, see proactive_service.
// is_repeat) trails behind it. A failed POST is deliberately NOT rolled back —
// the line is a suggestion, not state, and re-materialising something Daniel
// just waved away is a worse failure than one that quietly comes back on the
// next tick.

const SLOT_H = 20;

export function ProactiveLine() {
  const [obs, setObs] = useState<ProactiveObservation | null>(null);
  const [hover, setHover] = useState(false);
  // Ids waved away in this sitting. The dismiss POST is durable, but the poll
  // that's already in flight when it fires will still be carrying the old row —
  // without this the line blinks back for one cycle.
  const dismissedRef = useRef<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const next = await fetchProactiveObservation();
      setObs(next && dismissedRef.current.has(next.id) ? null : next);
    } catch {
      // Ambient — stay quiet. An unreachable backend is not evidence that
      // there is something to say, so the slot simply stays empty.
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), PROACTIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const dismiss = useCallback(() => {
    const target = obs;
    if (!target) return;
    dismissedRef.current.add(target.id);
    setObs(null);
    void dismissProactiveObservation(target.id).catch(() => {
      /* best effort — see the header note on why this isn't rolled back */
    });
  }, [obs]);

  return (
    <div
      style={{
        height: SLOT_H,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        fontFamily: FONT,
        fontSize: 13,
        lineHeight: 1.3,
        letterSpacing: 0.1,
        textAlign: "center",
        userSelect: "none",
        pointerEvents: obs ? "auto" : "none",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {obs && (
        <>
          <span
            style={{
              color: ink(hover ? 0.72 : 0.5),
              transition: "color 200ms ease",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={obs.content}
          >
            {obs.content}
          </span>
          <button
            type="button"
            aria-label="dismiss observation"
            onClick={dismiss}
            style={{
              display: "flex",
              alignItems: "center",
              border: "none",
              background: "transparent",
              padding: 0,
              cursor: "pointer",
              color: ink(0.5),
              opacity: hover ? 1 : 0,
              transition: "opacity 200ms ease",
            }}
          >
            <X size={12} strokeWidth={1.8} />
          </button>
        </>
      )}
    </div>
  );
}
