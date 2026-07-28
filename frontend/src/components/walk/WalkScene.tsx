import { Suspense, useLayoutEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { AdaptiveDpr } from "@react-three/drei";
import * as THREE from "three";
import { SkyDome } from "../creative/SkyDome";
import { Clouds } from "../creative/Clouds";
import { Atmosphere } from "../creative/Atmosphere";
import { GLTFGooni, type GooniHandle } from "../creative/GLTFGooni";
import { getToonGradient } from "../creative/toonGradient";
import { STATIONS } from "../../content/walk";
import { getScroll } from "./scrollBus";

// The 3D backdrop for the walk.
//
// It is a BACKDROP, not a toy: pointer-events are off, there are no
// controls, and nothing here is required to understand the page. The
// DOM sections above carry every word. If WebGL is unavailable this
// component simply never mounts and the page is still complete — which
// is the whole reason the text and the world could be merged into one
// surface instead of two.
//
// Scroll drives everything. Progress 0→1 walks Gooni down a causeway
// past one marker per station; the camera trails behind at a fixed
// offset. Prop density thins out along the way, so the world visibly
// declutters as the story moves from four-abandoned-attempts to the
// one thing that survived.

// Module-level, matching TileFloor: the gradient ramp is shared by every
// toon surface here and rebuilding it per component is wasted work.
const causewayGradient = getToonGradient();

const TILE = 2.0;
const SPACING = 15;                                  // world units between stations
const LENGTH = (STATIONS.length - 1) * SPACING + 26; // causeway length
const HALF_WIDTH = 2;                                // tiles either side of centre

export function WalkScene() {
  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
      }}
    >
      <Canvas
        dpr={[1, 1.75]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        camera={{ fov: 42, near: 0.1, far: 400, position: [0, 6, 12] }}
      >
        <AdaptiveDpr pixelated />
        <SkyDome />
        <Atmosphere mobile={false} />
        <Clouds />
        <Causeway />
        <Markers />
        <Suspense fallback={null}>
          <Walker />
        </Suspense>
        <Rig />
      </Canvas>
    </div>
  );
}

/** Z of a given progress value. Negative = further along the walk. */
function zAt(progress: number): number {
  return -progress * LENGTH;
}

/** Z of a station index. */
function stationZ(i: number): number {
  return -(i * SPACING + 8);
}

// ── ground ──────────────────────────────────────────────────────────

// Warm beiges, matching the plaza's floor so the causeway reads as the
// same world rather than a second one.
const PAVING = [
  new THREE.Color("#f4ead7"),
  new THREE.Color("#ecdcb8"),
  new THREE.Color("#e8d5b0"),
  new THREE.Color("#e9dcc1"),
  new THREE.Color("#dccba6"),
];

const TILE_VISIBLE = TILE * 0.97;
const TILE_HEIGHT = 0.5;

function Causeway() {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const tiles = useMemo(() => {
    const out: { x: number; y: number; z: number; color: THREE.Color }[] = [];
    const rows = Math.ceil(LENGTH / TILE) + 8;
    for (let r = 0; r < rows; r++) {
      const z = 8 - r * TILE;
      for (let c = -HALF_WIDTH; c <= HALF_WIDTH; c++) {
        // Ragged outer columns so the road reads as a worn path rather
        // than an extruded rectangle.
        if (Math.abs(c) === HALF_WIDTH && pseudo(c * 31 + r * 17) > 0.62) continue;
        const h = Math.abs(c * 37 + r * 71 + c * r * 13) & 0xff;
        const jitter = ((h >> 4) / 255 - 0.5) * 0.05;
        out.push({
          x: c * TILE,
          // ±0.02 height jitter — the plaza does this too, and it's what
          // stops a flat field of tiles reading as one printed sheet.
          y: (((h >> 2) & 0xff) / 255 - 0.5) * 0.05,
          z,
          color: PAVING[h % PAVING.length].clone().offsetHSL(0, 0, jitter),
        });
      }
    }
    return out;
  }, []);

  // Same idiom as TileFloor: layout effect (the ref must exist), an
  // Object3D dummy for the matrix, and setColorAt per instance.
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    tiles.forEach((t, i) => {
      dummy.position.set(t.x, t.y, t.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, t.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [tiles]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, tiles.length]}
      receiveShadow
      castShadow={false}
    >
      <boxGeometry args={[TILE_VISIBLE, TILE_HEIGHT, TILE_VISIBLE]} />
      <meshToonMaterial color="#ffffff" gradientMap={causewayGradient} />
    </instancedMesh>
  );
}

// ── station markers ─────────────────────────────────────────────────

function Markers() {
  const grad = useMemo(() => getToonGradient(), []);
  return (
    <group>
      {STATIONS.map((s, i) => (
        <Marker key={s.id} index={i} color={s.color} density={s.density} grad={grad} />
      ))}
    </group>
  );
}

function Marker({
  index,
  color,
  density,
  grad,
}: {
  index: number;
  color: string;
  density: number;
  grad: THREE.Texture;
}) {
  const ringRef = useRef<THREE.Mesh>(null);
  const z = stationZ(index);

  useFrame((_, dt) => {
    if (ringRef.current) ringRef.current.rotation.y += dt * 0.35;
  });

  // Markers stand just off the road so the walker passes them rather
  // than colliding with them — you move *through* the story, never
  // around it.
  const side = index % 2 === 0 ? 1 : -1;
  const x = side * (HALF_WIDTH * TILE + 1.6);
  const height = 2.2 + (1 - density) * 2.4; // later stations stand taller

  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, height / 2, 0]} castShadow>
        <cylinderGeometry args={[0.16, 0.3, height, 4]} />
        <meshToonMaterial color="#6E6455" emissive={color} emissiveIntensity={0.12} gradientMap={grad} />
      </mesh>
      <mesh position={[0, height + 0.28, 0]}>
        <octahedronGeometry args={[0.3, 0]} />
        <meshToonMaterial color={color} emissive={color} emissiveIntensity={0.5} gradientMap={grad} />
      </mesh>
      <mesh ref={ringRef} position={[0, height + 0.28, 0]} rotation={[Math.PI / 2.2, 0, 0]}>
        <torusGeometry args={[0.62, 0.028, 8, 36]} />
        <meshBasicMaterial color={color} transparent opacity={0.75} />
      </mesh>
      {/* Ground glow so the marker's colour reaches the road. */}
      <mesh position={[0, 0.2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.5, 24]} />
        <meshBasicMaterial color={color} transparent opacity={0.09} depthWrite={false} />
      </mesh>
    </group>
  );
}

// ── the walker ──────────────────────────────────────────────────────

function Walker() {
  const group = useRef<THREE.Group>(null);
  const gooni = useRef<GooniHandle>(null);
  const moving = useRef(false);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const g = group.current;
    if (!g) return;
    const { progress, velocity } = getScroll();

    // Ease toward the scroll target instead of snapping to it, so a
    // flung scrollbar reads as a sprint rather than a teleport.
    const targetZ = zAt(progress);
    g.position.z += (targetZ - g.position.z) * Math.min(1, dt * 4.5);
    g.position.y = 0.35;

    // Walk while the page is moving, idle when it settles. The
    // threshold is deliberately low — a slow reader still gets a
    // walking character rather than a twitching one.
    const wantMoving = Math.abs(velocity) > 0.25;
    if (wantMoving !== moving.current) {
      moving.current = wantMoving;
      gooni.current?.setClip(wantMoving ? "Walk" : "Idle", { loop: true, fadeMs: 180 });
    }
    // Face down the road, or back up it when scrolling against the grain.
    const facing = velocity < -0.25 ? Math.PI : 0;
    g.rotation.y += (facing - g.rotation.y) * Math.min(1, dt * 6);
  });

  return (
    <group ref={group} position={[0, 0.35, 0]}>
      <GLTFGooni ref={gooni} bodyColor="#4ADE80" accentColor="#3AAD6E" />
    </group>
  );
}

// ── camera ──────────────────────────────────────────────────────────

function Rig() {
  const look = useRef(new THREE.Vector3());

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const { progress } = getScroll();
    const z = zAt(progress);

    // Trailing three-quarter view. The camera drifts a little to the
    // side as you advance so the road never reads as a flat corridor,
    // and rises slightly so the far end of the walk stays visible.
    const sway = Math.sin(progress * Math.PI * 2) * 3.2;
    const target = new THREE.Vector3(sway, 5.4 + progress * 1.4, z + 11.5);
    state.camera.position.lerp(target, Math.min(1, dt * 2.2));

    look.current.lerp(new THREE.Vector3(0, 1.1, z - 3), Math.min(1, dt * 2.6));
    state.camera.lookAt(look.current);
  });

  return null;
}

/** Deterministic 0–1 from an integer. Keeps tile shading and edge
 *  raggedness identical across reloads without pulling in a PRNG. */
function pseudo(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}
