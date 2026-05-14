import { Sky } from "@react-three/drei";

type Props = { mobile: boolean };

// Sky + fog + lights. Warm dusk palette; sun position drives both the
// drei Sky shader and the key directionalLight so reflections match.
export const SUN_POSITION: [number, number, number] = [80, 30, 60];

export function Atmosphere({ mobile }: Props) {
  return (
    <>
      <Sky
        distance={4500}
        sunPosition={SUN_POSITION}
        turbidity={6}
        rayleigh={2}
        mieCoefficient={0.005}
        mieDirectionalG={0.8}
      />
      {/* Warm haze hides the horizon — no big-world rendering past ~90 units. */}
      <fog attach="fog" args={["#d9b88a", 30, 95]} />
      <ambientLight intensity={0.45} />
      <directionalLight
        position={SUN_POSITION}
        intensity={1.15}
        castShadow={!mobile}
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-near={1}
        shadow-camera-far={80}
        shadow-camera-left={-25}
        shadow-camera-right={25}
        shadow-camera-top={25}
        shadow-camera-bottom={-25}
      />
    </>
  );
}
