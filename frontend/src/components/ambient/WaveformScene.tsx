import { useEffect, useMemo, useState, type MutableRefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { KernelSize } from "postprocessing";
import * as THREE from "three";
import { WAVE_FRAG, WAVE_VERT } from "./waveformShader";
import { useReducedMotion } from "../creative/useReducedMotion";

// The gorgeous bit: a full-viewport plane running the waveform shader with a
// bloom pass on top. Energy + active are passed as refs so pointer moves and
// signal-count changes never re-render the R3F tree — the frame loop reads the
// refs and eases the uniforms toward them. Pausing (tab hidden) flips the
// Canvas frameloop to "never" so an idle background tab costs zero GPU.

interface DrivenRefs {
  energyRef: MutableRefObject<number>; // 0..1 pending-signal energy
  activeRef: MutableRefObject<number>; // 0..1 interaction (hover/focus)
}

function WaveMesh({ energyRef, activeRef, reduce }: DrivenRefs & { reduce: boolean }) {
  const { viewport } = useThree();
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uEnergy: { value: 0 },
      uActive: { value: 0 },
      uAspect: { value: 1 },
      uCore: { value: new THREE.Color("#FFFFFF") },
      uGlow: { value: new THREE.Color("#4ADE80") },
    }),
    [],
  );

  useFrame((_state, delta) => {
    // clamp delta so a background tab that resumes doesn't jump the animation
    const dt = Math.min(delta, 0.05);
    if (!reduce) uniforms.uTime.value += dt;
    uniforms.uEnergy.value += (energyRef.current - uniforms.uEnergy.value) * Math.min(1, dt * 3);
    uniforms.uActive.value += (activeRef.current - uniforms.uActive.value) * Math.min(1, dt * 5);
    uniforms.uAspect.value = viewport.width / viewport.height;
  });

  return (
    <mesh scale={[viewport.width, viewport.height, 1]}>
      <planeGeometry args={[1, 1]} />
      <shaderMaterial uniforms={uniforms} vertexShader={WAVE_VERT} fragmentShader={WAVE_FRAG} />
    </mesh>
  );
}

export function WaveformScene({
  energyRef,
  activeRef,
  paused,
}: DrivenRefs & { paused: boolean }) {
  const reduce = useReducedMotion();
  // Reduced motion → render one still frame; otherwise pause only when the
  // tab is hidden. "demand" renders once on mount then stops.
  const frameloop = reduce ? "demand" : paused ? "never" : "always";

  return (
    <Canvas
      frameloop={frameloop}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      camera={{ position: [0, 0, 5], fov: 50 }}
      style={{ position: "fixed", inset: 0, zIndex: 0, background: "#000000" }}
      onCreated={({ gl }) => gl.setClearColor("#000000", 1)}
    >
      <WaveMesh energyRef={energyRef} activeRef={activeRef} reduce={reduce} />
      <EffectComposer enableNormalPass={false} multisampling={2}>
        <Bloom
          intensity={1.15}
          kernelSize={KernelSize.LARGE}
          luminanceThreshold={0.15}
          luminanceSmoothing={0.4}
          mipmapBlur
        />
      </EffectComposer>
    </Canvas>
  );
}

// Track document visibility so the parent can pause the scene when the tab is
// backgrounded (idle background tab = zero GPU).
export function useTabHidden(): boolean {
  const [hidden, setHidden] = useState(
    typeof document !== "undefined" && document.visibilityState === "hidden",
  );
  useEffect(() => {
    function onVis() {
      setHidden(document.visibilityState === "hidden");
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  return hidden;
}
