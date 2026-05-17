import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { subscribeVfx, type VfxEvent } from "./vfx";

// Single InstancedMesh pool for all VFX particles (dust on land, debris
// on tile break, puff on takeoff). Each slot has pos/vel/life. useFrame
// integrates gravity + drag, scales + fades per particle. Recycled
// round-robin.

const POOL_SIZE = 80;
const GRAVITY = 9;
const DRAG = 1.2;

type Particle = {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;             // seconds since spawn
  ttl: number;              // total lifetime
  startScale: number;
  color: THREE.Color;
};

function spawnFromEvent(particles: Particle[], nextRef: { current: number }, e: VfxEvent) {
  const count = Math.floor((e.kind === "puff" ? 4 : 7) * (0.7 + e.intensity * 0.6));
  const baseColor = e.color
    ? new THREE.Color(e.color.r, e.color.g, e.color.b)
    : e.kind === "dust" ? new THREE.Color("#c19a6e")
    : e.kind === "debris" ? new THREE.Color("#d4c49a")
    : new THREE.Color("#fff4d6");                                  // puff
  const startScale = e.kind === "puff" ? 0.12 : 0.10;
  const ttl = e.kind === "puff" ? 0.35 : 0.55;
  for (let i = 0; i < count; i++) {
    const idx = nextRef.current % POOL_SIZE;
    nextRef.current += 1;
    const p = particles[idx];
    if (!p) continue;
    p.active = true;
    p.life = 0;
    p.ttl = ttl + (Math.random() - 0.5) * 0.12;
    p.startScale = startScale + Math.random() * 0.05;
    p.color.copy(baseColor);
    // Spawn near event world position, radiating outward + slight up
    const angle = Math.random() * Math.PI * 2;
    const speed = 1.6 + Math.random() * 1.8;
    const upBias = e.kind === "puff" ? 1.6 : 1.0;
    p.pos.set(
      e.world.x + Math.cos(angle) * 0.05,
      e.world.y + 0.06,
      e.world.z + Math.sin(angle) * 0.05,
    );
    p.vel.set(
      Math.cos(angle) * speed,
      (0.5 + Math.random() * 0.8) * upBias,
      Math.sin(angle) * speed,
    );
  }
}

export function Particles() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const particlesRef = useRef<Particle[]>([]);
  const nextRef = useRef(0);

  useLayoutEffect(() => {
    particlesRef.current = Array.from({ length: POOL_SIZE }, () => ({
      active: false,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      life: 0,
      ttl: 1,
      startScale: 0.1,
      color: new THREE.Color(),
    }));
    // Hide all slots initially
    const mesh = meshRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    for (let i = 0; i < POOL_SIZE; i++) {
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, []);

  useEffect(() => {
    return subscribeVfx((e) => spawnFromEvent(particlesRef.current, nextRef, e));
  }, []);

  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame((_, rawDt) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dt = Math.min(rawDt, 0.05);

    for (let i = 0; i < particlesRef.current.length; i++) {
      const p = particlesRef.current[i];
      if (!p) continue;
      if (!p.active) continue;

      p.life += dt;
      if (p.life >= p.ttl) {
        p.active = false;
        dummy.scale.setScalar(0);
        dummy.position.set(0, -100, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, new THREE.Color("#000000"));
        continue;
      }

      // Physics — drag + gravity
      p.vel.y -= GRAVITY * dt;
      const dragFactor = Math.exp(-DRAG * dt);
      p.vel.x *= dragFactor;
      p.vel.z *= dragFactor;
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      p.pos.z += p.vel.z * dt;

      // Bounce off ground (low, weak)
      if (p.pos.y < 0.02 && p.vel.y < 0) {
        p.pos.y = 0.02;
        p.vel.y *= -0.25;
      }

      const u = p.life / p.ttl;
      const scale = p.startScale * (1 - u * 0.6);
      dummy.position.copy(p.pos);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, p.color);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, POOL_SIZE]}
      castShadow={false}
      receiveShadow={false}
    >
      <sphereGeometry args={[1, 6, 5]} />
      <meshBasicMaterial color="#ffffff" transparent opacity={0.95} depthWrite={false} />
    </instancedMesh>
  );
}
