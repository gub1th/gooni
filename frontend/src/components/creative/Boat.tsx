import { Suspense, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { consumeBoatReset, getBoatInput } from "./useBoatControls";
import { ErrorBoundary } from "./ErrorBoundary";

const BOAT_GLB = "/models/rowboat.glb";
const ACCEL = 4.5;
const REVERSE_ACCEL = 2.0;
const TURN_ACCEL = 1.6;
const WATER_DRAG = 0.85;
const ANGULAR_DRAG = 2.2;
const MAX_SPEED = 4.5;
const CAM_BACK = 6;
const CAM_HEIGHT = 3.0;
const FOV_IDLE = 50;
const FOV_MAX = 56;
// Soft tether — beyond this radius the boat feels a spring pull back
// toward the origin so it never sails forever into the fog.
const TETHER_R = 38;
const TETHER_K = 0.6;

function BoatGLTF() {
  const { scene } = useGLTF(BOAT_GLB);
  const cloned = useMemo(() => scene.clone(true), [scene]);
  return <primitive object={cloned} scale={0.6} />;
}

type PrimitiveProps = { oarRef: React.RefObject<THREE.Group> };

function BoatPrimitive({ oarRef }: PrimitiveProps) {
  return (
    <group>
      <mesh position={[0, 0.10, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.95, 0.30, 2.10]} />
        <meshStandardMaterial color="#6b4628" roughness={0.85} metalness={0.05} />
      </mesh>
      <mesh position={[0, 0.27, 0]} castShadow>
        <boxGeometry args={[1.02, 0.06, 2.18]} />
        <meshStandardMaterial color="#8a5a32" roughness={0.7} metalness={0.05} />
      </mesh>
      <mesh position={[0, 0.22, 0]}>
        <boxGeometry args={[0.78, 0.12, 1.85]} />
        <meshStandardMaterial color="#2c1a0e" roughness={1} />
      </mesh>
      <mesh position={[0, 0.18, 1.15]} castShadow>
        <cylinderGeometry args={[0.05, 0.55, 0.30, 12]} />
        <meshStandardMaterial color="#6b4628" roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.18, -1.15]} rotation={[Math.PI, 0, 0]} castShadow>
        <cylinderGeometry args={[0.05, 0.55, 0.30, 12]} />
        <meshStandardMaterial color="#6b4628" roughness={0.85} />
      </mesh>
      {/* Seated rower — primitive figure that gives the boat scale +
          story. Reads as someone in a robe gripping the stern oar. */}
      <group position={[0, 0.30, -0.35]}>
        {/* Robe / torso — short cylinder, kimono colour. */}
        <mesh position={[0, 0.10, 0]} castShadow>
          <cylinderGeometry args={[0.17, 0.20, 0.42, 14]} />
          <meshStandardMaterial color="#5a3d57" roughness={0.85} metalness={0.02} />
        </mesh>
        {/* Head — slight tan, leans forward into the row. */}
        <mesh position={[0, 0.40, 0.06]} rotation={[0.18, 0, 0]} castShadow>
          <sphereGeometry args={[0.115, 18, 18]} />
          <meshStandardMaterial color="#e8c69b" roughness={0.75} />
        </mesh>
        {/* Hat — flat conical sun hat. Reads as the Japanese pond mood. */}
        <mesh position={[0, 0.49, 0.04]} rotation={[0.12, 0, 0]} castShadow>
          <coneGeometry args={[0.22, 0.10, 18]} />
          <meshStandardMaterial color="#c69d6f" roughness={0.9} />
        </mesh>
      </group>
      {/* Stern oar — pivots from a point above the back of the boat. */}
      <group ref={oarRef} position={[0, 0.40, -1.0]}>
        <mesh position={[0, -0.10, -0.55]} rotation={[Math.PI / 7, 0, 0]} castShadow>
          <cylinderGeometry args={[0.03, 0.035, 1.4, 8]} />
          <meshStandardMaterial color="#a17a4a" roughness={0.6} />
        </mesh>
        <mesh position={[0, -0.42, -1.05]} rotation={[Math.PI / 7, 0, 0]} castShadow>
          <boxGeometry args={[0.18, 0.04, 0.36]} />
          <meshStandardMaterial color="#7a5a30" roughness={0.7} />
        </mesh>
      </group>
    </group>
  );
}

export function Boat() {
  const groupRef = useRef<THREE.Group | null>(null);
  const oarRef = useRef<THREE.Group>(null);
  const { camera } = useThree();

  const state = useRef({
    pos: new THREE.Vector3(0, 0, 0),
    vel: new THREE.Vector3(0, 0, 0),
    heading: 0,
    angVel: 0,
    paddlePhase: 0,
  });

  const tmpForward = useMemo(() => new THREE.Vector3(), []);
  const tmpCamSlot = useMemo(() => new THREE.Vector3(), []);
  const tmpLook = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, rawDt) => {
    if (!groupRef.current) return;
    const dt = Math.min(rawDt, 0.05);
    const s = state.current;

    if (consumeBoatReset()) {
      s.pos.set(0, 0, 0);
      s.vel.set(0, 0, 0);
      s.heading = 0;
      s.angVel = 0;
      s.paddlePhase = 0;
    }

    const inp = getBoatInput();
    // Asymmetric thrust: forward stronger than reverse, matches stern sculling.
    const rawThrust = inp.thrust;
    const thrust = rawThrust >= 0 ? rawThrust : rawThrust * (REVERSE_ACCEL / ACCEL);
    const turn = inp.turn;

    tmpForward.set(-Math.sin(s.heading), 0, -Math.cos(s.heading));
    s.vel.addScaledVector(tmpForward, thrust * ACCEL * dt);

    s.vel.multiplyScalar(Math.exp(-WATER_DRAG * dt));
    if (s.vel.length() > MAX_SPEED) s.vel.setLength(MAX_SPEED);

    s.angVel += turn * TURN_ACCEL * dt;
    s.angVel *= Math.exp(-ANGULAR_DRAG * dt);
    s.heading += s.angVel * dt;
    s.pos.addScaledVector(s.vel, dt);

    // Soft tether — only kicks in beyond TETHER_R. Linear spring back
    // toward origin, capped so it doesn't overpower thrust dramatically.
    const distFromCenter = Math.hypot(s.pos.x, s.pos.z);
    if (distFromCenter > TETHER_R) {
      const k = TETHER_K * (distFromCenter - TETHER_R);
      s.vel.x -= (s.pos.x / distFromCenter) * k * dt;
      s.vel.z -= (s.pos.z / distFromCenter) * k * dt;
    }

    const speed = s.vel.length();
    const bob = Math.sin(performance.now() * 0.0014) * 0.04;
    const roll = -s.angVel * 0.18;
    const pitch = Math.sin(performance.now() * 0.0017) * 0.015;

    groupRef.current.position.set(s.pos.x, bob, s.pos.z);
    groupRef.current.rotation.set(pitch, s.heading, roll);

    // Stern-scull animation — faster phase when thrusting; idle bob when not.
    const thrustMag = Math.abs(rawThrust);
    const strokeSpeed = thrustMag > 0.05 ? 5.2 * Math.max(thrustMag, 0.3) : 0.6;
    s.paddlePhase += dt * strokeSpeed;
    if (oarRef.current) {
      const sweep = Math.sin(s.paddlePhase) * (thrustMag > 0.05 ? 0.7 : 0.15);
      const dip = Math.cos(s.paddlePhase * 2) * 0.1 * (thrustMag > 0.05 ? 1 : 0.3);
      oarRef.current.rotation.set(dip, sweep, 0);
    }

    // 3rd-person follow + speed-based FOV punch.
    tmpCamSlot
      .set(Math.sin(s.heading) * CAM_BACK, CAM_HEIGHT, Math.cos(s.heading) * CAM_BACK)
      .add(s.pos);
    camera.position.lerp(tmpCamSlot, 0.06);
    tmpLook.copy(s.pos).addScaledVector(tmpForward, 2);
    tmpLook.y = 0.4;
    camera.lookAt(tmpLook);

    const persp = camera as THREE.PerspectiveCamera;
    if (persp.isPerspectiveCamera) {
      const targetFov = FOV_IDLE + (FOV_MAX - FOV_IDLE) * Math.min(speed / MAX_SPEED, 1);
      persp.fov += (targetFov - persp.fov) * 0.05;
      persp.updateProjectionMatrix();
    }
  });

  return (
    <group ref={groupRef}>
      <ErrorBoundary fallback={<BoatPrimitive oarRef={oarRef} />}>
        <Suspense fallback={<BoatPrimitive oarRef={oarRef} />}>
          <BoatGLTF />
        </Suspense>
      </ErrorBoundary>
    </group>
  );
}

useGLTF.preload(BOAT_GLB);
