import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";

// Pre-entry camera — high bird's-eye orbit. Per Gooni Plaza spec:
//   - directly above the island looking DOWN
//   - slow rotation around the world Y axis (3-5°/sec)
//
// Tighter radius than before so the camera reads as "above" rather
// than "off to the side". Always looks at scene origin with a small
// downward tilt — keeps tile rows aligned w/ screen edges + makes the
// slow orbit visible. Once the user clicks, IntroCamera takes over and
// the fall is Y-only (this component sets x/z near zero so the drop
// feels vertical).

type Props = { active: boolean };

const ORBIT_Y = 17;
const ORBIT_RADIUS = 4.5;
// 4.5°/sec (≈ 0.078 rad/sec) — mid of the 3-5°/sec spec band.
const ROT_SPEED = 0.078;

export function LandingCamera({ active }: Props) {
  const { camera } = useThree();
  const tRef = useRef(0);

  useFrame((_, rawDt) => {
    if (!active) return;
    const dt = Math.min(rawDt, 0.05);
    tRef.current += dt;
    const a = tRef.current * ROT_SPEED;
    camera.position.set(Math.cos(a) * ORBIT_RADIUS, ORBIT_Y, Math.sin(a) * ORBIT_RADIUS);
    camera.lookAt(0, 0, 0);
  });

  return null;
}
