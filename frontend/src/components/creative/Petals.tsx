import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

type Props = { count: number };

// Sakura-style petal drift. Each petal owns its own position +
// rotation + swing phase; per-frame integration handles fall +
// horizontal sway. Petals that drop below the water respawn at the
// top w/ randomized x/z so the canopy stays evenly populated.

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const SPAWN_RADIUS = 38;
const SPAWN_HEIGHT_MIN = 6;
const SPAWN_HEIGHT_MAX = 16;
const FALL_SPEED_MIN = 0.25;
const FALL_SPEED_MAX = 0.55;
const SWING_AMP = 0.85;
const SWING_FREQ_MIN = 0.45;
const SWING_FREQ_MAX = 0.95;

export function Petals({ count }: Props) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const petals = useMemo(() => {
    const rand = mulberry32(0xC4119E);
    return Array.from({ length: count }, () => ({
      x: (rand() - 0.5) * SPAWN_RADIUS * 2,
      y: SPAWN_HEIGHT_MIN + rand() * (SPAWN_HEIGHT_MAX - SPAWN_HEIGHT_MIN),
      z: (rand() - 0.5) * SPAWN_RADIUS * 2,
      rotX: rand() * Math.PI * 2,
      rotY: rand() * Math.PI * 2,
      rotZ: rand() * Math.PI * 2,
      fall: FALL_SPEED_MIN + rand() * (FALL_SPEED_MAX - FALL_SPEED_MIN),
      swingFreqX: SWING_FREQ_MIN + rand() * (SWING_FREQ_MAX - SWING_FREQ_MIN),
      swingFreqZ: SWING_FREQ_MIN + rand() * (SWING_FREQ_MAX - SWING_FREQ_MIN),
      swingPhaseX: rand() * Math.PI * 2,
      swingPhaseZ: rand() * Math.PI * 2,
      rotSpeed: 0.4 + rand() * 1.1,
      scale: 0.55 + rand() * 0.6,
      // Pinks: hot blush → pale cream. Lightness biased high so they
      // pop against the warm fog without going neon.
      color: new THREE.Color().setHSL(
        0.96 + rand() * 0.04,
        0.45 + rand() * 0.35,
        0.78 + rand() * 0.12,
      ),
    }));
  }, [count]);

  const dummy = useMemo(() => new THREE.Object3D(), []);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    petals.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(p.rotX, p.rotY, p.rotZ);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, p.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [petals, dummy]);

  useFrame((state, dt) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const clampedDt = Math.min(dt, 0.05);
    const t = state.clock.elapsedTime;
    petals.forEach((p, i) => {
      p.y -= p.fall * clampedDt;
      // Horizontal swing — independent x/z freqs decorrelate motion
      // so the canopy doesn't look like a marching grid.
      const swayX = Math.sin(t * p.swingFreqX + p.swingPhaseX) * SWING_AMP;
      const swayZ = Math.cos(t * p.swingFreqZ + p.swingPhaseZ) * SWING_AMP * 0.7;
      p.rotX += p.rotSpeed * clampedDt;
      p.rotZ += p.rotSpeed * 0.6 * clampedDt;
      if (p.y < -0.4) {
        // Respawn at canopy. New x/z so distribution stays even.
        p.x = (Math.random() - 0.5) * SPAWN_RADIUS * 2;
        p.z = (Math.random() - 0.5) * SPAWN_RADIUS * 2;
        p.y = SPAWN_HEIGHT_MIN + Math.random() * (SPAWN_HEIGHT_MAX - SPAWN_HEIGHT_MIN);
      }
      dummy.position.set(p.x + swayX, p.y, p.z + swayZ);
      dummy.rotation.set(p.rotX, p.rotY, p.rotZ);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, count]}
      frustumCulled={false}
    >
      {/* Tiny double-sided plane reads as a petal at this distance.
          Real petal shape is overkill — silhouette doesn't survive
          past 2 units. */}
      <planeGeometry args={[0.13, 0.07]} />
      <meshStandardMaterial
        color="#ffffff"
        roughness={0.85}
        metalness={0}
        side={THREE.DoubleSide}
        transparent
        opacity={0.92}
      />
    </instancedMesh>
  );
}
