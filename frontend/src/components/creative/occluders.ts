import type * as THREE from "three";

// Module-level registry of "occluders" — large props that can block
// the camera's view of the player character (mainly trees). The
// TreeFader component raycasts each frame and dims any occluder in
// the way.

const occluders = new Set<THREE.Object3D>();

export function registerOccluder(o: THREE.Object3D): () => void {
  occluders.add(o);
  return () => {
    occluders.delete(o);
  };
}

export function getOccluders(): THREE.Object3D[] {
  return Array.from(occluders);
}

export function isOccluder(o: THREE.Object3D): boolean {
  return occluders.has(o);
}
