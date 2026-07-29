import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { getToonGradient } from "./toonGradient";
import { subscribeLandings } from "./useDanielControls";
import { PORTAL_TILE } from "./tileGrid";
import { useReducedMotion } from "./useReducedMotion";

// The hole, and the sign that tells you to jump in it.
//
// The plaza is the front door — familiar, playable, nothing to read.
// This is the one thing in it that promises somewhere else.
//
// SQUARE, not round: the floor is a square grid, so a circular pit
// reads as a decal dropped on top of the tiles. A square opening the
// exact size of one tile reads as a tile that is missing, which is the
// actual fiction.
//
// The sign is deliberately old — thick timber, painted board, fat
// outlined lettering. It's the one object allowed to look like a game
// prop, because it's the only thing in the scene giving an instruction.

const toon = getToonGradient();

const TILE = 2.0;
const HOLE = TILE * 0.99;   // hole spans the missing tile exactly
const DEPTH = 7;

type Props = {
  /** Fires when the player lands on the hole. */
  onEnter: () => void;
  /** False while a transition is already running. */
  armed: boolean;
  /** True when the player is standing next to the hole — the sign and
   *  the rim brighten so it's obvious what the prompt refers to. */
  near?: boolean;
};

export function Portal({ onEnter, armed, near = false }: Props) {
  const x = PORTAL_TILE.gx * TILE;
  const z = PORTAL_TILE.gz * TILE;
  const reduce = useReducedMotion();
  const [hot, setHot] = useState(false);

  const ringsRef = useRef<THREE.Group>(null);
  const boardRef = useRef<THREE.Group>(null);
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

  const rings = useMemo(() => [0, 0.34, 0.67], []);

  useFrame(() => {
    if (reduce) return;
    const now = performance.now();
    const g = ringsRef.current;
    if (g) {
      g.children.forEach((child, i) => {
        const m = child as THREE.Mesh;
        const t = (now / 2400 + rings[i]) % 1;
        m.position.y = -t * (DEPTH - 1.5);
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.sin(t * Math.PI) * 0.42;
        const s = 1 - t * 0.3;
        m.scale.set(s, 1, s);
      });
    }
    if (boardRef.current) {
      // Gentle sway on the hanging board — the sign is the thing you're
      // meant to notice, and stillness is invisible in a scene that
      // already has clouds moving.
      boardRef.current.rotation.z = Math.sin(now / 1100) * 0.045;
    }
  });

  return (
    <group position={[x, 0, z]}>
      {/* Shaft — a box seen from the inside. */}
      <mesh position={[0, -DEPTH / 2, 0]}>
        <boxGeometry args={[HOLE, DEPTH, HOLE]} />
        <meshBasicMaterial color="#0A0C10" side={THREE.BackSide} />
      </mesh>
      {/* Bottom, unlit, so the shaft bottoms out in black rather than
          showing a floor. */}
      <mesh position={[0, -DEPTH + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[HOLE, HOLE]} />
        <meshBasicMaterial color="#04060A" />
      </mesh>

      {/* Cut edge — four short walls at the lip so the floor has real
          thickness where it's been broken through. */}
      {([[0, 1], [0, -1], [1, 0], [-1, 0]] as const).map(([ox, oz], i) => (
        <mesh
          key={i}
          position={[(ox * HOLE) / 2, -0.12, (oz * HOLE) / 2]}
          rotation={[0, ox !== 0 ? Math.PI / 2 : 0, 0]}
        >
          <planeGeometry args={[HOLE, 0.44]} />
          <meshToonMaterial
            color={hot || near ? "#B9A98C" : "#8C8272"}
            gradientMap={toon}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}

      <group ref={ringsRef}>
        {rings.map((_, i) => (
          <mesh key={i} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[HOLE * 0.34, HOLE * 0.44, 4]} />
            <meshBasicMaterial color="#8FE9BE" transparent opacity={0.4} depthWrite={false} />
          </mesh>
        ))}
      </group>

      <Signpost boardRef={boardRef} lit={hot || near} />
    </group>
  );
}

// ── the sign ────────────────────────────────────────────────────────

/** Painted board, drawn to a canvas. Text as geometry would need a font
 *  asset and text as separate meshes can't say a word — a texture is
 *  the only way to get real lettering with no dependency. */
function useSignTexture(): THREE.CanvasTexture | null {
  return useMemo(() => {
    const w = 512;
    const h = 256;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    if (!g) return null;

    g.fillStyle = "#F6E7C4";
    g.fillRect(0, 0, w, h);
    // Inner border, the way a painted trail sign has a routed edge.
    g.strokeStyle = "#6B4E2E";
    g.lineWidth = 12;
    g.strokeRect(16, 16, w - 32, h - 32);

    g.textAlign = "center";
    g.textBaseline = "middle";
    // Fat outlined lettering — outline first, fill on top, which is how
    // the era's sprite text got its readability at low resolution.
    g.font = "bold 92px Georgia, 'Iowan Old Style', serif";
    g.lineWidth = 14;
    g.strokeStyle = "#3B2A16";
    g.strokeText("JUMP IN", w / 2, h / 2 - 22);
    g.fillStyle = "#2E7D57";
    g.fillText("JUMP IN", w / 2, h / 2 - 22);

    g.font = "bold 34px Georgia, 'Iowan Old Style', serif";
    g.lineWidth = 7;
    g.strokeStyle = "#3B2A16";
    g.strokeText("▼  the way down  ▼", w / 2, h / 2 + 58);
    g.fillStyle = "#6B4E2E";
    g.fillText("▼  the way down  ▼", w / 2, h / 2 + 58);

    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, []);
}

function Signpost({
  boardRef,
  lit,
}: {
  boardRef: React.RefObject<THREE.Group>;
  lit: boolean;
}) {
  const tex = useSignTexture();

  // Stands on the near-right corner of the hole, angled back toward
  // spawn so you read it head-on as you walk up.
  return (
    <group position={[1.75, 0, 1.5]} rotation={[0, -0.42, 0]}>
      {/* Timber post — chunky and square-cut, not a thin dowel. */}
      <mesh position={[0, 1.05, 0]} castShadow>
        <boxGeometry args={[0.22, 2.1, 0.22]} />
        <meshToonMaterial color="#8A6A44" gradientMap={toon} />
      </mesh>
      {/* Base stones, so the post is planted rather than stuck in. */}
      <mesh position={[0, 0.12, 0]} castShadow>
        <boxGeometry args={[0.52, 0.24, 0.52]} />
        <meshToonMaterial color="#7C7365" gradientMap={toon} />
      </mesh>

      <group ref={boardRef} position={[0, 2.28, 0]}>
        {/* Dark backing slightly larger than the face — reads as the
            board's edge and gives the lettering a hard outline. */}
        <mesh position={[0, 0, -0.05]} castShadow>
          <boxGeometry args={[2.5, 1.32, 0.12]} />
          <meshToonMaterial color="#5A3F24" gradientMap={toon} />
        </mesh>
        <mesh position={[0, 0, 0.03]}>
          <planeGeometry args={[2.3, 1.15]} />
          {tex ? (
            <meshBasicMaterial map={tex} toneMapped={false} />
          ) : (
            <meshBasicMaterial color="#F6E7C4" />
          )}
        </mesh>
        {/* Warm wash when the player is close enough for the prompt to
            be live. */}
        {lit && (
          <mesh position={[0, 0, 0.05]}>
            <planeGeometry args={[2.3, 1.15]} />
            <meshBasicMaterial color="#FFF0B8" transparent opacity={0.16} depthWrite={false} />
          </mesh>
        )}
      </group>
    </group>
  );
}
