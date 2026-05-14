import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { useFrame, ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";

// Pool of N expanding ring sprites lying flat on the water. spawn(x, z)
// recycles the oldest slot. Each ripple expands from r≈0 to r≈3 over
// ~1.8s while fading; lives entirely in ref-land so spawn() never
// re-renders the React tree.

const POOL_SIZE = 16;
const LIFETIME = 1.8;        // seconds
const MAX_RADIUS = 3.0;      // world units at end of life
const START_OPACITY = 0.55;
const Y_OFFSET = 0.015;      // sit just above the water plane

export type RippleHandle = { spawn: (x: number, z: number) => void };

type RippleSlot = {
  group: THREE.Group;
  inner: THREE.Mesh;
  outer: THREE.Mesh;
  birth: number;  // performance.now()/1000, -1 if dormant
};

export const Ripples = forwardRef<RippleHandle>(function Ripples(_, ref) {
  const groupRef = useRef<THREE.Group>(null);
  const slotsRef = useRef<RippleSlot[]>([]);
  const nextRef = useRef(0);

  // Shared geometry/material — two concentric thin rings give that
  // double-pulse look without a custom shader.
  // Thin ring — at full expansion (scale ≈ 3) the ring stays delicate.
  // Width 0.04 here × scale 3 = 0.12 world units. Tweak this not scale.
  const ringGeo = useMemo(() => new THREE.RingGeometry(0.96, 1.0, 48), []);
  const innerMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: 0xfff5e0,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );
  const outerMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: 0xffe0a0,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );

  useImperativeHandle(ref, () => ({
    spawn(x: number, z: number) {
      const slots = slotsRef.current;
      const idx = nextRef.current % POOL_SIZE;
      nextRef.current += 1;
      const slot = slots[idx];
      if (!slot) return;
      slot.group.position.set(x, Y_OFFSET, z);
      slot.group.visible = true;
      slot.birth = performance.now() / 1000;
    },
  }));

  useFrame(() => {
    const now = performance.now() / 1000;
    for (const slot of slotsRef.current) {
      if (slot.birth < 0) continue;
      const age = now - slot.birth;
      if (age >= LIFETIME) {
        slot.group.visible = false;
        slot.birth = -1;
        continue;
      }
      const u = age / LIFETIME;
      // Ease-out cubic — fast expand, slow fade.
      const eased = 1 - Math.pow(1 - u, 3);
      const r = eased * MAX_RADIUS;
      const opacity = (1 - u) * START_OPACITY;
      slot.outer.scale.setScalar(r);
      // Inner ring trails slightly behind for double-pulse readout.
      const innerR = Math.max(0.01, (r - 0.45));
      slot.inner.scale.setScalar(innerR);
      (slot.outer.material as THREE.MeshBasicMaterial).opacity = opacity;
      (slot.inner.material as THREE.MeshBasicMaterial).opacity = opacity * 0.7;
    }
  });

  return (
    <group ref={groupRef}>
      {Array.from({ length: POOL_SIZE }).map((_, i) => (
        <SlotMesh
          key={i}
          index={i}
          ringGeo={ringGeo}
          innerMat={innerMat}
          outerMat={outerMat}
          slotsRef={slotsRef}
        />
      ))}
    </group>
  );
});

function SlotMesh({
  index,
  ringGeo,
  innerMat,
  outerMat,
  slotsRef,
}: {
  index: number;
  ringGeo: THREE.RingGeometry;
  innerMat: THREE.MeshBasicMaterial;
  outerMat: THREE.MeshBasicMaterial;
  slotsRef: React.MutableRefObject<RippleSlot[]>;
}) {
  const groupRef = useRef<THREE.Group | null>(null);
  const innerRef = useRef<THREE.Mesh | null>(null);
  const outerRef = useRef<THREE.Mesh | null>(null);

  return (
    <group
      ref={(g) => {
        groupRef.current = g;
        if (g && innerRef.current && outerRef.current) {
          slotsRef.current[index] = {
            group: g,
            inner: innerRef.current,
            outer: outerRef.current,
            birth: -1,
          };
          g.visible = false;
        }
      }}
      rotation-x={-Math.PI / 2}
    >
      <mesh ref={outerRef} geometry={ringGeo} material={outerMat} />
      <mesh ref={innerRef} geometry={ringGeo} material={innerMat} />
    </group>
  );
}

// Invisible plane at water level — receives clicks and forwards the
// world-space hit point to the ripple pool. visible=true but writes
// nothing to color/depth so it's pure interaction surface.
export function RippleClickPlane({
  onHit,
}: {
  onHit: (x: number, z: number) => void;
}) {
  return (
    <mesh
      position-y={0.005}
      rotation-x={-Math.PI / 2}
      onPointerDown={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        onHit(e.point.x, e.point.z);
      }}
    >
      <planeGeometry args={[220, 220]} />
      <meshBasicMaterial
        colorWrite={false}
        depthWrite={false}
        transparent
        opacity={0}
      />
    </mesh>
  );
}
