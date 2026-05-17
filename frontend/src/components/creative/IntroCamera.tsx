import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { fireVfx } from "./vfx";

// Cinematic intro — SINGLE continuous swoop. Position rides a bezier
// arc from the LandingCamera's last pose to the gameplay pose;
// lookAt eases simultaneously from "where we were aimed" to the
// gameplay target. easeInOut on both. No phase boundaries, no impact
// freeze, no shake — feels like one smooth drone-shot move.
//
// `onSwoopLanded` fires partway through (u ≈ 0.55) so the character
// pops in + the get-up starts WITHOUT the camera coming to a full
// stop. By the time the get-up finishes, the camera is in its final
// orbit pose.
//
// `externalTarget` (note-reader transitions) shares the same pos+look
// lerp pattern.

type Props = {
  active: boolean;
  onSwoopLanded: () => void;
  onComplete: () => void;
  externalTarget?: { pos: THREE.Vector3; look: THREE.Vector3; duration?: number } | null;
};

const SWOOP_DUR = 3.5;
const CHAR_APPEAR_U = 0.55;
const POOF_FX_U = 0.55;

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function bezier3(
  a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3,
  t: number, out: THREE.Vector3,
) {
  const u = 1 - t;
  out.set(
    u * u * a.x + 2 * u * t * b.x + t * t * c.x,
    u * u * a.y + 2 * u * t * b.y + t * t * c.y,
    u * u * a.z + 2 * u * t * b.z + t * t * c.z,
  );
  return out;
}

const KF = {
  // Cardinal-axis rear orbit pose — gameplay default.
  orbit: new THREE.Vector3(0, 8, 10),
  orbitLook: new THREE.Vector3(0, 0.6, 0),
};

export const ORBIT_BASELINE = {
  position: KF.orbit.clone(),
  target: KF.orbitLook.clone(),
  minDistance: 8,
  maxDistance: 26,
};

export function IntroCamera({ active, onSwoopLanded, onComplete, externalTarget }: Props) {
  const { camera } = useThree();
  const tRef = useRef(0);
  const phaseRef = useRef<"intro" | "external" | "idle">("idle");
  const startCapturedRef = useRef(false);
  const startPosRef = useRef(new THREE.Vector3());
  const startLookRef = useRef(new THREE.Vector3());
  const midPosRef = useRef(new THREE.Vector3());
  const swoopLandedFiredRef = useRef(false);
  const poofFiredRef = useRef(false);

  const externalRef = useRef<{
    fromPos: THREE.Vector3;
    fromLook: THREE.Vector3;
    toPos: THREE.Vector3;
    toLook: THREE.Vector3;
    dur: number;
    t: number;
  } | null>(null);

  const tmpPos = useRef(new THREE.Vector3()).current;
  const tmpLook = useRef(new THREE.Vector3()).current;
  const lookAccum = useRef(new THREE.Vector3()).current;

  useEffect(() => {
    if (active) {
      tRef.current = 0;
      phaseRef.current = "intro";
      startCapturedRef.current = false;
      swoopLandedFiredRef.current = false;
      poofFiredRef.current = false;
    }
  }, [active]);

  function captureStartPose() {
    startPosRef.current.copy(camera.position);
    // Where was the camera looking? Project the forward vector forward
    // so we have a worldspace look point to lerp FROM.
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    startLookRef.current.copy(camera.position).add(dir.multiplyScalar(2));
    // Bezier mid-control — between start and orbit pose, biased
    // upward so the arc rises gently before descending toward orbit.
    midPosRef.current.set(
      (startPosRef.current.x + KF.orbit.x) * 0.5,
      Math.max(startPosRef.current.y, KF.orbit.y) + 1.5,
      (startPosRef.current.z + KF.orbit.z) * 0.5,
    );
    startCapturedRef.current = true;
  }

  useEffect(() => {
    if (!externalTarget) return;
    const fromPos = camera.position.clone();
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const fromLook = camera.position.clone().add(dir.multiplyScalar(2));
    externalRef.current = {
      fromPos,
      fromLook,
      toPos: externalTarget.pos.clone(),
      toLook: externalTarget.look.clone(),
      dur: externalTarget.duration ?? 1.1,
      t: 0,
    };
    phaseRef.current = "external";
  }, [externalTarget, camera]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);

    if (active && phaseRef.current === "intro") {
      if (!startCapturedRef.current) captureStartPose();
      tRef.current += dt;
      const tNorm = Math.min(1, tRef.current / SWOOP_DUR);
      const u = easeInOut(tNorm);

      // Position rides a quadratic bezier arc through mid → orbit.
      bezier3(startPosRef.current, midPosRef.current, KF.orbit, u, tmpPos);
      // LookAt blends linearly between captured start look and orbit
      // look — eased by same `u` so both motions arrive together.
      lookAccum.copy(startLookRef.current).lerp(KF.orbitLook, u);
      camera.position.copy(tmpPos);
      camera.lookAt(lookAccum);

      // Char appears + poof particle fires partway through swoop.
      if (!poofFiredRef.current && u > POOF_FX_U) {
        poofFiredRef.current = true;
        fireVfx({
          kind: "dust",
          world: { x: 0, y: 0.1, z: 0 },
          intensity: 0.9,
        });
      }
      if (!swoopLandedFiredRef.current && u > CHAR_APPEAR_U) {
        swoopLandedFiredRef.current = true;
        onSwoopLanded();
      }

      if (tNorm >= 1) {
        camera.position.copy(KF.orbit);
        tmpLook.copy(KF.orbitLook);
        camera.lookAt(tmpLook);
        phaseRef.current = "idle";
        onComplete();
      }
    } else if (phaseRef.current === "external" && externalRef.current) {
      const e = externalRef.current;
      e.t += dt;
      const u = Math.min(1, easeInOut(e.t / e.dur));
      const pos = e.fromPos.clone().lerp(e.toPos, u);
      lookAccum.copy(e.fromLook).lerp(e.toLook, u);
      camera.position.copy(pos);
      camera.lookAt(lookAccum);
      if (u >= 1) {
        externalRef.current = null;
        phaseRef.current = "idle";
      }
    }
  });

  return null;
}
