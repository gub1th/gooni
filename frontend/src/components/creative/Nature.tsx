import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { getToonGradient } from "./toonGradient";
import { GRID_PITCH, gridToWorld, setTileBlocked } from "./useDanielControls";
import { registerOccluder } from "./occluders";

// GLTF-backed Quaternius nature props placed ON the tile grid per spec.
// Trees + bushes sway via per-group rotation; rocks + grass are static.

const TREE_ASSET = "/models/nature/Tree.gltf";
const BUSH_ASSET = "/models/nature/Bush.gltf";
const ROCK1_ASSET = "/models/nature/Rock_1.gltf";
const ROCK2_ASSET = "/models/nature/Rock_2.gltf";
const GRASS_ASSET = "/models/nature/Grass_1.gltf";

// Material name → toon color. Brighter than Quaternius defaults to read
// well under the warm sun + bloom.
const NATURE_COLORS: Record<string, string> = {
  Wood: "#7c5230",
  Green: "#5fa84b",
  Rock_Grey: "#9aa0a8",
  Green_Light: "#6dbf5a",
  Cloud: "#ffffff",
};

function applyToon(scene: THREE.Object3D) {
  const grad = getToonGradient();
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const origMat = mesh.material as THREE.Material | THREE.Material[];
    function convert(m: THREE.Material): THREE.Material {
      const color = NATURE_COLORS[m.name] ?? "#888888";
      return new THREE.MeshToonMaterial({ color, gradientMap: grad });
    }
    mesh.material = Array.isArray(origMat) ? origMat.map(convert) : convert(origMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
}

function useToonAsset(path: string): THREE.Group {
  const gltf = useGLTF(path);
  return useMemo(() => {
    const c = gltf.scene.clone(true);
    applyToon(c);
    return c;
  }, [gltf.scene]);
}

type Placement = {
  kind: "tree" | "bush" | "rock1" | "rock2" | "grass";
  gx: number;
  gz: number;
  rot: number;
  scale: number;
  swayPhase: number;
};

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function buildPlacements(): Placement[] {
  const rand = mulberry32(0xC10D55);
  // Trees on cardinal outer tiles (spec: corners + mid-edges).
  const treeCells: Array<[number, number]> = [[6, 0], [0, 6], [-6, 0], [0, -6]];
  // Bushes on diagonal outer tiles.
  const bushCells: Array<[number, number]> = [[4, 4], [-4, 4], [4, -4], [-4, -4]];
  // Rocks scattered on outer-ring tiles.
  const rockCells: Array<[number, number]> = [[5, 2], [-5, 2], [2, -5], [-3, -5], [5, -2], [-2, 5]];
  // Grass tufts removed — they read as "floating leaves" rather than
  // tufts at the camera angle we use.
  const grassCells: Array<[number, number]> = [];

  const out: Placement[] = [];
  treeCells.forEach(([gx, gz]) => {
    out.push({
      kind: "tree", gx, gz,
      rot: rand() * Math.PI * 2,
      scale: 0.85 + rand() * 0.25,
      swayPhase: rand() * Math.PI * 2,
    });
  });
  bushCells.forEach(([gx, gz]) => {
    out.push({
      kind: "bush", gx, gz,
      rot: rand() * Math.PI * 2,
      scale: 0.65 + rand() * 0.25,
      swayPhase: rand() * Math.PI * 2,
    });
  });
  rockCells.forEach(([gx, gz], i) => {
    out.push({
      kind: i % 2 === 0 ? "rock1" : "rock2",
      gx, gz,
      rot: rand() * Math.PI * 2,
      scale: 0.55 + rand() * 0.35,
      swayPhase: 0,
    });
  });
  grassCells.forEach(([gx, gz]) => {
    out.push({
      kind: "grass", gx, gz,
      rot: rand() * Math.PI * 2,
      scale: 0.7 + rand() * 0.3,
      swayPhase: rand() * Math.PI * 2,
    });
  });
  return out;
}

const TREE_SWAY_AMP = 0.012;     // ~0.7° (spec: 0.5-1°)
const TREE_SWAY_PERIOD = 3.4;    // seconds (spec: 3-4s)
const BUSH_SWAY_AMP = 0.018;
const BUSH_SWAY_PERIOD = 2.0;
const GRASS_SWAY_AMP = 0.05;
const GRASS_SWAY_PERIOD = 1.8;

// Y offset puts the prop ON TOP of the tile box (which sits at y=0.10
// top). Trees sit slightly LOWER so the trunk's modeled "dirt" base
// sinks under the tile surface.
const PROP_Y = 0.10;
const TREE_Y = -0.10;

function PlacedProp({ placement, model }: { placement: Placement; model: THREE.Group }) {
  const groupRef = useRef<THREE.Group>(null);
  const w = gridToWorld(placement.gx, placement.gz);

  // Per-instance deep clone — clones the scene graph AND each material
  // so we can fade individual trees independently (TreeFader).
  const ownModel = useMemo(() => {
    const c = model.clone(true);
    c.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = m.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) {
        m.material = mat.map((x) => x.clone());
        m.material.forEach((x) => { (x as THREE.Material).transparent = true; });
      } else {
        m.material = mat.clone();
        (m.material as THREE.Material).transparent = true;
      }
    });
    return c;
  }, [model]);

  // Trees are large enough to block the camera. Register their root
  // group with the occluder system so TreeFader can dim them on demand.
  useEffect(() => {
    if (placement.kind !== "tree") return;
    if (!groupRef.current) return;
    return registerOccluder(groupRef.current);
  }, [placement.kind]);

  // Tree / bush / rock tiles can't be hopped onto — register the cell
  // as blocked so avatars bump back instead of landing through the prop.
  useEffect(() => {
    if (placement.kind === "grass") return;
    setTileBlocked(placement.gx, placement.gz, true);
    return () => setTileBlocked(placement.gx, placement.gz, false);
  }, [placement.gx, placement.gz, placement.kind]);

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    if (placement.kind === "tree") {
      const phase = clock.getElapsedTime() / TREE_SWAY_PERIOD * Math.PI * 2 + placement.swayPhase;
      groupRef.current.rotation.z = Math.sin(phase) * TREE_SWAY_AMP;
    } else if (placement.kind === "bush") {
      const phase = clock.getElapsedTime() / BUSH_SWAY_PERIOD * Math.PI * 2 + placement.swayPhase;
      groupRef.current.rotation.z = Math.sin(phase) * BUSH_SWAY_AMP;
    } else if (placement.kind === "grass") {
      const phase = clock.getElapsedTime() / GRASS_SWAY_PERIOD * Math.PI * 2 + placement.swayPhase;
      groupRef.current.rotation.z = Math.sin(phase) * GRASS_SWAY_AMP;
    }
  });

  const yOff = placement.kind === "tree" ? TREE_Y : PROP_Y;
  return (
    <group ref={groupRef} position={[w.x, yOff, w.z]} rotation={[0, placement.rot, 0]} scale={placement.scale}>
      <primitive object={ownModel} />
    </group>
  );
}

export function Nature() {
  const tree = useToonAsset(TREE_ASSET);
  const bush = useToonAsset(BUSH_ASSET);
  const rock1 = useToonAsset(ROCK1_ASSET);
  const rock2 = useToonAsset(ROCK2_ASSET);
  const grass = useToonAsset(GRASS_ASSET);

  const placements = useMemo(() => buildPlacements(), []);

  function modelFor(kind: Placement["kind"]): THREE.Group {
    switch (kind) {
      case "tree": return tree;
      case "bush": return bush;
      case "rock1": return rock1;
      case "rock2": return rock2;
      case "grass": return grass;
    }
  }

  return (
    <group>
      {placements.map((p, i) => (
        <PlacedProp key={i} placement={p} model={modelFor(p.kind)} />
      ))}
    </group>
  );
}

// Avoid unused GRID_PITCH import warning while keeping the export available
// for any future grid-aware spawning logic.
void GRID_PITCH;

useGLTF.preload(TREE_ASSET);
useGLTF.preload(BUSH_ASSET);
useGLTF.preload(ROCK1_ASSET);
useGLTF.preload(ROCK2_ASSET);
useGLTF.preload(GRASS_ASSET);
