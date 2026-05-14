import { Environment, Sky } from "@react-three/drei";

type Props = { mobile: boolean };

// Dusk palette — sun low to the horizon, warm orange-gold scatter.
// Sky's sunPosition drives both the shader gradient AND where we put
// the directional light so reflections + shadows agree.
export const SUN_POSITION: [number, number, number] = [25, 4, 60];

export function Atmosphere({ mobile }: Props) {
  return (
    <>
      <Sky
        distance={4500}
        sunPosition={SUN_POSITION}
        turbidity={8}
        rayleigh={3.2}
        mieCoefficient={0.005}
        mieDirectionalG={0.84}
      />
      {/* PBR environment — boat + lily pads + shore pick up sunset
          reflections instead of looking flat-lit. Pulled from drei's
          built-in HDR presets (zero network for `sunset`). */}
      <Environment preset="sunset" />
      {/* Warm haze hides the horizon — no big-world rendering past ~95 units. */}
      <fog attach="fog" args={["#e8b285", 28, 95]} />
      {/* Cool ambient fill so shadow-side of the boat doesn't go pitch.
          Slight blue cast balances the warm key light. */}
      <ambientLight intensity={0.35} color="#9ab4c4" />
      <directionalLight
        position={SUN_POSITION}
        intensity={1.4}
        color="#ffb677"
        castShadow={!mobile}
        shadow-mapSize-width={mobile ? 512 : 2048}
        shadow-mapSize-height={mobile ? 512 : 2048}
        shadow-bias={-0.0005}
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
