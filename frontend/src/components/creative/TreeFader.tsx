import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { getOccluders } from "./occluders";
import type { DanielHandle } from "./DanielAvatar";

// Each frame, raycast from the camera to the player's world position.
// Any tree (or other registered occluder) the ray intersects fades
// toward 0.25 opacity; trees out of the way restore to 1.0. Fade is
// time-lerped so the transition is smooth.

type Props = {
  targetRef: React.MutableRefObject<DanielHandle | null>;
};

const FADE_DOWN = 0.25;          // opacity when blocking camera
const FADE_UP = 1.00;
const LERP_RATE = 6.0;           // higher = snappier fade

export function TreeFader({ targetRef }: Props) {
  const { camera } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const dirRef = useRef(new THREE.Vector3());
  const targetPosRef = useRef(new THREE.Vector3());
  // Per-occluder current opacity. Map keyed by Object3D ref.
  const opacityState = useRef<WeakMap<THREE.Object3D, number>>(new WeakMap());

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const occluders = getOccluders();
    if (occluders.length === 0) return;

    const target = targetRef.current?.group;
    if (!target) return;

    target.getWorldPosition(targetPosRef.current);
    dirRef.current.subVectors(targetPosRef.current, camera.position);
    const dist = dirRef.current.length();
    if (dist < 0.001) return;
    dirRef.current.normalize();
    raycaster.set(camera.position, dirRef.current);
    raycaster.far = dist;

    // Build a Set of occluder roots that are currently blocking.
    const hits = raycaster.intersectObjects(occluders, true);
    const blocking = new Set<THREE.Object3D>();
    const occluderSet = new Set(occluders);
    hits.forEach((h) => {
      let node: THREE.Object3D | null = h.object;
      while (node && !occluderSet.has(node)) {
        node = node.parent;
      }
      if (node) blocking.add(node);
    });

    // Lerp + apply per occluder.
    for (const occ of occluders) {
      const desired = blocking.has(occ) ? FADE_DOWN : FADE_UP;
      const prev = opacityState.current.get(occ) ?? FADE_UP;
      const next = prev + (desired - prev) * Math.min(1, dt * LERP_RATE);
      opacityState.current.set(occ, next);
      occ.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (!mat) return;
        if (Array.isArray(mat)) {
          mat.forEach((m) => { (m as THREE.MeshToonMaterial).opacity = next; });
        } else {
          (mat as THREE.MeshToonMaterial).opacity = next;
        }
      });
    }
  });

  return null;
}
