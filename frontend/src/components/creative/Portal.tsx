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
//
// THERE IS NO SHAFT. A drawn black box read as a black rectangular PRISM
// sitting in the floor — an object, not an absence. The opening is
// genuinely open: you see straight through to the sky under the island,
// and updraft wisps blow up through the gap. That sells "the floor is
// missing here" in a way a dark fill never could, and the jump-in falls
// through real air, with the veil doing the darkening.
//
// The lip walls are the ONLY thing below the floor line, and they match
// the tile slab's actual thickness. When they were deeper than the floor
// they hung into the open space and the hole read as a shallow crate.

const toon = getToonGradient();

const TILE = 2.0;
const HOLE = TILE * 0.99;   // hole spans the missing tile exactly
// TileFloor draws each tile as a TILE_HEIGHT=0.10 slab centred at
// Y_OFFSET=0.05, so the floor occupies y 0.00→0.10. The cut edge has to
// match that, plus a hair of overhang to cover the tiles' ±0.02 yJitter
// and stop a hairline gap opening at the rim.
const LIP_HEIGHT = 0.16;
const LIP_CENTER_Y = 0.05;

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
      {/* The updraft — what you see in the gap instead of a dark fill. */}
      <WindGusts originX={x} originZ={z} near={hot || near} />

      {/* Cut edge — four short walls at the lip so the floor has real
          thickness where it's been broken through. Sized to the tile slab:
          any deeper and they hang into the open space below and the hole
          reads as a shallow crate instead of an opening. */}
      {([[0, 1], [0, -1], [1, 0], [-1, 0]] as const).map(([ox, oz], i) => (
        <mesh
          key={i}
          position={[(ox * HOLE) / 2, LIP_CENTER_Y, (oz * HOLE) / 2]}
          rotation={[0, ox !== 0 ? Math.PI / 2 : 0, 0]}
        >
          <planeGeometry args={[HOLE, LIP_HEIGHT]} />
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

// ── the updraft ─────────────────────────────────────────────────────
//
// Air rushing UP out of the opening. It does the job the black fill was
// doing badly: it implies depth and pressure below without drawing a
// solid object. Wisps spawn under the lip (so the floor occludes them
// until they're framed by the hole) and dissolve above head height.
//
// Cool near-white on NORMAL blending, not additive: through the gap you
// see the sky dome's below-horizon band, which is already a bright peach,
// and additive white on a bright background is invisible. A cool tint is
// the only thing that separates from warm peach.

const GUST_COUNT = 16;
const GUST_BOTTOM = -2.4;        // below the lip — floor hides the spawn
const GUST_TOP = 2.6;            // gone by the time it clears head height
const GUST_PERIOD = 3.2;         // seconds for one wisp, bottom → top
const GUST_PEAK_OPACITY = 0.30;
const GUST_NEAR_BOOST = 1.35;    // standing at the rim, the draft picks up

/** Soft vertical streak, dissolving at both ends and across its width.
 *  A bare plane reads as a stick; the alpha falloff is the whole trick.
 *  Module-level singleton — one canvas, not one per wisp. */
let _windTex: THREE.CanvasTexture | null | undefined;
function windTexture(): THREE.CanvasTexture | null {
  if (_windTex !== undefined) return _windTex;
  const w = 64;
  const h = 256;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) {
    _windTex = null;
    return null;
  }
  // Bright core, transparent edges.
  const across = g.createLinearGradient(0, 0, w, 0);
  across.addColorStop(0, "rgba(255,255,255,0)");
  across.addColorStop(0.5, "rgba(255,255,255,1)");
  across.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = across;
  g.fillRect(0, 0, w, h);
  // Then punch the ends out so the streak has no cut edge. Weighted so the
  // TAIL (bottom) lingers and the head thins — the shape of something
  // being drawn upward.
  g.globalCompositeOperation = "destination-in";
  const along = g.createLinearGradient(0, 0, 0, h);
  along.addColorStop(0, "rgba(0,0,0,0)");
  along.addColorStop(0.3, "rgba(0,0,0,0.55)");
  along.addColorStop(0.72, "rgba(0,0,0,1)");
  along.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = along;
  g.fillRect(0, 0, w, h);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  _windTex = t;
  return t;
}

type Wisp = {
  phase: number;
  speed: number;
  ox: number;
  oz: number;
  swayPhase: number;
  swayAmp: number;
  width: number;
  height: number;
  lean: number;
};

function WindGusts({
  originX,
  originZ,
  near,
}: {
  originX: number;
  originZ: number;
  near: boolean;
}) {
  const reduce = useReducedMotion();
  const tex = useMemo(() => windTexture(), []);
  const geo = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  const meshes = useRef<(THREE.Mesh | null)[]>([]);
  const gainRef = useRef(1);

  const wisps = useMemo<Wisp[]>(
    () =>
      Array.from({ length: GUST_COUNT }, (_, i) => ({
        // Evenly spread the phases so the stream never gaps, then jitter so
        // it doesn't read as a rotating carousel of identical wisps.
        phase: i / GUST_COUNT + Math.random() * 0.05,
        speed: 0.75 + Math.random() * 0.5,
        ox: (Math.random() - 0.5) * HOLE * 0.74,
        oz: (Math.random() - 0.5) * HOLE * 0.74,
        swayPhase: Math.random() * Math.PI * 2,
        swayAmp: 0.1 + Math.random() * 0.18,
        width: 0.1 + Math.random() * 0.13,
        height: 0.85 + Math.random() * 0.75,
        lean: (Math.random() - 0.5) * 0.3,
      })),
    [],
  );

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const now = performance.now() / 1000;

    // Ease the proximity boost rather than snapping it on. The draft keeps
    // blowing through the jump-in — you fall THROUGH the updraft, which is
    // the one moment the wisps get to be read close-up.
    const target = near ? GUST_NEAR_BOOST : 1;
    gainRef.current += (target - gainRef.current) * Math.min(1, dt * 6);
    const gain = gainRef.current;

    // Billboard yaw. The portal group is a pure translation, so subtracting
    // its origin gives the camera direction in local space — no inverse
    // matrix needed.
    const cam = state.camera.position;
    const yaw = Math.atan2(cam.x - originX, cam.z - originZ);

    // Gusts arrive in swells. A constant stream reads as a machine venting,
    // not as weather.
    const swell = reduce
      ? 0.55
      : 0.34 + 0.66 * Math.pow(0.5 + 0.5 * Math.sin(now * 0.55), 2);

    for (let i = 0; i < wisps.length; i++) {
      const m = meshes.current[i];
      if (!m) continue;
      const w = wisps[i];
      // Reduced motion: freeze the wisps in a static spread up the gap.
      const t = reduce ? (i + 0.5) / wisps.length : ((now / (GUST_PERIOD * w.speed)) + w.phase) % 1;
      const y = GUST_BOTTOM + (GUST_TOP - GUST_BOTTOM) * t;
      // Sway scales with t so wisps leave the gap straight and wander only
      // once they're clear of it.
      const sway = reduce ? 0 : Math.sin(now * 0.9 + w.swayPhase) * w.swayAmp * t;
      m.position.set(w.ox + sway, y, w.oz + sway * 0.55);
      // Euler XYZ: the Z lean is applied in the quad's own plane first, then
      // the Y billboard turns the whole thing to camera.
      m.rotation.set(0, yaw, w.lean + sway * 0.3);
      // Stretch as it climbs — air speeding up as it escapes the gap.
      m.scale.set(w.width, w.height * (0.65 + 0.75 * t), 1);
      const env = Math.pow(Math.sin(Math.PI * t), 1.35);
      (m.material as THREE.MeshBasicMaterial).opacity = GUST_PEAK_OPACITY * env * swell * gain;
    }
  });

  return (
    <group>
      {wisps.map((_, i) => (
        <mesh
          key={i}
          ref={(m) => {
            meshes.current[i] = m;
          }}
          geometry={geo}
          renderOrder={3}
        >
          <meshBasicMaterial
            map={tex ?? undefined}
            color="#EEF8FF"
            transparent
            opacity={0}
            depthWrite={false}
            fog={false}
            toneMapped={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
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
