import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";

// Soft shore ring — stylized stones + grass tufts seated at the fog
// fade line. Closes off the "infinite disc" feel without breaking the
// illusion of a wider world beyond the haze.

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

function StoneRing({ count, innerR, outerR, seed }: {
  count: number;
  innerR: number;
  outerR: number;
  seed: number;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const transforms = useMemo(() => {
    const rand = mulberry32(seed);
    const out: { m: THREE.Matrix4; c: THREE.Color }[] = [];
    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.12;
      const r = innerR + rand() * (outerR - innerR);
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      const sx = 0.7 + rand() * 1.6;
      const sy = 0.4 + rand() * 0.6;
      const sz = 0.7 + rand() * 1.6;
      dummy.position.set(x, sy * 0.5 - 0.05, z);
      dummy.rotation.set(rand() * 0.4, rand() * Math.PI * 2, rand() * 0.4);
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();
      const m = dummy.matrix.clone();
      // Slate-greys w/ slight warm bias; per-stone hue jitter.
      const c = new THREE.Color().setHSL(
        0.07 + rand() * 0.04,
        0.06 + rand() * 0.08,
        0.30 + rand() * 0.14,
      );
      out.push({ m, c });
    }
    return out;
  }, [count, innerR, outerR, seed]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    transforms.forEach((t, i) => {
      mesh.setMatrixAt(i, t.m);
      mesh.setColorAt(i, t.c);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [transforms]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]} castShadow receiveShadow>
      {/* Low-poly stone — icosahedron at detail 0 = 20 faces, faceted look. */}
      <icosahedronGeometry args={[0.7, 0]} />
      <meshStandardMaterial color="#ffffff" roughness={0.95} metalness={0.04} />
    </instancedMesh>
  );
}

function GrassTufts({ count, innerR, outerR, seed }: {
  count: number;
  innerR: number;
  outerR: number;
  seed: number;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const transforms = useMemo(() => {
    const rand = mulberry32(seed);
    const out: { m: THREE.Matrix4; c: THREE.Color }[] = [];
    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const angle = rand() * Math.PI * 2;
      const r = innerR + rand() * (outerR - innerR);
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      const h = 0.6 + rand() * 0.8;
      dummy.position.set(x, h * 0.5 - 0.05, z);
      dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      dummy.scale.set(0.45 + rand() * 0.4, h, 0.45 + rand() * 0.4);
      dummy.updateMatrix();
      const c = new THREE.Color().setHSL(
        0.27 + rand() * 0.06,
        0.45 + rand() * 0.2,
        0.20 + rand() * 0.12,
      );
      out.push({ m: dummy.matrix.clone(), c });
    }
    return out;
  }, [count, innerR, outerR, seed]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    transforms.forEach((t, i) => {
      mesh.setMatrixAt(i, t.m);
      mesh.setColorAt(i, t.c);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [transforms]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]} castShadow>
      {/* Tall thin cone reads as a tuft of reed/grass at this distance. */}
      <coneGeometry args={[0.3, 1, 6, 1, false]} />
      <meshStandardMaterial color="#ffffff" roughness={0.95} />
    </instancedMesh>
  );
}

type Props = { mobile: boolean };

export function Shore({ mobile }: Props) {
  return (
    <group>
      <StoneRing
        count={mobile ? 28 : 56}
        innerR={45}
        outerR={56}
        seed={0xb04a17}
      />
      <GrassTufts
        count={mobile ? 24 : 64}
        innerR={44}
        outerR={58}
        seed={0x9a73c2}
      />
    </group>
  );
}
