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
const DEPTH = 12;           // deep enough that the sinking char recedes into black

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

  useFrame(() => {
    if (reduce) return;
    const now = performance.now();
    if (boardRef.current) {
      // Barely-there sway on the board — enough that it isn't dead still,
      // slow enough that it never competes with the hole for attention.
      boardRef.current.rotation.z = Math.sin(now / 1500) * 0.03;
    }
  });

  return (
    <group position={[x, 0, z]}>
      {/* Shaft — a box seen from the inside, unlit + fog-exempt. No separate
          bottom plane: it used to sit 0.02 above the box's own bottom face
          and the two z-fought pixel-by-pixel (the "constant flashing"). The
          box's back bottom face already bottoms it out in black. */}
      <mesh position={[0, -DEPTH / 2, 0]}>
        <boxGeometry args={[HOLE, DEPTH, HOLE]} />
        <meshBasicMaterial color="#07090D" side={THREE.BackSide} fog={false} />
      </mesh>

      {/* Cut edge — four short walls at the lip so the floor has real
          thickness where it's been broken through. */}
      {([[0, 1], [0, -1], [1, 0], [-1, 0]] as const).map(([ox, oz], i) => (
        <mesh
          key={i}
          position={[(ox * HOLE) / 2, -0.22, (oz * HOLE) / 2]}
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

      <Signpost boardRef={boardRef} lit={hot || near} />
    </group>
  );
}

// ── the sign ────────────────────────────────────────────────────────

/** Painted board — just the branding now ("WELCOME TO GOONI"). The controls
 *  + the choices moved into the welcome MODAL; the board only sells the
 *  place. Drawn to a canvas in the pixel font (Press Start 2P); re-draws
 *  once the web font resolves so it isn't a monospace fallback. */
function useSignTexture(): THREE.CanvasTexture | null {
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    let alive = true;
    document.fonts
      ?.load("32px 'Press Start 2P'")
      .then(() => alive && setFontReady(true))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return useMemo(() => {
    const w = 512;
    const h = 256;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    if (!g) return null;

    g.fillStyle = "#FBF4E2";
    g.fillRect(0, 0, w, h);

    g.textAlign = "center";
    g.textBaseline = "middle";
    const pixel = "'Press Start 2P', monospace";
    // "WELCOME TO" small, "GOONI" big — pixel caps, forest green with a soft
    // dark drop for a game-title read.
    g.fillStyle = "#3B6B4A";
    g.font = `20px ${pixel}`;
    g.fillText("WELCOME TO", w / 2, 92);
    g.fillStyle = "#2E7D57";
    g.font = `52px ${pixel}`;
    g.fillText("GOONI", w / 2, 158);

    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
    // fontReady in deps: redraw with the real pixel font once it loads.
  }, [fontReady]);
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
  // spawn so you read it head-on as you walk up. Scaled down — it teaches,
  // it shouldn't be the biggest object on screen.
  return (
    <group position={[1.75, 0, 1.5]} rotation={[0, -0.42, 0]} scale={0.66}>
      {/* Base stones, so the post is planted rather than stuck in. */}
      <mesh position={[0, 0.12, 0]} castShadow>
        <boxGeometry args={[0.56, 0.24, 0.56]} />
        <meshToonMaterial color="#7C7365" gradientMap={toon} />
      </mesh>
      {/* Timber post — chunky and square-cut, not a thin dowel. It stops
          just under the board's backing so the post NEVER crosses the
          lettering (which sits on the face plane above 2.48). This is the
          "pole covering the sign" fix — a lollipop silhouette. */}
      <mesh position={[0, 1.32, 0]} castShadow>
        <boxGeometry args={[0.24, 2.24, 0.24]} />
        <meshToonMaterial color="#8A6A44" gradientMap={toon} />
      </mesh>

      <group ref={boardRef} position={[0, 3.05, 0]}>
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
