import { Suspense, useMemo, useRef } from "react";
import { extend, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Water } from "three/examples/jsm/objects/Water.js";
import * as THREE from "three";
import { SUN_POSITION } from "./Atmosphere";
import { ErrorBoundary } from "./ErrorBoundary";

// Register the Water class with R3F so it's usable as <water /> in JSX.
extend({ Water });

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      water: any;
    }
  }
}

const WATER_NORMALS_URL = "/textures/waternormals.jpg";

// Procedural fallback — flat normal w/ tiny perturbation so the surface
// still shimmers if waternormals.jpg is absent.
function makeFallbackNormals(): THREE.Texture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const nx = 0.5 + (Math.random() - 0.5) * 0.06;
    const ny = 0.5 + (Math.random() - 0.5) * 0.06;
    data[i * 4 + 0] = Math.floor(nx * 255);
    data[i * 4 + 1] = Math.floor(ny * 255);
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

function WaterMesh({ normals }: { normals: THREE.Texture }) {
  const ref = useRef<any>(null);
  const { scene } = useThree();
  const geometry = useMemo(() => new THREE.PlaneGeometry(220, 220, 1, 1), []);

  const config = useMemo(
    () => ({
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: normals,
      sunDirection: new THREE.Vector3(...SUN_POSITION).normalize(),
      // Warmer sun reflection — matches the dusk key light.
      sunColor: 0xffc88a,
      // Murky tea-green; reads "still pond water" not "ocean."
      waterColor: 0x2a4438,
      distortionScale: 2.1,
      fog: scene.fog !== null,
    }),
    [normals, scene.fog],
  );

  useFrame((_, dt) => {
    if (ref.current) {
      // Slow current — Japanese ponds are mostly still.
      ref.current.material.uniforms.time.value += dt * 0.35;
    }
  });

  return (
    <water
      ref={ref}
      args={[geometry, config]}
      rotation-x={-Math.PI / 2}
      position-y={0}
      receiveShadow
    />
  );
}

function WaterReal() {
  const tex = useLoader(THREE.TextureLoader, WATER_NORMALS_URL);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return <WaterMesh normals={tex} />;
}

function WaterFallback() {
  const tex = useMemo(makeFallbackNormals, []);
  return <WaterMesh normals={tex} />;
}

export function Pond() {
  return (
    <ErrorBoundary fallback={<WaterFallback />}>
      <Suspense fallback={<WaterFallback />}>
        <WaterReal />
      </Suspense>
    </ErrorBoundary>
  );
}
