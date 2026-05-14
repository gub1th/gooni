import { useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { AdaptiveDpr, AdaptiveEvents, Trail, useProgress } from "@react-three/drei";
import * as THREE from "three";
import { Atmosphere } from "./Atmosphere";
import { Pond } from "./Pond";
import { LilyPads } from "./LilyPads";
import { Boat } from "./Boat";
import { Shore } from "./Shore";
import { Ripples, RippleClickPlane, type RippleHandle } from "./Ripples";
import { PostFX } from "./PostFX";
import { AmbientAudio } from "./AmbientAudio";
import { MobileJoystick } from "./MobileJoystick";
import { Petals } from "./Petals";
import { fireBoatReset, useBoatKeyboard } from "./useBoatControls";

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
  const ripplesRef = useRef<RippleHandle | null>(null);

  // Wire keyboard once at scene mount. Joystick writes into the same
  // singleton input state — both modalities coexist.
  useBoatKeyboard();

  const dprMax = typeof window === "undefined"
    ? 1.5
    : Math.min(window.devicePixelRatio ?? 1, 2);

  return (
    <>
      <Canvas
        shadows={!mobile}
        dpr={[1, dprMax]}
        // Start further out + lower so the boat-follow lerp draws a
        // slow ~2s dolly toward the rower on first paint. Free intro.
        camera={{ position: [3, 2.2, 14], fov: 54, near: 0.1, far: 200 }}
        gl={{
          antialias: !mobile,
          powerPreference: "high-performance",
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.1,
          outputColorSpace: THREE.SRGBColorSpace,
        }}
      >
        <Atmosphere mobile={mobile} />
        <Pond />
        <Shore mobile={mobile} />
        <LilyPads count={mobile ? 14 : 32} />
        <Petals count={mobile ? 60 : 140} />

        {/* Wake trail — drei Trail walks the wrapped child for an
            Object3D target. Tapered ease-out so the tip dissolves. */}
        <Trail
          width={0.55}
          length={6}
          decay={4}
          color={"#fff5e0"}
          attenuation={(t: number) => t * t}
        >
          <Boat />
        </Trail>

        <Ripples ref={ripplesRef} />
        <RippleClickPlane onHit={(x, z) => ripplesRef.current?.spawn(x, z)} />

        <AdaptiveDpr pixelated />
        <AdaptiveEvents />

        <PostFX mobile={mobile} />
      </Canvas>

      <SteeringHint mobile={mobile} />
      {mobile && <MobileJoystick />}
      {mobile && <MobileResetButton />}

      {!entered && <StartOverlay onEnter={() => setEntered(true)} />}
      {entered && <AmbientAudio />}
    </>
  );
}

function StartOverlay({ onEnter }: { onEnter: () => void }) {
  const { progress, active } = useProgress();
  // Once all assets loaded, the bar slides off-screen; clicking still
  // dismisses regardless so impatient users aren't blocked.
  const ready = !active || progress >= 99;

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
        cursor: ready ? "pointer" : "wait",
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
        {ready ? "tap to enter" : "preparing the pond…"}
      </div>
      {/* Thin progress bar — only visible while loading. Smooth lerp
          via CSS transition. */}
      <div style={{
        width: 220,
        height: 2,
        background: "rgba(255,255,255,0.15)",
        borderRadius: 999,
        overflow: "hidden",
        marginTop: 4,
        opacity: ready ? 0 : 1,
        transition: "opacity 400ms ease",
      }}>
        <div style={{
          width: `${Math.max(2, progress)}%`,
          height: "100%",
          background: "rgba(255,255,255,0.85)",
          transition: "width 280ms ease",
        }} />
      </div>
    </div>
  );
}

// Touch parity for the R reset key — mobile users can't otherwise
// unstick from the tether boundary or recenter the camera.
function MobileResetButton() {
  return (
    <button
      onClick={() => fireBoatReset()}
      aria-label="Recenter boat"
      style={{
        position: "fixed",
        bottom: 32,
        right: 24,
        width: 48,
        height: 48,
        borderRadius: "50%",
        background: "rgba(0,0,0,0.28)",
        border: "1px solid rgba(255,255,255,0.20)",
        color: "rgba(255,255,255,0.9)",
        fontFamily: "'Inter', system-ui, sans-serif",
        fontSize: 11,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        backdropFilter: "blur(6px)",
        cursor: "pointer",
        zIndex: 6,
      }}
    >
      reset
    </button>
  );
}

function SteeringHint({ mobile }: { mobile: boolean }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]
          .includes(e.code)
      ) {
        setVisible(false);
      }
    }
    function onTouch() {
      setVisible(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("touchstart", onTouch);
    const t = setTimeout(() => setVisible(false), 9000);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("touchstart", onTouch);
      clearTimeout(t);
    };
  }, []);
  if (!visible) return null;
  return (
    <div style={{
      position: "fixed",
      // Don't overlap the joystick on mobile — sit it up top instead.
      bottom: mobile ? "auto" : 28,
      top: mobile ? 28 : "auto",
      left: "50%",
      transform: "translateX(-50%)",
      color: "rgba(255,255,255,0.88)",
      fontSize: 12.5,
      letterSpacing: "0.04em",
      fontFamily: FONT,
      background: "rgba(0,0,0,0.30)",
      padding: "7px 14px",
      borderRadius: 999,
      backdropFilter: "blur(6px)",
      pointerEvents: "none",
      zIndex: 5,
      textShadow: "0 1px 4px rgba(0,0,0,0.4)",
      whiteSpace: "nowrap",
    }}>
      {mobile
        ? "drag the stick · tap the water"
        : "WASD to row · click the water · R to reset"}
    </div>
  );
}
