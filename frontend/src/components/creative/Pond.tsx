import { Suspense, useMemo, useRef } from "react";
import { extend, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Water } from "three/examples/jsm/objects/Water.js";
import * as THREE from "three";
import { SUN_POSITION } from "./Atmosphere";
import { ErrorBoundary } from "./ErrorBoundary";

// Register the Water class with R3F so it's usable as <water /> in JSX.
// drei doesn't ship a Water wrapper; this is the stock three.js example.
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

// Procedural fallback used when /textures/waternormals.jpg is missing.
// 256×256 mostly-flat normal map w/ tiny random perturbation so the
// surface still has a slight shimmer.
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
  const geometry = useMemo(() => new THREE.PlaneGeometry(200, 200), []);

  const config = useMemo(
    () => ({
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: normals,
      sunDirection: new THREE.Vector3(...SUN_POSITION).normalize(),
      sunColor: 0xffd9a0,
      waterColor: 0x355a4a,
      distortionScale: 2.6,
      fog: scene.fog !== null,
    }),
    [normals, scene.fog],
  );

  useFrame((_, dt) => {
    if (ref.current) {
      ref.current.material.uniforms.time.value += dt * 0.55;
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
  // Tile the normal map so each ripple cell stays small relative to the pond.
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
