import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

// Procedural cloud puffs drifting BELOW the sky island. Each "cloud" is a
// cluster of overlapping LOW-POLY icosahedra (flat-shaded, faceted) so they
// match the faceted pedestal/poster clouds instead of reading as a separate
// smooth-sphere family. Visible when looking over the island edge.

const COUNT = 7;
const PUFFS_PER_CLOUD = 8;
const TOTAL = COUNT * PUFFS_PER_CLOUD;
const DRIFT_SPEED = 0.06;          // units/sec, slow paper-mario drift
const FIELD_RADIUS = 70;
const Y_MIN = -14;
const Y_MAX = -5;

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

type Puff = {
  ox: number; oy: number; oz: number;
  cx: number; cy: number; cz: number;
  scale: number;
};

export function Clouds() {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const puffs = useMemo<Puff[]>(() => {
    const rand = mulberry32(0xc10ad55);
    const out: Puff[] = [];
    for (let i = 0; i < COUNT; i++) {
      const cx = (rand() - 0.5) * FIELD_RADIUS * 2;
      const cy = Y_MIN + rand() * (Y_MAX - Y_MIN);
      const cz = (rand() - 0.5) * FIELD_RADIUS * 2;
      for (let j = 0; j < PUFFS_PER_CLOUD; j++) {
        // Flat-ish base: first puff sits at center, others have lateral
        // spread and slight upward bias.
        const flatBase = j === 0 ? 0 : -0.3 + rand() * 1.0;
        const ox = (rand() - 0.5) * 5.5;
        const oy = flatBase;
        const oz = (rand() - 0.5) * 5.5;
        const scale = 1.8 + rand() * 2.0;
        out.push({ ox, oy, oz, cx, cy, cz, scale });
      }
    }
    return out;
  }, []);

  const dummy = useMemo(() => new THREE.Object3D(), []);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    puffs.forEach((p, i) => {
      dummy.position.set(p.cx + p.ox, p.cy + p.oy, p.cz + p.oz);
      dummy.scale.set(p.scale, p.scale * 0.6, p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [puffs, dummy]);

  useFrame((_, rawDt) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dt = Math.min(rawDt, 0.05);
    puffs.forEach((p, i) => {
      p.cz += DRIFT_SPEED * dt;
      if (p.cz > FIELD_RADIUS) p.cz -= FIELD_RADIUS * 2;
      dummy.position.set(p.cx + p.ox, p.cy + p.oy, p.cz + p.oz);
      dummy.scale.set(p.scale, p.scale * 0.6, p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, TOTAL]} castShadow={false}>
      <icosahedronGeometry args={[1, 0]} />
      <meshStandardMaterial
        color="#ffffff"
        flatShading
        roughness={1}
        emissive="#eef2f6"
        emissiveIntensity={0.45}
        transparent
        opacity={0.95}
        depthWrite={false}
        fog={false}
      />
    </instancedMesh>
  );
}
