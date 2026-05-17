type Props = { mobile: boolean };

// 3-light setup per Quaternius / Gooni Plaza spec:
//   - Warm key sun from (5, 8, 3), intensity 1.1, soft shadows
//   - Hemisphere COOL BLUE sky / warm ground bounce
//   - Cool blue rim from behind for back-edge separation
// Plus exponential fog (FogExp2) tuned to blend tiles into the horizon.

export const SUN_POSITION: [number, number, number] = [5, 8, 3];

export function Atmosphere({ mobile }: Props) {
  return (
    <>
      {/* FogExp2 per spec (was linear fog). Color matches sky-mid band so
          the horizon transition feels continuous. */}
      <fogExp2 attach="fog" args={["#e8e0d0", 0.012]} />

      {/* Cool sky, warm ground bounce — spec colors. Lower intensity so
          shadows actually read. */}
      <hemisphereLight color="#b8c9e8" groundColor="#d4c8a8" intensity={0.55} />

      {/* Warm key — main sun light. Softer than before to match spec. */}
      <directionalLight
        position={SUN_POSITION}
        intensity={1.1}
        color="#fff4e0"
        castShadow={!mobile}
        shadow-mapSize-width={mobile ? 1024 : 2048}
        shadow-mapSize-height={mobile ? 1024 : 2048}
        shadow-bias={-0.0005}
        shadow-radius={3.5}
        shadow-camera-near={1}
        shadow-camera-far={60}
        shadow-camera-left={-22}
        shadow-camera-right={22}
        shadow-camera-top={22}
        shadow-camera-bottom={-22}
      />

      {/* Cool rim — back light for back-edge stroke on character. */}
      <directionalLight position={[0, 5, -10]} intensity={0.28} color="#aac8ff" />
    </>
  );
}
