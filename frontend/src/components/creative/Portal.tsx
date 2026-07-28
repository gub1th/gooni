import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { getToonGradient } from "./toonGradient";
import { subscribeLandings } from "./useDanielControls";
import { useReducedMotion } from "./useReducedMotion";

// The hole.
//
// The plaza is the front door — familiar, playable, no reading required.
// This is the one thing in it that promises somewhere else: an opening
// in the floor directly ahead of spawn, with a sign leaning over it.
// Land on it and you fall into the walk.
//
// It has to out-signal everything else in the scene without being loud,
// so it works on three channels at once: a shape that reads as absence
// (a dark shaft where floor should be), motion nothing else has (a slow
// descending pulse), and language (an arrow that literally points down).

const toon = getToonGradient();

/** Grid tile the hole occupies — dead ahead of spawn, two hops north,
 *  close enough to find immediately and far enough that you don't fall
 *  in before you've looked around. */
export const PORTAL_TILE = { gx: 0, gz: -2 };
const TILE = 2.0;

type Props = {
  /** Fires once when the player lands on the hole. */
  onEnter: () => void;
  /** Suppresses the trigger while a transition is already running. */
  armed: boolean;
};

export function Portal({ onEnter, armed }: Props) {
  const x = PORTAL_TILE.gx * TILE;
  const z = PORTAL_TILE.gz * TILE;
  const reduce = useReducedMotion();
  const [hot, setHot] = useState(false);

  const ringsRef = useRef<THREE.Group>(null);
  const signRef = useRef<THREE.Group>(null);
  const armedRef = useRef(armed);
  useEffect(() => {
    armedRef.current = armed;
  }, [armed]);

  useEffect(() => {
    return subscribeLandings((e) => {
      if (e.actor !== "player") return;
      const on = e.gx === PORTAL_TILE.gx && e.gz === PORTAL_TILE.gz;
      setHot(on);
      if (on && armedRef.current) onEnter();
    });
  }, [onEnter]);

  // Three rings descending on a loop — the only downward motion in the
  // plaza, which is what makes the hole read as "down" rather than as a
  // dark tile.
  const rings = useMemo(() => [0, 0.33, 0.66], []);

  useFrame(() => {
    if (reduce) return;
    const g = ringsRef.current;
    if (g) {
      g.children.forEach((child, i) => {
        const m = child as THREE.Mesh;
        const t = ((performance.now() / 2600 + rings[i]) % 1);
        m.position.y = -t * 3.4;
        const mat = m.material as THREE.MeshBasicMaterial;
        // Fade in at the lip, out in the dark — a ring popping in at
        // full strength would read as a glitch.
        mat.opacity = Math.sin(t * Math.PI) * 0.5;
        const s = 1 - t * 0.35;
        m.scale.set(s, s, s);
      });
    }
    if (signRef.current) {
      signRef.current.position.y = 2.5 + Math.sin(performance.now() / 900) * 0.07;
    }
  });

  return (
    <group position={[x, 0, z]}>
      {/* Shaft. Open-ended cylinder with the inside faces showing, so
          you see down it rather than at it. */}
      <mesh position={[0, -1.8, 0]}>
        <cylinderGeometry args={[0.94, 0.7, 3.6, 24, 1, true]} />
        <meshBasicMaterial color="#0B0D10" side={THREE.BackSide} />
      </mesh>
      {/* Floor of the shaft — pure black, no shading, so it reads as
          depth rather than as a surface. */}
      <mesh position={[0, -3.5, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.72, 24]} />
        <meshBasicMaterial color="#05070A" />
      </mesh>

      {/* Rim — the cut edge of the floor. */}
      <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.94, 1.12, 32]} />
        <meshToonMaterial color={hot ? "#9FE1CB" : "#8C8272"} gradientMap={toon} side={THREE.DoubleSide} />
      </mesh>

      <group ref={ringsRef}>
        {rings.map((_, i) => (
          <mesh key={i} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.62, 0.76, 28]} />
            <meshBasicMaterial color="#7DE8B4" transparent opacity={0.4} depthWrite={false} />
          </mesh>
        ))}
      </group>

      {/* Light spilling up out of the hole. */}
      <mesh position={[0, 0.9, 0]}>
        <cylinderGeometry args={[0.8, 0.94, 1.8, 20, 1, true]} />
        <meshBasicMaterial
          color="#7DE8B4"
          transparent
          opacity={hot ? 0.16 : 0.09}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      <ArrowSign boardRef={signRef} />
    </group>
  );
}

// Post with a board and a down-arrow. Language is the third channel:
// shape says absence, motion says down, and this says it in words.
function ArrowSign({ boardRef }: { boardRef: React.RefObject<THREE.Group> }) {
  return (
      <group position={[1.55, 0, 0.5]} rotation={[0, -0.55, 0]}>
        <mesh position={[0, 1.25, 0]} castShadow>
          <cylinderGeometry args={[0.075, 0.095, 2.5, 8]} />
          <meshToonMaterial color="#6B5B45" gradientMap={toon} />
        </mesh>
        <group ref={boardRef} position={[0, 2.5, 0]}>
          <mesh castShadow>
            <boxGeometry args={[1.35, 0.62, 0.08]} />
            <meshToonMaterial color="#F2EBDA" gradientMap={toon} />
          </mesh>
          {/* Arrow, pointing down at the hole. Shaft + head as two
              meshes rather than a texture so it stays crisp at any
              distance and needs no asset. */}
          <mesh position={[-0.42, -0.02, 0.055]}>
            <boxGeometry args={[0.09, 0.3, 0.02]} />
            <meshBasicMaterial color="#1D9E75" />
          </mesh>
          <mesh position={[-0.42, -0.26, 0.055]} rotation={[0, 0, Math.PI]}>
            <coneGeometry args={[0.15, 0.22, 3]} />
            <meshBasicMaterial color="#1D9E75" />
          </mesh>
          <mesh position={[0.22, 0.11, 0.055]}>
            <boxGeometry args={[0.72, 0.075, 0.02]} />
            <meshBasicMaterial color="#3C3A34" />
          </mesh>
          <mesh position={[0.13, -0.05, 0.055]}>
            <boxGeometry args={[0.54, 0.06, 0.02]} />
            <meshBasicMaterial color="#6E6A60" />
          </mesh>
          <mesh position={[0.16, -0.19, 0.055]}>
            <boxGeometry args={[0.6, 0.06, 0.02]} />
            <meshBasicMaterial color="#6E6A60" />
          </mesh>
        </group>
      </group>
  );
}
