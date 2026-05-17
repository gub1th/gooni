import { useMemo, useRef, useEffect } from "react";
import { useFrame, ThreeEvent } from "@react-three/fiber";
import { Outlines } from "@react-three/drei";
import * as THREE from "three";
import type { PublicNote } from "../../services/api";

// Crowd avatar — toon-shaded Fall-Guys-Gooni style. Body capsule +
// stub limbs. Same toon material approach as Daniel so the scene reads
// as one stylistic family.

const PLAZA_INNER = 10;
const WALK_SPEED = 0.55;
const ARRIVE_RADIUS = 0.25;
const WAIT_MIN = 1.6;
const WAIT_MAX = 4.0;
const BOB_AMP = 0.05;

const OUTLINE_COLOR = "#1a2620";
const OUTLINE_THICK = 0.015;

type Props = {
  note: PublicNote;
  initialPos: THREE.Vector3;
  onClick: (note: PublicNote, worldPos: THREE.Vector3) => void;
  hovered: boolean;
  focused: boolean;
  active: boolean;
};

const AVATAR_PALETTE = [
  "#ff6f8d", "#5aa6ff", "#ffc14d", "#a36cff",
  "#ff8a4d", "#5fd3a5", "#ff5ea0", "#7a8cff",
  "#ffd86b", "#71c7ff",
];

function avatarColor(noteId: number): string {
  const idx = Math.abs(noteId * 2654435761) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[idx];
}

function makeToonGradient(): THREE.DataTexture {
  const data = new Uint8Array([90, 90, 90, 255, 200, 200, 200, 255, 255, 255, 255, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

let SHARED_GRAD: THREE.DataTexture | null = null;
function sharedGradient(): THREE.DataTexture {
  if (!SHARED_GRAD) SHARED_GRAD = makeToonGradient();
  return SHARED_GRAD;
}

export function Avatar({ note, initialPos, onClick, hovered, focused, active }: Props) {
  const rootRef = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);

  const color = useMemo(() => avatarColor(note.id), [note.id]);
  const grad = useMemo(sharedGradient, []);

  const state = useRef({
    pos: initialPos.clone(),
    target: pickTarget(note.id, 1),
    wait: WAIT_MIN + ((note.id * 17) % 1000) / 1000 * (WAIT_MAX - WAIT_MIN),
    heading: 0,
    bobPhase: ((note.id * 31) % 1000) / 1000 * Math.PI * 2,
    nextSeed: 1,
  });

  const ctlRef = useRef({ active, focused });
  ctlRef.current.active = active;
  ctlRef.current.focused = focused;

  useEffect(() => {
    if (rootRef.current) rootRef.current.position.copy(initialPos);
  }, [initialPos]);

  useFrame((_, rawDt) => {
    const root = rootRef.current;
    if (!root) return;
    const dt = Math.min(rawDt, 0.05);
    const s = state.current;

    if (ctlRef.current.active && !ctlRef.current.focused) {
      if (s.wait > 0) {
        s.wait -= dt;
      } else {
        const dx = s.target.x - s.pos.x;
        const dz = s.target.z - s.pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist < ARRIVE_RADIUS) {
          s.nextSeed += 1;
          s.target = pickTarget(note.id, s.nextSeed);
          s.wait = WAIT_MIN + Math.random() * (WAIT_MAX - WAIT_MIN);
        } else {
          const ux = dx / dist;
          const uz = dz / dist;
          s.pos.x += ux * WALK_SPEED * dt;
          s.pos.z += uz * WALK_SPEED * dt;
          const desired = Math.atan2(ux, uz);
          let diff = desired - s.heading;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          s.heading += diff * Math.min(1, dt * 5);
        }
      }
    }

    const walking = s.wait <= 0 && ctlRef.current.active && !ctlRef.current.focused;
    const bob = walking
      ? Math.abs(Math.sin(performance.now() * 0.012 + s.bobPhase)) * BOB_AMP
      : Math.sin(performance.now() * 0.0028 + s.bobPhase) * 0.015;
    root.position.set(s.pos.x, bob, s.pos.z);
    root.rotation.y = s.heading;

    if (tiltRef.current) {
      const wantTilt = walking ? -0.06 : 0;
      tiltRef.current.rotation.x += (wantTilt - tiltRef.current.rotation.x) * 0.08;
    }
  });

  function handleClick(e: ThreeEvent<MouseEvent>) {
    e.stopPropagation();
    if (!ctlRef.current.active) return;
    const wp = new THREE.Vector3();
    rootRef.current?.getWorldPosition(wp);
    onClick(note, wp);
  }

  const targetScale = hovered ? 1.10 : focused ? 1.18 : 1.0;
  useFrame(() => {
    const root = rootRef.current;
    if (!root) return;
    const cur = root.scale.x;
    root.scale.setScalar(cur + (targetScale - cur) * 0.12);
  });

  return (
    <group ref={rootRef} onClick={handleClick} onPointerDown={(e) => e.stopPropagation()}>
      <mesh position-y={0.012} rotation-x={-Math.PI / 2}>
        <circleGeometry args={[0.36, 18]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.20} depthWrite={false} />
      </mesh>

      <group ref={tiltRef}>
        {/* Body */}
        <mesh position={[0, 0.62, 0]}>
          <capsuleGeometry args={[0.34, 0.56, 8, 18]} />
          <meshToonMaterial color={color} gradientMap={grad} />
          <Outlines thickness={OUTLINE_THICK} color={OUTLINE_COLOR} angle={0.5} screenspace={false} />
        </mesh>

        {/* Pinned indicator */}
        {note.is_public_pinned && (
          <mesh position={[0, 1.35, 0]} rotation={[Math.PI / 4, 0, Math.PI / 4]}>
            <octahedronGeometry args={[0.10, 0]} />
            <meshToonMaterial color="#ffd25a" gradientMap={grad} emissive="#ff9c25" emissiveIntensity={0.55} />
            <Outlines thickness={0.012} color={OUTLINE_COLOR} angle={0.5} screenspace={false} />
          </mesh>
        )}

        {/* Eye whites + pupils */}
        <group position={[0, 1.05, 0.31]}>
          <mesh position={[0.11, 0, 0]} rotation={[0, -0.2, 0]}>
            <sphereGeometry args={[0.075, 14, 12]} />
            <meshToonMaterial color="#ffffff" gradientMap={grad} />
            <Outlines thickness={0.010} color={OUTLINE_COLOR} angle={0.5} screenspace={false} />
          </mesh>
          <mesh position={[-0.11, 0, 0]} rotation={[0, 0.2, 0]}>
            <sphereGeometry args={[0.075, 14, 12]} />
            <meshToonMaterial color="#ffffff" gradientMap={grad} />
            <Outlines thickness={0.010} color={OUTLINE_COLOR} angle={0.5} screenspace={false} />
          </mesh>
          <mesh position={[0.115, 0, 0.05]}>
            <sphereGeometry args={[0.030, 10, 8]} />
            <meshToonMaterial color="#0e1410" gradientMap={grad} />
          </mesh>
          <mesh position={[-0.115, 0, 0.05]}>
            <sphereGeometry args={[0.030, 10, 8]} />
            <meshToonMaterial color="#0e1410" gradientMap={grad} />
          </mesh>
        </group>

        {/* Smile mouth — torus arc */}
        <group position={[0, 0.92, 0.345]}>
          <mesh rotation={[0, 0, Math.PI]}>
            <torusGeometry args={[0.06, 0.010, 6, 18, Math.PI * 0.55]} />
            <meshToonMaterial color="#1a1410" gradientMap={grad} />
          </mesh>
        </group>

        {/* Stub arms */}
        <mesh position={[0.42, 0.66, 0]} rotation={[0, 0, -0.22]}>
          <capsuleGeometry args={[0.085, 0.28, 6, 12]} />
          <meshToonMaterial color={color} gradientMap={grad} />
          <Outlines thickness={0.012} color={OUTLINE_COLOR} angle={0.5} screenspace={false} />
        </mesh>
        <mesh position={[-0.42, 0.66, 0]} rotation={[0, 0, 0.22]}>
          <capsuleGeometry args={[0.085, 0.28, 6, 12]} />
          <meshToonMaterial color={color} gradientMap={grad} />
          <Outlines thickness={0.012} color={OUTLINE_COLOR} angle={0.5} screenspace={false} />
        </mesh>

        {/* Stub legs */}
        <mesh position={[0.14, 0.13, 0.02]}>
          <capsuleGeometry args={[0.10, 0.18, 6, 12]} />
          <meshToonMaterial color={color} gradientMap={grad} />
          <Outlines thickness={0.012} color={OUTLINE_COLOR} angle={0.5} screenspace={false} />
        </mesh>
        <mesh position={[-0.14, 0.13, 0.02]}>
          <capsuleGeometry args={[0.10, 0.18, 6, 12]} />
          <meshToonMaterial color={color} gradientMap={grad} />
          <Outlines thickness={0.012} color={OUTLINE_COLOR} angle={0.5} screenspace={false} />
        </mesh>
      </group>
    </group>
  );
}

function pickTarget(noteId: number, seed: number): THREE.Vector3 {
  const k = (noteId * 2654435761 + seed * 19349663) | 0;
  const r1 = ((Math.abs(k) % 1000) / 1000);
  const r2 = ((Math.abs(k ^ 0x55aa1234) % 1000) / 1000);
  const angle = r1 * Math.PI * 2;
  const radius = Math.sqrt(r2) * PLAZA_INNER;
  return new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
}
