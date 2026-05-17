import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

// Ambient floating particles per spec — 15-20 tiny warm-white motes
// drifting upward with subtle lateral wander, respawned when they
// drift out of the plaza bubble. Separate from the event-driven VFX
// pool in Particles.tsx so the systems don't fight for pool slots.

const COUNT = 18;
const FIELD_R = 14;
const Y_MIN = 0.2;
const Y_MAX = 8;
const UPWARD_VEL = 0.18;
const LATERAL_DRIFT_AMP = 0.06;

type Mote = {
  x: number; y: number; z: number;
  vx: number; vz: number;
  phase: number;
  baseScale: number;
};

export function AmbientMotes() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const motes = useRef<Mote[]>([]);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useLayoutEffect(() => {
    motes.current = Array.from({ length: COUNT }, () => ({
      x: (Math.random() - 0.5) * FIELD_R * 2,
      y: Y_MIN + Math.random() * (Y_MAX - Y_MIN),
      z: (Math.random() - 0.5) * FIELD_R * 2,
      vx: (Math.random() - 0.5) * 0.10,
      vz: (Math.random() - 0.5) * 0.10,
      phase: Math.random() * Math.PI * 2,
      baseScale: 0.03 + Math.random() * 0.025,
    }));
  }, []);

  useFrame((state, rawDt) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dt = Math.min(rawDt, 0.05);
    const t = state.clock.getElapsedTime();
    motes.current.forEach((m, i) => {
      m.y += UPWARD_VEL * dt;
      m.x += (Math.sin(t * 0.6 + m.phase) * LATERAL_DRIFT_AMP + m.vx) * dt;
      m.z += (Math.cos(t * 0.7 + m.phase) * LATERAL_DRIFT_AMP + m.vz) * dt;
      if (m.y > Y_MAX || Math.hypot(m.x, m.z) > FIELD_R) {
        m.x = (Math.random() - 0.5) * FIELD_R * 1.5;
        m.y = Y_MIN;
        m.z = (Math.random() - 0.5) * FIELD_R * 1.5;
      }
      const breathe = 1 + Math.sin(t * 2.4 + m.phase) * 0.20;
      dummy.position.set(m.x, m.y, m.z);
      dummy.scale.setScalar(m.baseScale * breathe);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, COUNT]}
      castShadow={false}
      receiveShadow={false}
      frustumCulled={false}
    >
      <sphereGeometry args={[1, 6, 5]} />
      <meshBasicMaterial
        color="#ffe9b4"
        transparent
        opacity={0.32}
        depthWrite={false}
        fog={false}
      />
    </instancedMesh>
  );
}
