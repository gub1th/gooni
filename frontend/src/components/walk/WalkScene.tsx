import { Suspense, useLayoutEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { AdaptiveDpr } from "@react-three/drei";
import * as THREE from "three";
import { SkyDome } from "../creative/SkyDome";
import { Clouds } from "../creative/Clouds";
import { Atmosphere } from "../creative/Atmosphere";
import { GLTFGooni, type GooniHandle } from "../creative/GLTFGooni";
import { getToonGradient } from "../creative/toonGradient";
import { getIdentity } from "../creative/avatarIdentity";
import { useReducedMotion } from "../creative/useReducedMotion";
import { STATIONS } from "../../content/walk";
import { getScroll } from "./scrollBus";

// The 3D backdrop for the walk.
//
// It is a BACKDROP, not a toy: pointer-events are off, there are no
// controls, and nothing here is required to understand the page. The
// DOM sections carry every word. If WebGL is unavailable this component
// never mounts and the page is still complete — which is the whole
// reason the text and the world could merge into one surface.
//
// Scroll drives everything. Progress 0→1 walks Gooni down a causeway
// past one marker per station, camera trailing. Prop density is
// interpolated from the stations' own `density` values, so the world
// visibly declutters as the story moves from four-abandoned-attempts to
// the one thing that survived. That gradient is the argument; without
// it the road is just a road.

const toon = getToonGradient();

const TILE = 2.0;
const SPACING = 16;
const LENGTH = (STATIONS.length - 1) * SPACING + 30;
const HALF_WIDTH = 2;
const TILE_VISIBLE = TILE * 0.97;
const TILE_HEIGHT = 0.5;

/** Z of a progress value. Negative = further along. */
function zAt(progress: number): number {
  return -progress * LENGTH;
}
function stationZ(i: number): number {
  return -(i * SPACING + 10);
}

/** Density at an arbitrary z, lerped between station anchors. Drives
 *  how much clutter sits beside the road at that point. */
function densityAt(z: number): number {
  const first = STATIONS[0];
  const last = STATIONS[STATIONS.length - 1];
  if (z > stationZ(0)) return first.density;
  if (z < stationZ(STATIONS.length - 1)) return last.density;
  for (let i = 0; i < STATIONS.length - 1; i++) {
    const a = stationZ(i);
    const b = stationZ(i + 1);
    if (z <= a && z >= b) {
      const t = (a - z) / (a - b);
      return STATIONS[i].density + (STATIONS[i + 1].density - STATIONS[i].density) * t;
    }
  }
  return last.density;
}

export function WalkScene() {
  return (
    <div aria-hidden style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }}>
      <Canvas
        dpr={[1, 1.75]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        camera={{ fov: 40, near: 0.1, far: 500, position: [-5, 7, 14] }}
      >
        <AdaptiveDpr pixelated />
        <SkyDome />
        <Atmosphere mobile={false} />
        <Clouds />
        <Causeway />
        <Clutter />
        <Ghosts />
        <Scenery />
        <Markers />
        <Suspense fallback={null}>
          <Walker />
        </Suspense>
        <Rig />
      </Canvas>
    </div>
  );
}

// ── ground ──────────────────────────────────────────────────────────

const PAVING = [
  new THREE.Color("#f4ead7"),
  new THREE.Color("#ecdcb8"),
  new THREE.Color("#e8d5b0"),
  new THREE.Color("#e9dcc1"),
  new THREE.Color("#dccba6"),
];

function Causeway() {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const tiles = useMemo(() => {
    const out: { x: number; y: number; z: number; color: THREE.Color }[] = [];
    const rows = Math.ceil(LENGTH / TILE) + 10;
    for (let r = 0; r < rows; r++) {
      const z = 10 - r * TILE;
      for (let c = -HALF_WIDTH; c <= HALF_WIDTH; c++) {
        // Ragged outer columns so the road reads as a worn path, not an
        // extruded rectangle. The far end frays more — the world is
        // running out by then.
        const frayed = 0.62 - (1 - densityAt(z)) * 0.25;
        if (Math.abs(c) === HALF_WIDTH && pseudo(c * 31 + r * 17) > frayed) continue;
        const h = Math.abs(c * 37 + r * 71 + c * r * 13) & 0xff;
        out.push({
          x: c * TILE,
          y: (((h >> 2) & 0xff) / 255 - 0.5) * 0.05,
          z,
          color: PAVING[h % PAVING.length].clone().offsetHSL(0, 0, ((h >> 4) / 255 - 0.5) * 0.05),
        });
      }
    }
    return out;
  }, []);

  // Layout effect, not useMemo: useMemo runs during render, before the
  // ref attaches, so every matrix write would be silently dropped.
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
    <instancedMesh ref={meshRef} args={[undefined, undefined, tiles.length]} receiveShadow castShadow={false}>
      <boxGeometry args={[TILE_VISIBLE, TILE_HEIGHT, TILE_VISIBLE]} />
      <meshToonMaterial color="#ffffff" gradientMap={toon} />
    </instancedMesh>
  );
}

// ── clutter: the density gradient made physical ─────────────────────

function Clutter() {
  const items = useMemo(() => {
    const out: {
      x: number; y: number; z: number; s: number; rot: number;
      kind: "rock" | "shroom"; color: string;
    }[] = [];
    // Walk the road and roll for props. Sampled sparsely and pushed
    // well clear of the shoulder — the first pass scattered something
    // every 1.5 units right against the road and read as visual noise
    // rather than as density. Clutter has to be legible as "there is a
    // lot here" at a glance; past that it's just mess.
    for (let z = 12; z > -LENGTH; z -= 4) {
      const d = densityAt(z);
      for (let side = -1; side <= 1; side += 2) {
        if (pseudo(z * 3.7 + side * 91) > d * 0.4) continue;
        // Start 3.5 units off the shoulder so nothing crowds the walker.
        const off = HALF_WIDTH * TILE + 3.5 + pseudo(z * 5.1 + side) * 6;
        const isRock = pseudo(z * 11.3 + side * 17) < 0.62;
        out.push({
          x: side * off,
          y: 0,
          z: z + pseudo(z * 2.2) * 2,
          s: 0.45 + pseudo(z * 7.7 + side) * 0.6,
          rot: pseudo(z * 13.1) * Math.PI * 2,
          // Two prop types, not three. The cone "shards" read as debris
          // and made the roadside look like a landfill.
          kind: isRock ? "rock" : "shroom",
          color: isRock ? "#7C7365" : "#D8D2C4",
        });
      }
    }
    return out;
  }, []);

  return (
    <group>
      {items.map((it, i) => (
        <group key={i} position={[it.x, it.y, it.z]} rotation={[0, it.rot, 0]} scale={it.s}>
          {it.kind === "rock" && (
            <mesh position={[0, 0.3, 0]} castShadow>
              <dodecahedronGeometry args={[0.5, 0]} />
              <meshToonMaterial color={it.color} gradientMap={toon} />
            </mesh>
          )}
          {it.kind === "shroom" && (
            <group>
              <mesh position={[0, 0.28, 0]}>
                <cylinderGeometry args={[0.09, 0.12, 0.56, 7]} />
                <meshToonMaterial color="#E8E2D4" gradientMap={toon} />
              </mesh>
              <mesh position={[0, 0.62, 0]}>
                <sphereGeometry args={[0.26, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
                <meshToonMaterial color={it.color} gradientMap={toon} />
              </mesh>
            </group>
          )}
        </group>
      ))}
    </group>
  );
}

// ── the three earlier attempts ──────────────────────────────────────

// Faded shells of the same silhouette the Gooni marker takes at the far
// end, standing before the road proper. You clock the rhyme without
// being told what they are.
function Ghosts() {
  const names = ["life_ai", "flow", "lucid"];
  return (
    <group>
      {names.map((n, i) => (
        <group key={n} position={[(i % 2 === 0 ? -1 : 1) * (5 + i * 1.4), 0, 6 - i * 5]}>
          <mesh position={[0, 1.1, 0]}>
            <cylinderGeometry args={[0.14, 0.26, 2.2, 4]} />
            <meshBasicMaterial color="#C8C2B4" transparent opacity={0.22} depthWrite={false} />
          </mesh>
          <mesh position={[0, 2.45, 0]}>
            <octahedronGeometry args={[0.26, 0]} />
            <meshBasicMaterial color="#C8C2B4" transparent opacity={0.28} depthWrite={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// ── scenery: the person, not the work ───────────────────────────────

// Placed off-path, never labelled, never blocking. A text CV writes
// "Interests: tennis, basketball". A world just has a court in it.
function Scenery() {
  return (
    <group>
      <TennisCourt z={stationZ(1) - 6} x={-16} />
      <Hoop z={stationZ(2) - 3} x={15} />
      <MicStand z={stationZ(3) - 4} x={-13} />
      <Lectern z={stationZ(4) - 5} x={14} />
    </group>
  );
}

function TennisCourt({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, 0.35, 0]}>
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[7, 14]} />
        <meshToonMaterial color="#5E8C6A" gradientMap={toon} />
      </mesh>
      {/* Service lines. Thin planes rather than textures so the court
          survives being seen at a grazing angle from the road. */}
      {[-6.5, 0, 6.5].map((lz) => (
        <mesh key={lz} position={[0, 0.04, lz]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[7, 0.12]} />
          <meshBasicMaterial color="#EFEFE6" />
        </mesh>
      ))}
      <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.12, 14]} />
        <meshBasicMaterial color="#EFEFE6" />
      </mesh>
      {/* Net */}
      <mesh position={[0, 0.42, 0]}>
        <boxGeometry args={[7.2, 0.82, 0.06]} />
        <meshToonMaterial color="#3B4A42" gradientMap={toon} />
      </mesh>
    </group>
  );
}

function Hoop({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, -0.5, 0]}>
      <mesh position={[0, 1.7, 0]}>
        <cylinderGeometry args={[0.1, 0.13, 3.4, 8]} />
        <meshToonMaterial color="#5A5147" gradientMap={toon} />
      </mesh>
      <mesh position={[0, 3.3, -0.36]}>
        <boxGeometry args={[1.7, 1.1, 0.09]} />
        <meshToonMaterial color="#EDE7DA" gradientMap={toon} />
      </mesh>
      <mesh position={[0, 2.95, 0.1]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.42, 0.045, 8, 22]} />
        <meshToonMaterial color="#D9714A" gradientMap={toon} />
      </mesh>
    </group>
  );
}

function MicStand({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, 0.8, 0]}>
      <mesh position={[0, 0.05, 0]}>
        <cylinderGeometry args={[0.42, 0.48, 0.1, 16]} />
        <meshToonMaterial color="#3F3B36" gradientMap={toon} />
      </mesh>
      <mesh position={[0, 0.95, 0]}>
        <cylinderGeometry args={[0.045, 0.055, 1.8, 8]} />
        <meshToonMaterial color="#57524A" gradientMap={toon} />
      </mesh>
      <mesh position={[0, 1.95, 0.03]} rotation={[0.35, 0, 0]}>
        <capsuleGeometry args={[0.11, 0.2, 4, 10]} />
        <meshToonMaterial color="#2E2B27" gradientMap={toon} />
      </mesh>
    </group>
  );
}

function Lectern({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, -0.9, 0]}>
      <mesh position={[0, 0.55, 0]}>
        <boxGeometry args={[0.16, 1.1, 0.16]} />
        <meshToonMaterial color="#6B5B45" gradientMap={toon} />
      </mesh>
      <mesh position={[0, 1.18, 0.05]} rotation={[-0.42, 0, 0]}>
        <boxGeometry args={[1.0, 0.7, 0.07]} />
        <meshToonMaterial color="#8A7458" gradientMap={toon} />
      </mesh>
    </group>
  );
}

// ── station markers ─────────────────────────────────────────────────

function Markers() {
  return (
    <group>
      {STATIONS.map((s, i) => (
        <Marker key={s.id} index={i} color={s.color} density={s.density} />
      ))}
    </group>
  );
}

function Marker({ index, color, density }: { index: number; color: string; density: number }) {
  const ringRef = useRef<THREE.Mesh>(null);
  const z = stationZ(index);
  // The repo already has this hook and Portal/Landmark honor it; the
  // walk was the one surface still spinning under reduced-motion.
  const reduce = useReducedMotion();
  useFrame((_, dt) => {
    if (!reduce && ringRef.current) ringRef.current.rotation.y += dt * 0.35;
  });

  // Markers stand off the road so the walker passes them rather than
  // colliding — you move through the story, never around it. Later
  // stations stand taller: the world empties out but the remaining
  // things get bigger.
  const side = index % 2 === 0 ? 1 : -1;
  const x = side * (HALF_WIDTH * TILE + 2.2);
  const height = 2.4 + (1 - density) * 3.2;

  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, height / 2, 0]} castShadow>
        <cylinderGeometry args={[0.17, 0.34, height, 4]} />
        <meshToonMaterial color="#6E6455" emissive={color} emissiveIntensity={0.14} gradientMap={toon} />
      </mesh>
      <mesh position={[0, height + 0.32, 0]}>
        <octahedronGeometry args={[0.34, 0]} />
        <meshToonMaterial color={color} emissive={color} emissiveIntensity={0.55} gradientMap={toon} />
      </mesh>
      <mesh ref={ringRef} position={[0, height + 0.32, 0]} rotation={[Math.PI / 2.2, 0, 0]}>
        <torusGeometry args={[0.7, 0.03, 8, 36]} />
        <meshBasicMaterial color={color} transparent opacity={0.78} />
      </mesh>
      <mesh position={[0, 0.28, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.8, 24]} />
        <meshBasicMaterial color={color} transparent opacity={0.10} depthWrite={false} />
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

    // Ease toward the scroll target rather than snapping, so the
    // browser's snap animation reads as a walk rather than a teleport.
    const targetZ = zAt(progress);
    g.position.z += (targetZ - g.position.z) * Math.min(1, dt * 3.2);
    g.position.y = 0.35;
    // Sit right of centre: the copy card occupies the left third, and a
    // walker hidden behind it defeats the point of having one.
    g.position.x = 1.6;

    const wantMoving = Math.abs(velocity) > 0.2;
    if (wantMoving !== moving.current) {
      moving.current = wantMoving;
      gooni.current?.setClip(wantMoving ? "Walk" : "Idle", { loop: true, fadeMs: 180 });
    }
    const facing = velocity < -0.2 ? Math.PI : 0;
    g.rotation.y += (facing - g.rotation.y) * Math.min(1, dt * 6);
  });

  // The colour chosen in the plaza. Reading it here is what makes the
  // drop feel like travel rather than a scene change — you fell in, so
  // it should still be you on the other side.
  const me = useMemo(() => getIdentity(), []);

  return (
    <group ref={group} position={[1.6, 0.35, 0]}>
      <GLTFGooni ref={gooni} bodyColor={me.bodyColor} accentColor={me.accentColor} />
    </group>
  );
}

// ── camera ──────────────────────────────────────────────────────────

function Rig() {
  const look = useRef(new THREE.Vector3(1.6, 1.2, -4));
  const reduce = useReducedMotion();
  // Scratch vectors, reused every frame. Allocating two Vector3s per
  // frame here was the one spot in this file doing it — CameraDirector
  // in the plaza already uses this pattern.
  const desired = useRef(new THREE.Vector3()).current;
  const lookTarget = useRef(new THREE.Vector3()).current;

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const { progress } = getScroll();
    const z = zAt(progress);

    // Camera sits left of the road and looks right, which pushes the
    // road and the walker into the right two-thirds of frame — clear of
    // the copy card. It rises and pulls back slightly as the walk goes
    // on so the emptying world stays readable.
    const sway = reduce ? 0 : Math.sin(progress * Math.PI * 1.6) * 1.8;
    desired.set(-7.5 + sway, 7.2 + progress * 2.6, z + 15.5);
    state.camera.position.lerp(desired, Math.min(1, dt * 1.8));

    lookTarget.set(1.6, 1.2, z - 5);
    look.current.lerp(lookTarget, Math.min(1, dt * 2.2));
    state.camera.lookAt(look.current);
  });

  return null;
}

/** Deterministic 0–1 from a number. Keeps scatter identical across
 *  reloads without pulling in a PRNG. */
function pseudo(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}
