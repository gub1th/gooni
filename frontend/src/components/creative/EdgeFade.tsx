import { useEffect, useState } from "react";
import { subscribeLandings } from "./useDanielControls";

// Full-screen black overlay that flashes during a fall-off-the-map.
// Subscribes to landings; on `fellOff: true` it pulses opacity 0→1→0
// over ~2.1s while the character is mid-fall + respawning.

const FADE_IN_MS = 220;
const HOLD_MS = 1500;
const FADE_OUT_MS = 380;

export function EdgeFade() {
  const [stage, setStage] = useState<"idle" | "in" | "hold" | "out">("idle");

  useEffect(() => {
    return subscribeLandings((e) => {
      if (!e.fellOff) return;
      setStage("in");
      const t1 = setTimeout(() => setStage("hold"), FADE_IN_MS);
      const t2 = setTimeout(() => setStage("out"), FADE_IN_MS + HOLD_MS);
      const t3 = setTimeout(() => setStage("idle"), FADE_IN_MS + HOLD_MS + FADE_OUT_MS);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    });
  }, []);

  if (stage === "idle") return null;
  const opacity = stage === "in" || stage === "hold" ? 1 : 0;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        opacity,
        transition: stage === "in"
          ? `opacity ${FADE_IN_MS}ms ease-in`
          : stage === "out"
            ? `opacity ${FADE_OUT_MS}ms ease-out`
            : "none",
        pointerEvents: "none",
        zIndex: 9,
      }}
    />
  );
}
