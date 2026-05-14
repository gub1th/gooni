import { useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Atmosphere } from "./Atmosphere";
import { Pond } from "./Pond";
import { LilyPads } from "./LilyPads";
import { Boat } from "./Boat";
import { AmbientAudio } from "./AmbientAudio";

const FONT = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
const DISPLAY = "'Iowan Old Style', 'Hoefler Text', Georgia, 'Times New Roman', serif";

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState<boolean>(() =>
    typeof window === "undefined" ? false : window.innerWidth < 768,
  );
  useEffect(() => {
    function onResize() {
      setMobile(window.innerWidth < 768);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return mobile;
}

export function Scene() {
  const mobile = useIsMobile();
  const [entered, setEntered] = useState(false);
  // DPR cap prevents 3× retina death-spiral; computed once on first render.
  const dprMax = typeof window === "undefined"
    ? 1.5
    : Math.min(window.devicePixelRatio ?? 1, 2);

  return (
    <>
      <Canvas
        shadows={!mobile}
        dpr={[1, dprMax]}
        camera={{ position: [0, 4, 8], fov: 50, near: 0.1, far: 200 }}
        gl={{ antialias: true, powerPreference: "high-performance" }}
      >
        <Atmosphere mobile={mobile} />
        <Pond />
        <LilyPads count={mobile ? 12 : 28} />
        <Boat />
      </Canvas>

      {/* Subtle steering hint, fades after first input. */}
      <SteeringHint />

      {/* Tap-to-enter overlay — gates audio (Chrome autoplay policy) and
          doubles as a mood-setting moment before the scene reveals. */}
      {!entered && <StartOverlay onEnter={() => setEntered(true)} />}
      {entered && <AmbientAudio />}
    </>
  );
}

function StartOverlay({ onEnter }: { onEnter: () => void }) {
  return (
    <div
      onClick={onEnter}
      style={{
        position: "fixed",
        inset: 0,
        background:
          "radial-gradient(ellipse 800px 400px at 50% 50%, rgba(0,0,0,0.0) 0%, rgba(0,0,0,0.45) 100%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        cursor: "pointer",
        color: "#fff",
        fontFamily: FONT,
        zIndex: 10,
        backdropFilter: "blur(2px)",
      }}
    >
      <div style={{
        fontFamily: DISPLAY,
        fontSize: 38,
        letterSpacing: "-0.4px",
        textShadow: "0 2px 18px rgba(0,0,0,0.4)",
      }}>
        a calm place
      </div>
      <div style={{
        fontSize: 13.5,
        opacity: 0.85,
        textShadow: "0 1px 8px rgba(0,0,0,0.5)",
      }}>
        tap to enter
      </div>
    </div>
  );
}

function SteeringHint() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
        setVisible(false);
      }
    }
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => setVisible(false), 8000);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, []);
  if (!visible) return null;
  return (
    <div style={{
      position: "fixed",
      bottom: 28,
      left: "50%",
      transform: "translateX(-50%)",
      color: "rgba(255,255,255,0.85)",
      fontSize: 12.5,
      letterSpacing: "0.04em",
      fontFamily: FONT,
      background: "rgba(0,0,0,0.28)",
      padding: "7px 14px",
      borderRadius: 999,
      backdropFilter: "blur(6px)",
      pointerEvents: "none",
      zIndex: 5,
      textShadow: "0 1px 4px rgba(0,0,0,0.4)",
    }}>
      WASD / arrow keys to row
    </div>
  );
}
