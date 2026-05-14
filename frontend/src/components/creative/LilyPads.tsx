import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

type Props = { count: number };

// Deterministic PRNG so the pad layout is stable across reloads.
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

// Single ShapeGeometry w/ a wedge slit — the classic lily-pad silhouette.
// Built once + reused for every instance.
function makeLilyPadGeometry(): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  const r = 1;
  const slitHalf = Math.PI * 0.09; // ~16° wedge
  shape.moveTo(0, 0);
  shape.lineTo(Math.cos(-slitHalf) * r, Math.sin(-slitHalf) * r);
  shape.absarc(0, 0, r, -slitHalf, Math.PI * 2 - slitHalf, false);
  shape.lineTo(0, 0);
  const geo = new THREE.ShapeGeometry(shape, 24);
  // Center the pivot so per-instance rotation spins around the disc center.
  geo.computeBoundingBox();
  return geo;
}

export function LilyPads({ count }: Props) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(makeLilyPadGeometry, []);

  // Pre-compute per-instance transforms + a per-instance phase so each
  // pad bobs on its own cycle (not lock-step like a marching band).
  const placements = useMemo(() => {
    const rand = mulberry32(0x1117_4d);
    const out: {
      x: number;
      z: number;
      baseY: number;
      yaw: number;
      scale: number;
      bobPhase: number;
      bobAmp: number;
      color: THREE.Color;
    }[] = [];
    for (let i = 0; i < count; i++) {
      // Ring r=6..40 keeps the spawn zone clear for the boat.
      const angle = rand() * Math.PI * 2;
      const radius = 6 + rand() * 34;
      // Mild hue jitter in HSL so pads read as a population, not clones.
      const c = new THREE.Color().setHSL(
        0.31 + rand() * 0.06,            // green band
        0.45 + rand() * 0.18,
        0.28 + rand() * 0.08,
      );
      out.push({
        x: Math.cos(angle) * radius,
        z: Math.sin(angle) * radius,
        baseY: 0.025 + rand() * 0.015,
        yaw: rand() * Math.PI * 2,
        scale: 0.55 + rand() * 0.7,
        bobPhase: rand() * Math.PI * 2,
        bobAmp: 0.02 + rand() * 0.025,
        color: c,
      });
    }
    return out;
  }, [count]);

  // Set initial transforms + per-instance colors once on mount.
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    placements.forEach((p, i) => {
      dummy.position.set(p.x, p.baseY, p.z);
      dummy.rotation.set(-Math.PI / 2, 0, p.yaw);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, p.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [placements]);

  // Per-frame bob: each pad oscillates Y around its baseY with its own
  // phase. Yaw drifts very slowly so the pond reads "alive" rather
  // than "screenshot."
  const dummy = useMemo(() => new THREE.Object3D(), []);
  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const t = state.clock.elapsedTime;
    placements.forEach((p, i) => {
      const y = p.baseY + Math.sin(t * 0.9 + p.bobPhase) * p.bobAmp;
      const yawDrift = p.yaw + Math.sin(t * 0.18 + p.bobPhase) * 0.04;
      dummy.position.set(p.x, y, p.z);
      dummy.rotation.set(-Math.PI / 2, 0, yawDrift);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, undefined, count]}
      castShadow={false}
      receiveShadow
    >
      <meshStandardMaterial
        // Per-instance color modulates this base (multiplied in shader).
        color="#ffffff"
        roughness={0.7}
        metalness={0.02}
        side={THREE.DoubleSide}
      />
    </instancedMesh>
  );
}
