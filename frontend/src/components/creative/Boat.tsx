import { Suspense, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { useBoatControls } from "./useBoatControls";
import { ErrorBoundary } from "./ErrorBoundary";

const BOAT_GLB = "/models/rowboat.glb";
const ACCEL = 4.5;
const REVERSE_ACCEL = 2.0;
const TURN_ACCEL = 2.8;
const WATER_DRAG = 0.85;
const ANGULAR_DRAG = 1.6;
const MAX_SPEED = 4.5;

function BoatGLTF() {
  const { scene } = useGLTF(BOAT_GLB);
  // Clone so HMR / multiple mounts don't share the same Object3D state.
  const cloned = useMemo(() => scene.clone(true), [scene]);
  return <primitive object={cloned} scale={0.6} />;
}

function BoatPrimitive() {
  // Stylized wooden rowboat from primitives — runs when no GLB is shipped.
  return (
    <group>
      {/* Hull */}
      <mesh position={[0, 0.1, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.95, 0.32, 2.1]} />
        <meshStandardMaterial color="#7a5230" roughness={0.85} metalness={0.05} />
      </mesh>
      {/* Inner cavity — darker inset box reads as carved hull */}
      <mesh position={[0, 0.22, 0]}>
        <boxGeometry args={[0.78, 0.12, 1.85]} />
        <meshStandardMaterial color="#3b2412" roughness={1} />
      </mesh>
      {/* Paddle laid across the gunwales */}
      <mesh position={[0, 0.32, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.03, 0.03, 1.6, 8]} />
        <meshStandardMaterial color="#a17a4a" roughness={0.7} />
      </mesh>
      {/* Paddle blade */}
      <mesh position={[0.78, 0.32, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <boxGeometry args={[0.04, 0.22, 0.32]} />
        <meshStandardMaterial color="#7a5a30" roughness={0.7} />
      </mesh>
    </group>
  );
}

export function Boat() {
  const groupRef = useRef<THREE.Group>(null);
  const keys = useBoatControls();
  const { camera } = useThree();

  // Physics state in refs — mutated per frame in useFrame, never via setState.
  const state = useRef({
    pos: new THREE.Vector3(0, 0, 0),
    vel: new THREE.Vector3(0, 0, 0),
    heading: 0,
    angVel: 0,
  });

  // Reused vectors so the hot loop doesn't allocate.
  const tmpForward = useMemo(() => new THREE.Vector3(), []);
  const tmpCamSlot = useMemo(() => new THREE.Vector3(), []);
  const tmpLook = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, rawDt) => {
    if (!groupRef.current) return;
    const dt = Math.min(rawDt, 0.05); // clamp big frame hitches
    const s = state.current;
    const k = keys.current;

    const thrust = (k.forward ? 1 : 0) - (k.back ? REVERSE_ACCEL / ACCEL : 0);
    const turn = (k.left ? 1 : 0) - (k.right ? 1 : 0);

    // heading=0 → boat faces -Z so it sails "into the screen" at spawn.
    tmpForward.set(-Math.sin(s.heading), 0, -Math.cos(s.heading));
    s.vel.addScaledVector(tmpForward, thrust * ACCEL * dt);

    // Frame-rate-independent exponential drag.
    s.vel.multiplyScalar(Math.exp(-WATER_DRAG * dt));
    if (s.vel.length() > MAX_SPEED) s.vel.setLength(MAX_SPEED);

    s.angVel += turn * TURN_ACCEL * dt;
    s.angVel *= Math.exp(-ANGULAR_DRAG * dt);
    s.heading += s.angVel * dt;
    s.pos.addScaledVector(s.vel, dt);

    // Cosmetic vertical bob so the boat reads as afloat, not glued.
    const bob = Math.sin(performance.now() * 0.0014) * 0.04;

    groupRef.current.position.set(s.pos.x, bob, s.pos.z);
    groupRef.current.rotation.y = s.heading;

    // 3rd-person follow camera: target = behind+above the boat along its
    // heading. Lerp gives that floaty cinematic trail.
    tmpCamSlot
      .set(Math.sin(s.heading) * 6, 3.2, Math.cos(s.heading) * 6)
      .add(s.pos);
    camera.position.lerp(tmpCamSlot, 0.06);
    tmpLook.copy(s.pos).addScaledVector(tmpForward, 2);
    tmpLook.y = 0.4;
    camera.lookAt(tmpLook);
  });

  return (
    <group ref={groupRef}>
      <ErrorBoundary fallback={<BoatPrimitive />}>
        <Suspense fallback={<BoatPrimitive />}>
          <BoatGLTF />
        </Suspense>
      </ErrorBoundary>
    </group>
  );
}

// Start fetching the GLB as soon as this module loads — Suspense / boundary
// handle the case where the file doesn't exist.
useGLTF.preload(BOAT_GLB);
