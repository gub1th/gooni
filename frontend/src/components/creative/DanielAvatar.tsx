import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  consumeQueuedHop,
  deltaForSnap,
  fireLanding,
  gridToWorld,
  isTileBlocked,
  isTileSolid,
  recordPlayerSpawn,
  tileWithin,
} from "./useDanielControls";
import { playJumpGrunt, playLandThud, playFallOff, playInvalidMove } from "./sfx";
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

// Daniel — GLTF-backed Gooni character (Quaternius humanoid). Phase
// machine + hop physics drive the ROOT group transform; baked anims on
// the GLTF skin drive bone-level motion (Idle/Jump/HitReact).

export type DanielHandle = {
  group: THREE.Group | null;
  worldPos: () => THREE.Vector3;
  phase: () => DanielPhase;
  heading: () => number;
  isHopping: () => boolean;
};

export type DanielPhase =
  | "lying" | "getting-up"
  | "idle" | "hopping" | "settling" | "falling" | "respawning";

type Props = {
  active: boolean;
  introTrigger: boolean;
  controllable: boolean;
  onIntroComplete: () => void;
  name: string;
  bodyColor: string;
  showNametag: boolean;
  flag?: string | null;
};

// Single continuous keyframe-driven get-up. Each KF specifies the
// root transform at a moment in time; values between KFs are blended
// via smoothstep, so the motion is C1-continuous (no reset glitches
// at phase boundaries). Total ~2.3s.
type GetUpKF = {
  t: number;
  rotX: number;
  rotZ: number;
  posY: number;
  scaleY: number;
};

const GETUP_KFS: GetUpKF[] = [
  // Lying flat on back
  { t: 0.00, rotX: -Math.PI / 2,  rotZ:  0.00, posY: 0.05, scaleY: 1.00 },
  // Rolled onto side
  { t: 0.55, rotX: -Math.PI / 2.4, rotZ: -0.45, posY: 0.06, scaleY: 0.92 },
  // Pushing upper body up on one arm
  { t: 1.10, rotX: -Math.PI / 4,   rotZ: -0.32, posY: 0.10, scaleY: 0.90 },
  // Hips coming under, nearly upright
  { t: 1.55, rotX: -Math.PI / 10,  rotZ: -0.12, posY: 0.12, scaleY: 0.95 },
  // Standing with a tiny overshoot
  { t: 1.90, rotX:  0.00,          rotZ:  0.02, posY: 0.04, scaleY: 1.03 },
  // Head shake-off
  { t: 2.10, rotX:  0.00,          rotZ: -0.02, posY: 0.01, scaleY: 1.00 },
  // Fully settled
  { t: 2.30, rotX:  0.00,          rotZ:  0.00, posY: 0.00, scaleY: 1.00 },
];
const GETUP_END = GETUP_KFS[GETUP_KFS.length - 1].t;

function sampleGetUp(t: number): GetUpKF {
  if (t <= GETUP_KFS[0].t) return GETUP_KFS[0];
  if (t >= GETUP_END) return GETUP_KFS[GETUP_KFS.length - 1];
  for (let i = 0; i < GETUP_KFS.length - 1; i++) {
    const a = GETUP_KFS[i];
    const b = GETUP_KFS[i + 1];
    if (t >= a.t && t < b.t) {
      const u = (t - a.t) / (b.t - a.t);
      const e = u * u * (3 - 2 * u);   // smoothstep
      return {
        t,
        rotX: a.rotX + (b.rotX - a.rotX) * e,
        rotZ: a.rotZ + (b.rotZ - a.rotZ) * e,
        posY: a.posY + (b.posY - a.posY) * e,
        scaleY: a.scaleY + (b.scaleY - a.scaleY) * e,
      };
    }
  }
  return GETUP_KFS[GETUP_KFS.length - 1];
}

const HOP_DUR = 0.36;
// Char is scaled 0.5x (≈0.85 tall) — spec 1.5x height → ~1.3 apex.
const HOP_HEIGHT = 1.1;
const SETTLE_DUR = 0.15;
// Bump animation when trying to hop onto a prop tile: forward a little,
// bounce back, no tile break.
const BUMP_DUR = 0.42;
const BUMP_REACH = 0.40;     // fraction of pitch the char travels forward
const BUMP_ARC = 0.30;       // peak height of the abortive hop arc
const FALL_DUR = 1.0;
const FALL_DROP = 14;
// Sky respawn — char reappears above plaza center, face-flat, gravity-
// falls back to the lying pose. Avoids the black-screen fade.
const SKY_RESPAWN_DUR = 0.95;
const SKY_HEIGHT = 13;
const LYING_REST_DUR = 0.30;     // pause on back after landing before get-up
const INVULN_DUR = 0.5;

// Spec squash-stretch:
//   Takeoff (u<0.10):    scaleY  0.85 → 1.10  (anticipation pop)
//   Apex    (0.10..0.90): scaleY 1.05, scaleXZ 0.95
//   Land    (u>0.90):    scaleY  1.05 → 0.80  (impact squash)
// Post-land "settling" phase (0.15s): elastic 0.8 → 1.05 → 1.0
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
  // Cubic-out → overshoot 0.8 → 1.05 → ease to 1.0
  if (u < 0.5) {
    const k = u / 0.5;
    return 0.80 + (1.05 - 0.80) * easeOutCubic(k);
  }
  const k = (u - 0.5) / 0.5;
  return 1.05 - 0.05 * easeOutCubic(k);
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export const DanielAvatar = forwardRef<DanielHandle, Props>(function DanielAvatar(
  { active, introTrigger, controllable, onIntroComplete, name, bodyColor, showNametag, flag },
  ref,
) {
  const rootRef = useRef<THREE.Group | null>(null);
  const innerRef = useRef<THREE.Group | null>(null);
  const gltfRef = useRef<GooniHandle | null>(null);
  const phaseRef = useRef<DanielPhase>("lying");
  const lastClipRef = useRef<string | null>(null);
  const tRef = useRef(0);
  const stoodFiredRef = useRef(false);

  const gridRef = useRef({ gx: 0, gz: 0 });
  const lastSafeGridRef = useRef({ gx: 0, gz: 0 });
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
  const invulnRef = useRef({ active: false, t: 0 });
  const bumpRef = useRef({
    active: false, t: 0,
    fromX: 0, fromZ: 0, fromY: 0,
    dirX: 0, dirZ: 0,
    facing: 0,
  });
  // -1 = no auto-trigger (intro lying waits for prop). >=0 = post-
  // respawn pause-then-get-up.
  const lyingRestRef = useRef(-1);
  // Tracks how long the char has been in continuous idle — drives the
  // idle look-around per spec.
  const idleSinceRef = useRef(0);
  // π = facing -Z so character starts with its back toward the default
  // rear camera (which sits along +Z and looks toward -Z).
  const headingRef = useRef(Math.PI);

  // Stable occupant id — Daniel registers on his starting tile and
  // moves with each landing. Cleared on unmount.
  const idRef = useRef<OccupantId>(`daniel-${Math.random().toString(36).slice(2)}`);
  // Smoothed stack-Y. When the avatar below us leaves, our logical
  // stack level drops instantly; this ref lerps the visible Y toward
  // the new target so we descend smoothly instead of snapping.
  const displayStackYRef = useRef(0);

  useEffect(() => {
    const myId = idRef.current;
    setOccupant(myId, gridRef.current.gx, gridRef.current.gz);
    return () => clearOccupant(myId);
  }, []);

  // Idempotent clip switcher — only fires when name actually changes.
  function setClipIfChanged(name: string, opts?: { loop?: boolean; timeScale?: number; fadeMs?: number }) {
    if (lastClipRef.current === name) return;
    lastClipRef.current = name;
    gltfRef.current?.setClip(name as never, opts);
  }

  useImperativeHandle(ref, () => ({
    get group() { return rootRef.current; },
    worldPos: () => {
      const wp = new THREE.Vector3();
      rootRef.current?.getWorldPosition(wp);
      return wp;
    },
    phase: () => phaseRef.current,
    heading: () => headingRef.current,
    isHopping: () => hopRef.current.active,
  }));

  // Reset state machine on (re-)activation.
  if (active && phaseRef.current === "idle" && !stoodFiredRef.current) {
    // no-op: handles the case where intro already finished but ref guards still apply
  }

  useFrame((_, rawDt) => {
    const root = rootRef.current;
    const inner = innerRef.current;
    if (!root || !inner || !active) return;
    const dt = Math.min(rawDt, 0.05);
    // Root only carries position. Inner takes rotation + scale so the
    // nametag (sibling of inner, parented to root) stays unrotated +
    // unscaled regardless of squash/lying/etc.

    if (introTrigger && phaseRef.current === "lying") {
      phaseRef.current = "getting-up";
      tRef.current = 0;
    }

    const phase = phaseRef.current;
    // Reset idle-look timer whenever the char is doing literally
    // anything else (hopping/falling/respawning/lying/etc).
    if (phase !== "idle") idleSinceRef.current = 0;

    // ── Clip driver — picks the GLTF anim that matches the current
    // phase. During lying/get-up, mixer is stopped so the root-transform
    // pose drives everything.
    if (phase === "lying" || phase === "getting-up") {
      if (lastClipRef.current !== null) {
        gltfRef.current?.stopAll();
        lastClipRef.current = null;
      }
    } else if (phase === "idle" || phase === "settling" || phase === "respawning") {
      setClipIfChanged("Idle", { loop: true, fadeMs: 200 });
    } else if (phase === "hopping") {
      // Sync clip duration roughly to hop arc (Quaternius Jump clip ~0.6s).
      setClipIfChanged("Jump", { loop: false, timeScale: 1.6, fadeMs: 80 });
    } else if (phase === "falling") {
      setClipIfChanged("HitReact", { loop: false, fadeMs: 80 });
    }

    // ── Invuln flash tick (parent of all phase branches so it runs
    // even mid-respawn-settle).
    if (invulnRef.current.active) {
      invulnRef.current.t += dt;
      if (invulnRef.current.t >= INVULN_DUR) {
        invulnRef.current.active = false;
        if (innerRef.current) innerRef.current.visible = true;
      } else if (innerRef.current) {
        // 3 oscillations over 0.5s = period 1/6s
        const cycle = Math.sin(invulnRef.current.t * Math.PI * 6);
        innerRef.current.visible = cycle > -0.2;
      }
    }

    // ── Sky-respawn drop. Char teleports above plaza center, face-flat,
    // falls back down under gravity. Lands lying — auto get-up after a
    // short pause. No black screen.
    if (respawnRef.current.active) {
      respawnRef.current.t += dt;
      const u = Math.min(1, respawnRef.current.t / SKY_RESPAWN_DUR);
      const eased = u * u;                     // ease-in gravity
      const y = SKY_HEIGHT * (1 - eased) + 0.05;
      const w = gridToWorld(0, 0);
      root.position.set(w.x, y, w.z);
      // Face-flat (lying-on-back) pose throughout the fall.
      inner.rotation.set(-Math.PI / 2, 0, 0);
      inner.scale.set(1, 1, 1);
      if (u >= 1) {
        respawnRef.current.active = false;
        phaseRef.current = "lying";
        // Mark this lying as "post-respawn" — auto-trigger get-up after
        // a brief rest, vs. intro lying which waits for introTrigger.
        lyingRestRef.current = 0;
        // Re-register at plaza center after the sky-fall lands.
        setOccupant(idRef.current, 0, 0);
        playLandThud();
        fireVfx({
          kind: "puff",
          world: { x: w.x, y: 0.15, z: w.z },
          intensity: 1.0,
        });
        invulnRef.current.active = true;
        invulnRef.current.t = 0;
      }
      return;
    }

    // ── Fall-off the world. Char tumbles past the edge w/ shrink, no
    // fade — sky-respawn picks up the moment the tumble finishes.
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
        // Reset grid to plaza center — char will reappear at sky there.
        gridRef.current = { gx: 0, gz: 0 };
        lastSafeGridRef.current = { gx: 0, gz: 0 };
        respawnRef.current.active = true;
        respawnRef.current.t = 0;
        phaseRef.current = "respawning";
      }
      return;
    }

    // ── Lying flat on back. Intro version waits for introTrigger prop;
    // post-respawn version counts down lyingRestRef and auto-triggers
    // the get-up sequence.
    if (phase === "lying") {
      const w = gridToWorld(0, 0);
      root.position.set(w.x, 0.05, w.z);
      inner.rotation.set(-Math.PI / 2, 0, 0);
      inner.scale.set(1, 1, 1);
      if (lyingRestRef.current >= 0) {
        lyingRestRef.current += dt;
        if (lyingRestRef.current >= LYING_REST_DUR) {
          phaseRef.current = "getting-up";
          tRef.current = 0;
          lyingRestRef.current = -1;
        }
      }
      return;
    }

    // ── Continuous keyframe-driven get-up (single phase, smoothstep
    // between KFs so transitions are C1-continuous — no reset glitch).
    if (phase === "getting-up") {
      tRef.current += dt;
      const t = tRef.current;
      const w = gridToWorld(0, 0);

      if (t >= GETUP_END) {
        phaseRef.current = "idle";
        root.position.set(w.x, 0, w.z);
        inner.rotation.set(0, headingRef.current, 0);
        inner.scale.set(1, 1, 1);
        if (!stoodFiredRef.current) {
          stoodFiredRef.current = true;
          // Record the spawn tile so NoteCoins (which mounts only after
          // introDone) can seed the player position + surface the
          // START HERE peek immediately. No-notify, so no chime/glow —
          // honoring "NO glow on the starting tile".
          recordPlayerSpawn(0, 0, { x: w.x, z: w.z });
          onIntroComplete();
          // Spec: NO glow on the starting tile.
        }
        return;
      }

      const kf = sampleGetUp(t);
      root.position.set(w.x, kf.posY, w.z);
      inner.rotation.set(kf.rotX, headingRef.current, kf.rotZ);
      inner.scale.set(1, kf.scaleY, 1);
      return;
    }

    // ── Post-land elastic settle (0.15s after landing impact)
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

    // ── Hop
    const h = hopRef.current;

    if (!h.active && !bumpRef.current.active && controllable && phase === "idle") {
      const hop = consumeQueuedHop();
      if (hop) {
        const d = deltaForSnap(hop.dir, hop.snap);
        const fromGx = gridRef.current.gx;
        const fromGz = gridRef.current.gz;
        const toGx = fromGx + d.dx;
        const toGz = fromGz + d.dz;
        const fromW = gridToWorld(fromGx, fromGz);
        const toW = gridToWorld(toGx, toGz);

        // Blocked target (tree/rock/bush) — refuse the hop. Play a
        // bonk + run the bump animation. NO tile break, no occupant
        // change.
        if (tileWithin(toGx, toGz) && isTileBlocked(toGx, toGz)) {
          bumpRef.current.active = true;
          bumpRef.current.t = 0;
          bumpRef.current.fromX = fromW.x;
          bumpRef.current.fromZ = fromW.z;
          bumpRef.current.fromY = stackLevelOf(idRef.current, fromGx, fromGz) * STACK_OFFSET;
          bumpRef.current.dirX = toW.x - fromW.x;
          bumpRef.current.dirZ = toW.z - fromW.z;
          bumpRef.current.facing = Math.atan2(d.dx, d.dz);
          phaseRef.current = "hopping";   // visuals still read as a hop attempt
          playInvalidMove();
          return;
        }

        const myId = idRef.current;
        // Stack-aware hop: leaving y = current stack pos. Landing y =
        // where I'll stack at the target (top of existing stack).
        const fromLevel = stackLevelOf(myId, fromGx, fromGz);
        const fromY = fromLevel * STACK_OFFSET;
        const toY = topOfStack(toGx, toGz) * STACK_OFFSET;
        // Tile only breaks if I'm the LAST one on it (count === 1 = me
        // alone). If others are still on the tile, they remain — tile
        // intact, they descend a stack level if I was below them.
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
        // Tile only breaks if I was alone on it (no one left behind).
        h.breaksTile = alone;
        // I'm leaving — clear my occupant slot so others' stack levels
        // are correct mid-hop.
        clearOccupant(myId);
        phaseRef.current = "hopping";
        gltfRef.current?.setEyeLook(0, 0.6);
        playJumpGrunt();
        fireVfx({
          kind: "puff",
          world: { x: fromW.x, y: 0.05 + fromY, z: fromW.z },
          intensity: 0.7,
        });
      }
    }

    // Bump-back animation: char lunges partially toward blocked tile,
    // returns home. No tile break, no occupant change.
    const bump = bumpRef.current;
    if (bump.active) {
      bump.t += dt;
      const u = Math.min(1, bump.t / BUMP_DUR);
      // 0..0.42 forward (0.42 of total). 0.42..1 return.
      let prog: number;
      if (u < 0.42) {
        const k = u / 0.42;
        prog = (1 - Math.pow(1 - k, 3)) * BUMP_REACH;
      } else {
        const k = (u - 0.42) / 0.58;
        const eased = 1 - Math.pow(1 - k, 3);
        prog = BUMP_REACH * (1 - eased);
      }
      const arc = Math.sin((prog / BUMP_REACH) * Math.PI) * BUMP_ARC;
      root.position.set(
        bump.fromX + bump.dirX * prog,
        bump.fromY + arc,
        bump.fromZ + bump.dirZ * prog,
      );

      // Face toward the attempted direction briefly
      let dh = bump.facing - headingRef.current;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      headingRef.current += dh * Math.min(1, dt * 14);
      inner.rotation.set(0, headingRef.current, 0);
      // Subtle squash at the apex of the bump so it reads as effortful.
      const sx = 1 + Math.sin((prog / BUMP_REACH) * Math.PI) * 0.06;
      inner.scale.set(sx, 1, sx);
      if (u >= 1) {
        bump.active = false;
        phaseRef.current = "idle";
      }
      return;
    }

    if (h.active) {
      h.t += dt;
      const u = Math.min(1, h.t / HOP_DUR);
      const x = h.fromX + (h.toX - h.fromX) * u;
      const z = h.fromZ + (h.toZ - h.fromZ) * u;
      // Stack-aware arc — base Y interpolates between from-stack-Y and
      // to-stack-Y, arc on top. Lets the hop land cleanly on a stacked
      // tile (or jump down off a stack).
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
          playFallOff();
          fireLanding({
            gx: h.toGx, gz: h.toGz,
            world: { x: h.toX, z: h.toZ },
            from: { gx: h.fromGx, gz: h.fromGz },
            fellOff: true,
            impactVel: 0,
            breaksTile: h.breaksTile,
            actor: "player",
          });
        } else {
          gridRef.current = { gx: h.toGx, gz: h.toGz };
          // Track last safe tile for fall-off respawn.
          lastSafeGridRef.current = { gx: h.toGx, gz: h.toGz };
          // Register on the destination tile (lands at top of stack).
          setOccupant(idRef.current, h.toGx, h.toGz);
          // Snap the smoothed display-Y so we don't lerp from old value.
          displayStackYRef.current = h.toY;
          phaseRef.current = "settling";
          settleRef.current.active = true;
          settleRef.current.t = 0;
          playLandThud();
          fireLanding({
            gx: h.toGx, gz: h.toGz,
            world: { x: h.toX, z: h.toZ },
            from: { gx: h.fromGx, gz: h.fromGz },
            fellOff: false,
            impactVel: HOP_HEIGHT * 6,
            breaksTile: h.breaksTile,
            actor: "player",
          });
          fireVfx({
            kind: "dust",
            world: { x: h.toX, y: 0.05 + h.toY, z: h.toZ },
            intensity: 0.9,
          });
        }
      }
      return;
    }

    // ── Idle (subtle bob — Quaternius Idle clip handles bone breathing)
    const idleT = performance.now() / 1000;
    const bob = Math.sin(idleT * 2.0) * 0.015;
    const yawDrift = Math.sin(idleT * 0.4) * 0.03;
    const w = gridToWorld(gridRef.current.gx, gridRef.current.gz);
    // Smoothly descend when whoever was below us leaves the tile.
    const targetStackY = stackYOf(idRef.current, gridRef.current.gx, gridRef.current.gz);
    displayStackYRef.current += (targetStackY - displayStackYRef.current) * Math.min(1, dt * 6);
    root.position.set(w.x, displayStackYRef.current + bob, w.z);
    inner.rotation.set(0, headingRef.current + yawDrift, 0);
    inner.scale.set(1, 1, 1);

    // ── Idle look-around. After 4s of continuous idle, eyes drift
    // side-to-side slowly. Reset the timer on any non-idle phase.
    idleSinceRef.current += dt;
    if (idleSinceRef.current > 4.0) {
      const driftX = Math.sin((idleSinceRef.current - 4.0) * 0.6);
      gltfRef.current?.setEyeLook(driftX, 0);
    } else {
      gltfRef.current?.setEyeLook(0, 0);
    }
  });

  return (
    <group ref={rootRef}>
      <mesh position-y={0.02} rotation-x={-Math.PI / 2}>
        <circleGeometry args={[0.32, 24]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.26} depthWrite={false} />
      </mesh>
      <group ref={innerRef}>
        <GLTFGooni ref={gltfRef} bodyColor={bodyColor} />
      </group>
      {showNametag && <Nametag name={name} flag={flag} />}
    </group>
  );
});
