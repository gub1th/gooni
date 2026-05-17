import { useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { getToonGradient } from "./toonGradient";

// Sky-island base — minimal. No stone cylinder underside (read as a
// "brown rug on a stage" — dropped). Tile floor + sky + hanging rocks
// hovering off the edge alone sell "floating in sky". A few free-
// hanging rocks at random spots beneath the tiles add silhouette
// detail.

export const PLAZA_RADIUS = 13;

const ROCK1_ASSET = "/models/nature/Rock_1.gltf";
const ROCK2_ASSET = "/models/nature/Rock_2.gltf";

function applyToonStone(scene: THREE.Object3D, color: string) {
  const grad = getToonGradient();
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = new THREE.MeshToonMaterial({ color, gradientMap: grad });
    mesh.castShadow = false;
    mesh.receiveShadow = false;
  });
}

function HangingRock({
  model,
  position,
  rotation,
  scale,
  color,
}: {
  model: THREE.Group;
  position: [number, number, number];
  rotation: number;
  scale: number;
  color: string;
}) {
  const cloned = useMemo(() => {
    const c = model.clone(true);
    applyToonStone(c, color);
    return c;
  }, [model, color]);
  return (
    <group position={position} rotation={[Math.PI * 0.18, rotation, Math.PI * 0.08]} scale={scale}>
      <primitive object={cloned} />
    </group>
  );
}

export function Plaza() {
  const rock1 = useGLTF(ROCK1_ASSET);
  const rock2 = useGLTF(ROCK2_ASSET);

  // Loose floating chunks below + just outside the tile field. They
  // imply "this island broke off a bigger landmass" without needing a
  // solid bottom.
  const hangers = useMemo(
    () => [
      { model: rock1.scene, position: [PLAZA_RADIUS * 0.85, -1.4, 0] as [number, number, number], rotation: 0.4, scale: 1.4, color: "#5a4f3a" },
      { model: rock2.scene, position: [-PLAZA_RADIUS * 0.78, -2.0, PLAZA_RADIUS * 0.30] as [number, number, number], rotation: -0.6, scale: 1.1, color: "#6a5c44" },
      { model: rock1.scene, position: [PLAZA_RADIUS * 0.25, -2.4, -PLAZA_RADIUS * 0.82] as [number, number, number], rotation: 1.2, scale: 1.2, color: "#5a4f3a" },
      { model: rock2.scene, position: [-PLAZA_RADIUS * 0.2, -1.8, PLAZA_RADIUS * 0.88] as [number, number, number], rotation: 0.9, scale: 1.3, color: "#6a5c44" },
    ],
    [rock1.scene, rock2.scene],
  );

  return (
    <group>
      {hangers.map((h, i) => (
        <HangingRock key={i} {...h} />
      ))}
    </group>
  );
}

useGLTF.preload(ROCK1_ASSET);
useGLTF.preload(ROCK2_ASSET);
