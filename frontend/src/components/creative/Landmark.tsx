import { Suspense, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import { getToonGradient } from "./toonGradient";
import { useReducedMotion } from "./useReducedMotion";
import type { Landmark as LandmarkData } from "./landmarkPlacement";

// The physical destination markers on the plaza. Note-coins say "there
// is a note here"; landmarks say "this is a place". So they're built
// from ground-anchored geometry with real silhouettes rather than a
// floating disc — you should be able to tell a monument from the
// archive from across the island, before any text loads.
//
// Five silhouettes, one per kind:
//   monument — tall tapered obelisk, orbiting ring, lit crown
//   pylon    — shorter angular post with a slow-spinning shard
//   kiosk    — an angled reading board on two legs
//   signpost — a post with arms fanning outward off the island edge
//   archive  — a stack of slabs, each rotated a little off the last
//
// Motion is deliberately slower than the coins (these are architecture,
// not collectibles) and freezes entirely under prefers-reduced-motion.

type Props = {
  data: LandmarkData;
  isNear: boolean;
  isVisited: boolean;
  onSelect: (data: LandmarkData) => void;
};

const BOB_FREQ = (2 * Math.PI) / 5.5;

export function Landmark({ data, isNear, isVisited, onSelect }: Props) {
  const floatRef = useRef<THREE.Group>(null);
  const spinRef = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);
  const reduceMotion = useReducedMotion();
  const grad = useMemo(() => getToonGradient(), []);

  const x = data.gx * 2.0;
  const z = data.gz * 2.0;

  // Emissive ramps with attention: quiet at rest, warmer when the player
  // is a couple of tiles out, warmest on hover. Visited landmarks keep
  // their colour (unlike coins, which grey out) — a monument shouldn't
  // stop being a monument once you've read it — but they stop pulsing.
  const glow = (hovered ? 0.5 : isNear ? 0.32 : 0.16) + (isVisited ? 0 : 0.04);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const now = performance.now() / 1000;
    if (spinRef.current && !reduceMotion) {
      spinRef.current.rotation.y += dt * 0.42;
    }
    if (floatRef.current) {
      const bob = reduceMotion ? 0 : Math.sin(now * BOB_FREQ + data.gx * 1.7 + data.gz) * 0.075;
      floatRef.current.position.y = bob;
    }
  });

  function handleClick(e: ThreeEvent<MouseEvent>) {
    e.stopPropagation();
    onSelect(data);
  }
  function handleEnter(e: ThreeEvent<PointerEvent>) {
    e.stopPropagation();
    setHovered(true);
    document.body.style.cursor = "pointer";
  }
  function handleLeave() {
    setHovered(false);
    document.body.style.cursor = "";
  }

  const lit = (
    <meshToonMaterial
      color={data.color}
      emissive={data.color}
      emissiveIntensity={glow}
      gradientMap={grad}
    />
  );
  const stone = (
    <meshToonMaterial color="#6E6455" emissive={data.color} emissiveIntensity={glow * 0.3} gradientMap={grad} />
  );

  return (
    <group
      position={[x, 0, z]}
      onClick={handleClick}
      onPointerEnter={handleEnter}
      onPointerLeave={handleLeave}
    >
      {/* Ground disc — every landmark sits on a plinth so it reads as
          placed rather than dropped. */}
      <mesh position={[0, 0.06, 0]} receiveShadow>
        <cylinderGeometry args={[0.62, 0.7, 0.12, 24]} />
        {stone}
      </mesh>

      {data.kind === "monument" && <MonumentBody lit={lit} stone={stone} spinRef={spinRef} floatRef={floatRef} />}
      {data.kind === "pylon" && <PylonBody lit={lit} stone={stone} spinRef={spinRef} />}
      {data.kind === "kiosk" && <KioskBody lit={lit} stone={stone} />}
      {data.kind === "signpost" && <SignpostBody lit={lit} stone={stone} floatRef={floatRef} />}
      {data.kind === "archive" && <ArchiveBody lit={lit} stone={stone} />}

      {/* Floating screenshot. Suspense-wrapped and fallback-null so a
          missing or slow texture never blocks the landmark itself from
          rendering — the geometry is the load-bearing part, the picture
          is the payoff. */}
      {data.project?.image && (
        <Suspense fallback={null}>
          <Billboard
            src={data.project.image}
            y={BILLBOARD_Y[data.kind] ?? 2.6}
            color={data.color}
            glow={glow}
          />
        </Suspense>
      )}
    </group>
  );
}

// Clear of each silhouette's tallest element.
const BILLBOARD_Y: Record<string, number> = {
  monument: 3.5,
  pylon: 2.5,
  kiosk: 2.0,
  signpost: 2.4,
  archive: 1.7,
};

const BILLBOARD_W = 1.7;

function Billboard({ src, y, color, glow }: { src: string; y: number; color: string; glow: number }) {
  const ref = useRef<THREE.Group>(null);
  const tex = useTexture(src);
  const reduceMotion = useReducedMotion();

  // Preserve the source aspect so a wide dashboard shot isn't squashed
  // into the frame's proportions.
  const h = useMemo(() => {
    const img = tex.image as { width?: number; height?: number } | undefined;
    const ratio = img?.width && img?.height ? img.height / img.width : 0.62;
    return BILLBOARD_W * ratio;
  }, [tex]);

  // Face the camera on Y only. A full lookAt would let the panel pitch
  // toward the camera's height and read as tumbling when you orbit.
  useFrame((state) => {
    const g = ref.current;
    if (!g) return;
    const cam = state.camera.position;
    g.rotation.y = Math.atan2(cam.x - g.parent!.position.x, cam.z - g.parent!.position.z);
    if (!reduceMotion) {
      g.position.y = y + Math.sin(performance.now() / 1000 * 0.6) * 0.05;
    }
  });

  return (
    <group ref={ref} position={[0, y, 0]}>
      {/* Backing plate doubles as the frame border. */}
      <mesh position={[0, 0, -0.012]}>
        <planeGeometry args={[BILLBOARD_W + 0.09, h + 0.09]} />
        <meshBasicMaterial color={color} transparent opacity={0.55} side={THREE.DoubleSide} />
      </mesh>
      <mesh>
        <planeGeometry args={[BILLBOARD_W, h]} />
        <meshBasicMaterial map={tex} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      {/* Tether down to the structure so the panel reads as mounted
          rather than coincidentally hovering. */}
      <mesh position={[0, -h / 2 - 0.3, -0.012]}>
        <planeGeometry args={[0.02, 0.6]} />
        <meshBasicMaterial color={color} transparent opacity={0.3 + glow * 0.4} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

type BodyProps = {
  lit: React.ReactElement;
  stone: React.ReactElement;
  spinRef?: React.RefObject<THREE.Group>;
  floatRef?: React.RefObject<THREE.Group>;
};

function MonumentBody({ lit, stone, spinRef, floatRef }: BodyProps) {
  return (
    <group>
      {/* Tapered shaft. Four-sided so it catches the toon ramp as flat
          planes — reads as carved, not turned. */}
      <mesh position={[0, 1.15, 0]} castShadow>
        <cylinderGeometry args={[0.17, 0.32, 2.1, 4]} />
        {stone}
      </mesh>
      {/* Crown — the lit part, the bit visible from across the island. */}
      <group ref={floatRef}>
        <mesh position={[0, 2.42, 0]} castShadow>
          <octahedronGeometry args={[0.28, 0]} />
          {lit}
        </mesh>
      </group>
      {/* Orbiting ring. */}
      <group ref={spinRef} position={[0, 2.42, 0]}>
        <mesh rotation={[Math.PI / 2.3, 0, 0]}>
          <torusGeometry args={[0.55, 0.032, 8, 40]} />
          {lit}
        </mesh>
      </group>
    </group>
  );
}

function PylonBody({ lit, stone, spinRef }: BodyProps) {
  return (
    <group>
      <mesh position={[0, 0.72, 0]} castShadow>
        <cylinderGeometry args={[0.15, 0.24, 1.25, 3]} />
        {stone}
      </mesh>
      <group ref={spinRef} position={[0, 1.62, 0]}>
        <mesh castShadow>
          <tetrahedronGeometry args={[0.3, 0]} />
          {lit}
        </mesh>
      </group>
    </group>
  );
}

function KioskBody({ lit, stone }: BodyProps) {
  return (
    <group>
      {/* Two legs + an angled board — a park notice board. */}
      <mesh position={[-0.24, 0.45, 0]} castShadow>
        <boxGeometry args={[0.075, 0.78, 0.075]} />
        {stone}
      </mesh>
      <mesh position={[0.24, 0.45, 0]} castShadow>
        <boxGeometry args={[0.075, 0.78, 0.075]} />
        {stone}
      </mesh>
      <mesh position={[0, 1.0, 0.06]} rotation={[-0.32, 0, 0]} castShadow>
        <boxGeometry args={[0.86, 0.62, 0.055]} />
        {lit}
      </mesh>
    </group>
  );
}

function SignpostBody({ lit, stone, floatRef }: BodyProps) {
  // Arms fan outward at different heights + headings, the way a real
  // trail signpost points at several places at once.
  const arms: { y: number; rot: number }[] = [
    { y: 1.36, rot: 0.0 },
    { y: 1.08, rot: 2.2 },
    { y: 0.8, rot: 4.3 },
  ];
  return (
    <group>
      <mesh position={[0, 0.82, 0]} castShadow>
        <cylinderGeometry args={[0.07, 0.09, 1.5, 8]} />
        {stone}
      </mesh>
      {arms.map((a, i) => (
        <group key={i} position={[0, a.y, 0]} rotation={[0, a.rot, 0]}>
          <mesh position={[0.31, 0, 0]} castShadow>
            <boxGeometry args={[0.56, 0.15, 0.05]} />
            {lit}
          </mesh>
        </group>
      ))}
      <group ref={floatRef}>
        <mesh position={[0, 1.72, 0]}>
          <sphereGeometry args={[0.11, 16, 12]} />
          {lit}
        </mesh>
      </group>
    </group>
  );
}

function ArchiveBody({ lit, stone }: BodyProps) {
  // A cairn of slabs, each smaller and rotated off the last — reads as
  // sediment, which is what old projects are.
  const slabs = [
    { y: 0.22, s: 0.86, r: 0.0 },
    { y: 0.42, s: 0.74, r: 0.5 },
    { y: 0.6, s: 0.62, r: 1.05 },
    { y: 0.76, s: 0.48, r: 1.7 },
  ];
  return (
    <group>
      {slabs.map((sl, i) => (
        <mesh key={i} position={[0, sl.y, 0]} rotation={[0, sl.r, 0]} castShadow>
          <boxGeometry args={[sl.s, 0.15, sl.s * 0.72]} />
          {i === slabs.length - 1 ? lit : stone}
        </mesh>
      ))}
    </group>
  );
}
