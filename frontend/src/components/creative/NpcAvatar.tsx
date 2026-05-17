import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  fireLanding,
  gridToWorld,
  isTileBlocked,
  isTileSolid,
  tileWithin,
} from "./useDanielControls";
import { fireVfx } from "./vfx";
import { GLTFGooni, type GooniHandle } from "./GLTFGooni";
import { Nametag } from "./Nametag";
import {
  clearOccupant,
  occupantCount,
  setOccupant,
  stackLevelOf,
  stackYOf,
  topOfStack,
  STACK_OFFSET,
  type OccupantId,
} from "./occupants";

// Autonomous NPC — same character + tile-physics as Daniel, no user
// input. Picks a random adjacent direction every 1.8–3.2s, hops there.
// Can fall off, gets sky-respawned exactly like Daniel. Tile-break
// events fire so NPCs and player share the same plaza.

type NpcPhase =
  | "idle" | "hopping" | "settling"
  | "falling" | "respawning" | "lying" | "getting-up";

type NpcProps = {
  startGx: number;
  startGz: number;
  bodyColor: string;
  headColor?: string;
  accentColor?: string;
  hopMinMs?: number;
  hopMaxMs?: number;
  initialDelayMs?: number;
  name: string;
  showNametag: boolean;
};

const HOP_DUR = 0.42;          // slightly slower than Daniel
const HOP_HEIGHT = 0.95;
const SETTLE_DUR = 0.18;
const FALL_DUR = 1.0;
const FALL_DROP = 14;
const SKY_RESPAWN_DUR = 1.0;
const SKY_HEIGHT = 13;
const LYING_REST_DUR = 0.35;

const NPC_DELTAS: Array<{ dx: number; dz: number }> = [
  { dx: 0,  dz: -1 },
  { dx: 0,  dz:  1 },
  { dx: -1, dz:  0 },
  { dx: 1,  dz:  0 },
];

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

function squashLifecycle(u: number): { sy: number; sxz: number } {
  if (u < 0.10) {
    const k = u / 0.10;
    return { sy: 0.85 + (1.10 - 0.85) * easeOutCubic(k), sxz: 1.0 };
  }
  if (u > 0.90) {
    const k = (u - 0.90) / 0.10;
    return { sy: 1.05 - (1.05 - 0.80) * k, sxz: 0.95 + 0.05 * k };
  }
  return { sy: 1.05, sxz: 0.95 };
}

function settleScaleY(u: number): number {
  if (u < 0.5) {
    const k = u / 0.5;
    return 0.80 + (1.05 - 0.80) * easeOutCubic(k);
  }
  const k = (u - 0.5) / 0.5;
  return 1.05 - 0.05 * easeOutCubic(k);
}

export function NpcAvatar({
  startGx,
  startGz,
  bodyColor,
  headColor,
  accentColor,
  hopMinMs = 1800,
  hopMaxMs = 3200,
  initialDelayMs = 1500,
  name,
  showNametag,
}: NpcProps) {
  const rootRef = useRef<THREE.Group | null>(null);
  const innerRef = useRef<THREE.Group | null>(null);
  const gltfRef = useRef<GooniHandle | null>(null);

  const phaseRef = useRef<NpcPhase>("idle");
  const lastClipRef = useRef<string | null>(null);

  const gridRef = useRef({ gx: startGx, gz: startGz });
  const lastSafeRef = useRef({ gx: startGx, gz: startGz });
  const headingRef = useRef(0);

  const hopRef = useRef<{
    active: boolean; t: number;
    fromX: number; fromZ: number; toX: number; toZ: number;
    fromY: number; toY: number;
    toGx: number; toGz: number; fromGx: number; fromGz: number;
    facing: number;
    breaksTile: boolean;
  }>({ active: false, t: 0, fromX: 0, fromZ: 0, toX: 0, toZ: 0, fromY: 0, toY: 0, toGx: 0, toGz: 0, fromGx: 0, fromGz: 0, facing: 0, breaksTile: true });
  const fallRef = useRef({ active: false, t: 0, startX: 0, startZ: 0 });
  const respawnRef = useRef({ active: false, t: 0 });
  const settleRef = useRef({ active: false, t: 0 });
  const lyingRestRef = useRef(-1);
  const nextHopAtRef = useRef(performance.now() + initialDelayMs);

  const idRef = useRef<OccupantId>(`npc-${Math.random().toString(36).slice(2)}`);
  const displayStackYRef = useRef(0);

  useEffect(() => {
    const myId = idRef.current;
    setOccupant(myId, startGx, startGz);
    return () => clearOccupant(myId);
  }, [startGx, startGz]);

  function setClipIfChanged(name: string, opts?: { loop?: boolean; timeScale?: number; fadeMs?: number }) {
    if (lastClipRef.current === name) return;
    lastClipRef.current = name;
    gltfRef.current?.setClip(name as never, opts);
  }

  // Place at initial position so first paint is correct.
  useMemo(() => {
    const w = gridToWorld(startGx, startGz);
    return { initialPos: new THREE.Vector3(w.x, 0, w.z) };
  }, [startGx, startGz]);

  useFrame((_, rawDt) => {
    const root = rootRef.current;
    const inner = innerRef.current;
    if (!root || !inner) return;
    const dt = Math.min(rawDt, 0.05);
    const phase = phaseRef.current;

    // Clip driver
    if (phase === "lying" || phase === "getting-up") {
      if (lastClipRef.current !== null) {
        gltfRef.current?.stopAll();
        lastClipRef.current = null;
      }
    } else if (phase === "idle" || phase === "settling" || phase === "respawning") {
      setClipIfChanged("Idle", { loop: true, fadeMs: 200 });
    } else if (phase === "hopping") {
      setClipIfChanged("Jump", { loop: false, timeScale: 1.3, fadeMs: 80 });
    } else if (phase === "falling") {
      setClipIfChanged("HitReact", { loop: false, fadeMs: 80 });
    }

    // ── Sky-respawn drop (face-flat).
    if (respawnRef.current.active) {
      respawnRef.current.t += dt;
      const u = Math.min(1, respawnRef.current.t / SKY_RESPAWN_DUR);
      const eased = u * u;
      const y = SKY_HEIGHT * (1 - eased) + 0.05;
      const w = gridToWorld(0, 0);
      root.position.set(w.x, y, w.z);
      inner.rotation.set(-Math.PI / 2, 0, 0);
      inner.scale.set(1, 1, 1);
      if (u >= 1) {
        respawnRef.current.active = false;
        phaseRef.current = "lying";
        lyingRestRef.current = 0;
        setOccupant(idRef.current, 0, 0);
        fireVfx({ kind: "puff", world: { x: w.x, y: 0.15, z: w.z }, intensity: 0.8 });
      }
      return;
    }

    // ── Fall-off the world
    if (fallRef.current.active) {
      fallRef.current.t += dt;
      const f = fallRef.current;
      const u = Math.min(1, f.t / FALL_DUR);
      const eased = u * u;
      const y = 0 - FALL_DROP * eased;
      const shrink = 1 - 0.55 * u;
      root.position.set(f.startX, y, f.startZ);
      inner.rotation.set(u * 5, headingRef.current + u * 3, u * 2);
      inner.scale.set(shrink, shrink, shrink);
      if (u >= 1) {
        fallRef.current.active = false;
        gridRef.current = { gx: 0, gz: 0 };
        lastSafeRef.current = { gx: 0, gz: 0 };
        respawnRef.current.active = true;
        respawnRef.current.t = 0;
        phaseRef.current = "respawning";
      }
      return;
    }

    // ── Lying (post-respawn pause then auto-get-up)
    if (phase === "lying") {
      const w = gridToWorld(0, 0);
      root.position.set(w.x, 0.05, w.z);
      inner.rotation.set(-Math.PI / 2, 0, 0);
      inner.scale.set(1, 1, 1);
      if (lyingRestRef.current >= 0) {
        lyingRestRef.current += dt;
        if (lyingRestRef.current >= LYING_REST_DUR) {
          phaseRef.current = "getting-up";
          lyingRestRef.current = -1;
          // Simple instant stand for NPC — skip the keyframe roll-up so
          // their respawn loop is short. (Could call the same sampleGetUp
          // logic later if we want them to perform the full animation.)
          // Re-spawn the schedule for the next autonomous hop.
          nextHopAtRef.current = performance.now() + 800;
          phaseRef.current = "idle";
        }
      }
      return;
    }

    // ── Settle (post-land elastic)
    if (settleRef.current.active) {
      settleRef.current.t += dt;
      const u = Math.min(1, settleRef.current.t / SETTLE_DUR);
      const sy = settleScaleY(u);
      const w = gridToWorld(gridRef.current.gx, gridRef.current.gz);
      const targetStackY = stackYOf(idRef.current, gridRef.current.gx, gridRef.current.gz);
      displayStackYRef.current += (targetStackY - displayStackYRef.current) * Math.min(1, dt * 6);
      root.position.set(w.x, displayStackYRef.current, w.z);
      inner.rotation.set(0, headingRef.current, 0);
      inner.scale.set(1, sy, 1);
      if (u >= 1) {
        settleRef.current.active = false;
        phaseRef.current = "idle";
      }
      return;
    }

    // ── Hop driver — greedy random pick (won't deliberately leap off
    // into the void). Filters NPC_DELTAS to neighbors that are still
    // solid tiles. If nothing safe is reachable, sit and re-check.
    const h = hopRef.current;
    if (!h.active && phase === "idle") {
      const now = performance.now();
      if (now >= nextHopAtRef.current) {
        const fromGx = gridRef.current.gx;
        const fromGz = gridRef.current.gz;
        const safe = NPC_DELTAS.filter((d) =>
          tileWithin(fromGx + d.dx, fromGz + d.dz) &&
          isTileSolid(fromGx + d.dx, fromGz + d.dz) &&
          !isTileBlocked(fromGx + d.dx, fromGz + d.dz),
        );
        if (safe.length === 0) {
          // No safe neighbor — wait briefly and re-check (tiles heal).
          nextHopAtRef.current = now + 600;
        } else {
          const d = safe[Math.floor(Math.random() * safe.length)];
          const toGx = fromGx + d.dx;
          const toGz = fromGz + d.dz;
          const fromW = gridToWorld(fromGx, fromGz);
          const toW = gridToWorld(toGx, toGz);
          const myId = idRef.current;
          const fromLevel = stackLevelOf(myId, fromGx, fromGz);
          const fromY = fromLevel * STACK_OFFSET;
          const toY = topOfStack(toGx, toGz) * STACK_OFFSET;
          const alone = occupantCount(fromGx, fromGz) <= 1;
          h.active = true;
          h.t = 0;
          h.fromX = fromW.x;
          h.fromZ = fromW.z;
          h.toX = toW.x;
          h.toZ = toW.z;
          h.fromY = fromY;
          h.toY = toY;
          h.toGx = toGx;
          h.toGz = toGz;
          h.fromGx = fromGx;
          h.fromGz = fromGz;
          h.facing = Math.atan2(d.dx, d.dz);
          h.breaksTile = alone;
          clearOccupant(myId);
          phaseRef.current = "hopping";
          fireVfx({
            kind: "puff",
            world: { x: fromW.x, y: 0.05 + fromY, z: fromW.z },
            intensity: 0.5,
          });
          nextHopAtRef.current = now + hopMinMs + Math.random() * (hopMaxMs - hopMinMs);
        }
      }
    }

    if (h.active) {
      h.t += dt;
      const u = Math.min(1, h.t / HOP_DUR);
      const x = h.fromX + (h.toX - h.fromX) * u;
      const z = h.fromZ + (h.toZ - h.fromZ) * u;
      const baseY = h.fromY + (h.toY - h.fromY) * u;
      const y = baseY + Math.sin(Math.PI * u) * HOP_HEIGHT;

      let dh = h.facing - headingRef.current;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      headingRef.current += dh * Math.min(1, dt * 14);

      const { sy, sxz } = squashLifecycle(u);
      root.position.set(x, y, z);
      inner.rotation.set(0, headingRef.current, 0);
      inner.scale.set(sxz, sy, sxz);

      if (u >= 1) {
        h.active = false;
        const within = tileWithin(h.toGx, h.toGz);
        const solid = isTileSolid(h.toGx, h.toGz);
        if (!within || !solid) {
          fallRef.current.active = true;
          fallRef.current.t = 0;
          fallRef.current.startX = h.toX;
          fallRef.current.startZ = h.toZ;
          phaseRef.current = "falling";
          fireLanding({
            gx: h.toGx, gz: h.toGz,
            world: { x: h.toX, z: h.toZ },
            from: { gx: h.fromGx, gz: h.fromGz },
            fellOff: true,
            impactVel: 0,
            breaksTile: h.breaksTile,
            actor: "npc",
          });
        } else {
          gridRef.current = { gx: h.toGx, gz: h.toGz };
          lastSafeRef.current = { gx: h.toGx, gz: h.toGz };
          setOccupant(idRef.current, h.toGx, h.toGz);
          displayStackYRef.current = h.toY;
          phaseRef.current = "settling";
          settleRef.current.active = true;
          settleRef.current.t = 0;
          fireLanding({
            gx: h.toGx, gz: h.toGz,
            world: { x: h.toX, z: h.toZ },
            from: { gx: h.fromGx, gz: h.fromGz },
            fellOff: false,
            impactVel: HOP_HEIGHT * 6,
            breaksTile: h.breaksTile,
            actor: "npc",
          });
          fireVfx({
            kind: "dust",
            world: { x: h.toX, y: 0.05 + h.toY, z: h.toZ },
            intensity: 0.6,
          });
        }
      }
      return;
    }

    // ── Idle bob (stack-aware Y, smoothed)
    const idleT = performance.now() / 1000;
    const bob = Math.sin(idleT * 1.7) * 0.012;
    const w = gridToWorld(gridRef.current.gx, gridRef.current.gz);
    const targetStackY = stackYOf(idRef.current, gridRef.current.gx, gridRef.current.gz);
    displayStackYRef.current += (targetStackY - displayStackYRef.current) * Math.min(1, dt * 6);
    root.position.set(w.x, displayStackYRef.current + bob, w.z);
    inner.rotation.set(0, headingRef.current, 0);
    inner.scale.set(1, 1, 1);
  });

  const w0 = gridToWorld(startGx, startGz);
  return (
    <group ref={rootRef} position={[w0.x, 0, w0.z]}>
      <mesh position-y={0.02} rotation-x={-Math.PI / 2}>
        <circleGeometry args={[0.32, 24]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.26} depthWrite={false} />
      </mesh>
      <group ref={innerRef}>
        <GLTFGooni
          ref={gltfRef}
          bodyColor={bodyColor}
          headColor={headColor}
          accentColor={accentColor}
        />
      </group>
      {showNametag && <Nametag name={name} />}
    </group>
  );
}
