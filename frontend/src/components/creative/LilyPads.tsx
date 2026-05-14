import { useMemo } from "react";
import { Instance, Instances } from "@react-three/drei";
import * as THREE from "three";

type Props = { count: number };

// Deterministic pseudo-random so the layout is stable across reloads.
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

// Single-geometry single-draw-call lily pads scattered on a ring around
// the origin. Slight Y-jitter + per-pad random rotation breaks the grid.
export function LilyPads({ count }: Props) {
  const placements = useMemo(() => {
    const rand = mulberry32(0x1117_4d);
    const out: { pos: [number, number, number]; rot: number; scale: number }[] = [];
    for (let i = 0; i < count; i++) {
      // Distribute on a ring from r=6..40 — clears the spawn area for the boat.
      const angle = rand() * Math.PI * 2;
      const radius = 6 + rand() * 34;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const y = 0.02 + rand() * 0.02; // tiny float above the water
      out.push({
        pos: [x, y, z],
        rot: rand() * Math.PI * 2,
        scale: 0.7 + rand() * 0.7,
      });
    }
    return out;
  }, [count]);

  return (
    <Instances limit={count} castShadow={false} receiveShadow>
      {/* Wide flat disc — reads as a lily pad from above the water. */}
      <circleGeometry args={[0.55, 16]} />
      <meshStandardMaterial
        color="#3f7a4a"
        roughness={0.85}
        metalness={0.05}
        side={THREE.DoubleSide}
      />
      {placements.map((p, i) => (
        <Instance
          key={i}
          position={p.pos}
          rotation={[-Math.PI / 2, 0, p.rot]}
          scale={p.scale}
        />
      ))}
    </Instances>
  );
}
