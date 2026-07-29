import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  GRID_PITCH,
  fireTileState,
  registerTileExists,
  setTileSolid,
  subscribeLandings,
  type LandingEvent,
} from "./useDanielControls";
import { buildTileGrid, isPortalTile, PORTAL_TILE } from "./tileGrid";
import { getToonGradient } from "./toonGradient";
import { fireVfx } from "./vfx";
import { playTileBreak, playTileHeal } from "./sfx";

const tileGradient = getToonGradient();

// Big-tile floor w/:
//   - Per-tile break/heal state machine (4 fragments fall, ~2.45s heal)
//   - Per-tile HIGHLIGHT state — solid warm-yellow overlay scales from
//     center to fill the tile on land, holds while the player stays,
//     hides instantly when they leave or the tile breaks.

// Pitch went from 1.4 → 2.0 (in useDanielControls). Tile count
// reduced so total plaza diameter stays similar.
// Grid geometry (radius + plaza extent) extracted to ./tileGrid so
// NoteCoins can pick coin positions from the same authoritative grid.
// Spec: 0.97 of cell (= 0.03 unit gap). Was 0.94.
const TILE_VISIBLE_SIZE = GRID_PITCH * 0.97;
const TILE_HEIGHT = 0.10;
const Y_OFFSET = 0.05;
// Outer-ring darkening threshold (5% dimmer per spec).
const EDGE_RING_RADIUS = 5.0;     // tiles at hypot >= this get tinted
const EDGE_DARKEN = 0.05;          // HSL lightness offset

// 5-color palette per spec — warm beiges.
const PALETTE = [
  new THREE.Color("#f4ead7"),
  new THREE.Color("#ecdcb8"),
  new THREE.Color("#e8d5b0"),
  new THREE.Color("#e9dcc1"),
  new THREE.Color("#dccba6"),
];

// Spec: 2.5-3.0s heal cycle. BREAK + GONE + RISE = 2.7s.
const BREAK_DUR = 0.50;
const GONE_DUR = 1.65;
const RISE_DUR = 0.55;

const FRAG_POOL = 28;
const FRAG_SIZE = TILE_VISIBLE_SIZE / 2.05;

// Highlight pool — soft warm overlay = the "emissive boost" effect per
// spec (fade in 0.2s, hold ~1s, fade out 1.5s). Color is the gentle
// marigold the spec calls for; opacity is lower so it reads as an inner
// glow rather than a solid stamp.
const HIGHLIGHT_POOL = 4;
const HIGHLIGHT_EXPAND_DUR = 0.20;
const HIGHLIGHT_HOLD_DUR = 1.0;
const HIGHLIGHT_HIDE_DUR = 1.50;
const HIGHLIGHT_COLOR = "#fff4d0";
const HIGHLIGHT_OPACITY = 0.40;

// Ring-pulse pool — expanding warm ring on landing. Animates from
// tiny→max-radius over 0.5s with linear opacity fade.
const RING_POOL = 4;
const RING_DUR = 0.50;
const RING_COLOR = "#fff4d0";
const RING_MAX_SCALE = TILE_VISIBLE_SIZE * 0.55;
const RING_OPACITY = 0.55;

type TileEntry = {
  gx: number; gz: number; x: number; z: number;
  baseColor: THREE.Color;
  yJitter: number;     // ±0.02 per spec
};

type Phase = "solid" | "breaking" | "gone" | "rising";
type TilePhase = { state: Phase; t: number };

type Fragment = {
  mesh: THREE.Mesh; active: boolean;
  pos: THREE.Vector3; vel: THREE.Vector3;
  angVel: THREE.Vector3; rot: THREE.Euler;
  birth: number; color: THREE.Color;
};

type HighlightSlot = {
  mesh: THREE.Mesh;
  tileGx: number;
  tileGz: number;
  state: "idle" | "expanding" | "held" | "hiding";
  t: number;
};

type RingSlot = {
  mesh: THREE.Mesh;
  state: "idle" | "active";
  t: number;
};

export function TileFloor() {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const tiles = useMemo<TileEntry[]>(() => {
    // Skip the portal tile: it stays in the grid (registerTileExists
    // below still runs for it, so you can hop in) but drawing a slab
    // across the opening made the hole read as a tinted rectangle
    // rather than a hole.
    return buildTileGrid().filter((t) => !isPortalTile(t.gx, t.gz)).map(({ gx, gz, x, z }) => {
      const h = Math.abs(gx * 37 + gz * 71 + gx * gz * 13) & 0xff;
      const palIdx = h % PALETTE.length;
      const colorJitter = ((h >> 4) / 255 - 0.5) * 0.04;
      // Tiles in the outer 2 rings get 5% darker per spec.
      const isEdge = Math.hypot(gx, gz) >= EDGE_RING_RADIUS;
      const lightnessDelta = colorJitter - (isEdge ? EDGE_DARKEN : 0);
      const baseColor = PALETTE[palIdx].clone().offsetHSL(0, 0, lightnessDelta);
      // Y jitter ±0.02 per spec.
      const yJitter = (((h >> 2) & 0xff) / 255 - 0.5) * 0.04;
      return { gx, gz, x, z, baseColor, yJitter };
    });
  }, []);

  const indexMap = useMemo(() => {
    const m = new Map<string, number>();
    tiles.forEach((t, i) => m.set(`${t.gx},${t.gz}`, i));
    return m;
  }, [tiles]);

  const phasesRef = useRef<TilePhase[]>([]);
  if (phasesRef.current.length !== tiles.length) {
    phasesRef.current = tiles.map(() => ({ state: "solid", t: 0 }));
  }

  useLayoutEffect(() => {
    tiles.forEach((t) => registerTileExists(t.gx, t.gz));
    // The portal tile is filtered out of the rendered set above, but it
    // must stay walkable — hopping INTO the hole is the whole point, so
    // register it by hand.
    registerTileExists(PORTAL_TILE.gx, PORTAL_TILE.gz);
  }, [tiles]);

  const fragmentsRef = useRef<Fragment[]>([]);
  const fragNextRef = useRef(0);

  // Highlight pool
  const highlightSlotsRef = useRef<HighlightSlot[]>([]);
  const highlightNextRef = useRef(0);

  // Square plane that fills the entire tile face — the "you're on this
  // tile" emissive overlay. The expanding ring pulse (RingGeometry,
  // below) is a separate, smaller effect.
  const highlightGeo = useMemo(
    () => new THREE.PlaneGeometry(TILE_VISIBLE_SIZE, TILE_VISIBLE_SIZE),
    [],
  );

  // Ring-pulse pool
  const ringSlotsRef = useRef<RingSlot[]>([]);
  const ringNextRef = useRef(0);

  // Thin annulus 0.7..1.0 unit radius — scaled to RING_MAX_SCALE in
  // useFrame so the ring expands while staying ring-shaped.
  const ringGeo = useMemo(
    () => new THREE.RingGeometry(0.70, 1.00, 36),
    [],
  );

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    tiles.forEach((t, i) => {
      dummy.position.set(t.x, Y_OFFSET + t.yJitter, t.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, t.baseColor);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [tiles]);

  // ── Highlight helpers ────────────────────────────────────────
  function hideHighlightAt(gx: number, gz: number) {
    for (const slot of highlightSlotsRef.current) {
      if (!slot) continue;
      if (slot.state !== "idle" && slot.tileGx === gx && slot.tileGz === gz) {
        slot.state = "hiding";
        slot.t = 0;
      }
    }
  }

  function spawnRingPulseAt(world: { x: number; z: number }) {
    const ri = ringNextRef.current % RING_POOL;
    const slot = ringSlotsRef.current[ri];
    ringNextRef.current += 1;
    if (!slot) return;
    slot.mesh.position.set(world.x, Y_OFFSET + TILE_HEIGHT / 2 + 0.012, world.z);
    slot.mesh.visible = true;
    slot.mesh.scale.set(0.05, 0.05, 1);
    slot.state = "active";
    slot.t = 0;
    (slot.mesh.material as THREE.MeshBasicMaterial).opacity = RING_OPACITY;
  }

  function spawnHighlightAt(gx: number, gz: number, world: { x: number; z: number }) {
    const gi = highlightNextRef.current % HIGHLIGHT_POOL;
    const slot = highlightSlotsRef.current[gi];
    highlightNextRef.current += 1;
    if (!slot) return;
    // Tile box top sits at Y_OFFSET + TILE_HEIGHT/2 = 0.10. Highlight
    // plane MUST sit above that or the tile geometry occludes the glow
    // and the landing tile reads as un-highlighted.
    slot.mesh.position.set(world.x, Y_OFFSET + TILE_HEIGHT / 2 + 0.01, world.z);
    slot.mesh.visible = true;
    slot.mesh.scale.set(0.001, 0.001, 1);
    slot.tileGx = gx;
    slot.tileGz = gz;
    slot.state = "expanding";
    slot.t = 0;
    (slot.mesh.material as THREE.MeshBasicMaterial).opacity = HIGHLIGHT_OPACITY;
  }

  // Landing event:
  //   - From tile breaks + loses highlight
  //   - To tile (if not fellOff) gains highlight
  useEffect(() => {
    const unsub = subscribeLandings((e: LandingEvent) => {
      if (e.from) {
        // Hide highlight on the tile we're leaving.
        hideHighlightAt(e.from.gx, e.from.gz);
        // Break the from-tile only if the departing avatar was at the
        // BOTTOM of the stack (level 0). breaksTile=false means it was
        // stacked on top of someone, so the tile stays intact.
        const shouldBreak = e.breaksTile !== false;
        // Break that tile if it's still solid.
        const fromIdx = indexMap.get(`${e.from.gx},${e.from.gz}`);
        if (shouldBreak && fromIdx !== undefined) {
          const p = phasesRef.current[fromIdx];
          if (p.state === "solid") {
            p.state = "breaking";
            p.t = 0;
            setTileSolid(e.from.gx, e.from.gz, false);
            const t = tiles[fromIdx];
            spawnFragments(t.x, t.z, t.baseColor);
            fireVfx({
              kind: "debris",
              world: { x: t.x, y: 0.06, z: t.z },
              intensity: 0.8,
              color: { r: t.baseColor.r, g: t.baseColor.g, b: t.baseColor.b },
            });
            playTileBreak();
            fireTileState({ gx: e.from.gx, gz: e.from.gz, state: "broken" });
          }
        }
      }
      if (!e.fellOff && e.from) {
        // Spec: NO glow on the very first tile (no previous-tile context).
        // Daniel's get-up no longer fires a synthetic landing event so
        // this branch only triggers on real hops — keeping the guard
        // anyway so any future caller (e.g. respawn) can opt-out by
        // passing from=null.
        spawnRingPulseAt(e.world);
        spawnHighlightAt(e.gx, e.gz, e.world);
      }
    });
    return unsub;
  }, [indexMap, tiles]);

  function spawnFragments(cx: number, cz: number, color: THREE.Color) {
    const frags = fragmentsRef.current;
    const now = performance.now() / 1000;
    const offsets = [
      { ox: -0.35, oz: -0.35 }, { ox: 0.35, oz: -0.35 },
      { ox: -0.35, oz:  0.35 }, { ox: 0.35, oz:  0.35 },
    ];
    for (let i = 0; i < 4; i++) {
      const idx = fragNextRef.current % FRAG_POOL;
      const f = frags[idx];
      fragNextRef.current += 1;
      if (!f) continue;
      const o = offsets[i];
      f.pos.set(cx + o.ox, Y_OFFSET, cz + o.oz);
      f.vel.set(o.ox * 1.4 + (Math.random() - 0.5) * 0.4, 0.8 + Math.random() * 0.8, o.oz * 1.4 + (Math.random() - 0.5) * 0.4);
      f.angVel.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6);
      f.rot.set(0, 0, 0);
      f.active = true;
      f.birth = now;
      f.color.copy(color);
      (f.mesh.material as THREE.MeshStandardMaterial).color.copy(color);
      f.mesh.visible = true;
    }
  }

  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame((_, rawDt) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dt = Math.min(rawDt, 0.05);
    const now = performance.now() / 1000;

    // ── Tile state machine ────────────────────────────────────
    let dirty = false;
    for (let i = 0; i < tiles.length; i++) {
      const p = phasesRef.current[i];
      if (p.state === "solid") continue;
      const t = tiles[i];
      p.t += dt;

      let yOff = 0;
      let scale = 1;
      let tilt = 0;

      if (p.state === "breaking") {
        scale = 0;
        if (p.t >= BREAK_DUR) { p.state = "gone"; p.t = 0; }
      } else if (p.state === "gone") {
        scale = 0;
        if (p.t >= GONE_DUR) { p.state = "rising"; p.t = 0; }
      } else if (p.state === "rising") {
        const u = Math.min(1, p.t / RISE_DUR);
        const eased = 1 - Math.pow(1 - u, 3);
        yOff = -1.2 + 1.2 * eased;
        scale = 0.5 + 0.5 * eased;
        tilt = (1 - eased) * 0.15 * ((t.gx + t.gz) % 2 === 0 ? 1 : -1);
        if (p.t >= RISE_DUR) {
          p.state = "solid"; p.t = 0;
          yOff = 0; scale = 1; tilt = 0;
          setTileSolid(t.gx, t.gz, true);
          playTileHeal();
          fireTileState({ gx: t.gx, gz: t.gz, state: "healed" });
        }
      }
      dummy.position.set(t.x, Y_OFFSET + yOff, t.z);
      dummy.rotation.set(tilt, 0, tilt * 0.4);
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      dirty = true;
    }
    if (dirty) mesh.instanceMatrix.needsUpdate = true;

    // ── Fragments ──────────────────────────────────────────────
    for (const f of fragmentsRef.current) {
      if (!f || !f.active) continue;
      const age = now - f.birth;
      if (age >= BREAK_DUR) { f.active = false; f.mesh.visible = false; continue; }
      f.vel.y -= 12 * dt;
      f.pos.x += f.vel.x * dt;
      f.pos.y += f.vel.y * dt;
      f.pos.z += f.vel.z * dt;
      f.rot.x += f.angVel.x * dt;
      f.rot.y += f.angVel.y * dt;
      f.rot.z += f.angVel.z * dt;
      f.mesh.position.copy(f.pos);
      f.mesh.rotation.copy(f.rot);
      const matm = f.mesh.material as THREE.MeshStandardMaterial;
      if (age > BREAK_DUR * 0.7) {
        matm.opacity = 1 - (age - BREAK_DUR * 0.7) / (BREAK_DUR * 0.3);
        matm.transparent = true;
      } else {
        matm.opacity = 1;
        matm.transparent = false;
      }
    }

    // ── Ring pulses ────────────────────────────────────────────
    for (const slot of ringSlotsRef.current) {
      if (!slot || slot.state === "idle") continue;
      slot.t += dt;
      const u = Math.min(1, slot.t / RING_DUR);
      const s = 0.05 + (RING_MAX_SCALE - 0.05) * (1 - Math.pow(1 - u, 2));
      slot.mesh.scale.set(s, s, 1);
      const mat = slot.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = RING_OPACITY * (1 - u);
      if (u >= 1) {
        slot.state = "idle";
        slot.mesh.visible = false;
      }
    }

    // ── Highlights ─────────────────────────────────────────────
    for (const slot of highlightSlotsRef.current) {
      if (!slot || slot.state === "idle") continue;
      slot.t += dt;
      const mat = slot.mesh.material as THREE.MeshBasicMaterial;
      if (slot.state === "expanding") {
        const u = Math.min(1, slot.t / HIGHLIGHT_EXPAND_DUR);
        const eased = 1 - Math.pow(1 - u, 3);
        slot.mesh.scale.set(eased, eased, 1);
        mat.opacity = HIGHLIGHT_OPACITY * eased;
        if (u >= 1) {
          slot.state = "held";
          slot.t = 0;
        }
      } else if (slot.state === "held") {
        slot.mesh.scale.set(1, 1, 1);
        mat.opacity = HIGHLIGHT_OPACITY;
        // Auto-collapse after the held duration even if the player
        // hasn't moved — feels like a pulse, not a permanent marker.
        if (slot.t >= HIGHLIGHT_HOLD_DUR) {
          slot.state = "hiding";
          slot.t = 0;
        }
      } else if (slot.state === "hiding") {
        const u = Math.min(1, slot.t / HIGHLIGHT_HIDE_DUR);
        // Cubic ease so the collapse decelerates into the center.
        const eased = 1 - Math.pow(1 - u, 3);
        const remaining = 1 - eased;
        slot.mesh.scale.set(remaining, remaining, 1);
        mat.opacity = HIGHLIGHT_OPACITY * remaining;
        if (u >= 1) {
          slot.state = "idle";
          slot.mesh.visible = false;
        }
      }
    }
  });

  return (
    <group>
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, tiles.length]}
        receiveShadow
        castShadow={false}
      >
        <boxGeometry args={[TILE_VISIBLE_SIZE, TILE_HEIGHT, TILE_VISIBLE_SIZE]} />
        <meshToonMaterial color="#ffffff" gradientMap={tileGradient} />
      </instancedMesh>

      {Array.from({ length: FRAG_POOL }).map((_, i) => (
        <mesh
          key={i}
          visible={false}
          ref={(m) => {
            if (!m) return;
            const existing = fragmentsRef.current[i];
            if (!existing) {
              fragmentsRef.current[i] = {
                mesh: m, active: false,
                pos: new THREE.Vector3(), vel: new THREE.Vector3(),
                angVel: new THREE.Vector3(), rot: new THREE.Euler(),
                birth: 0, color: new THREE.Color(),
              };
            } else {
              existing.mesh = m;
            }
          }}
        >
          <boxGeometry args={[FRAG_SIZE, TILE_HEIGHT, FRAG_SIZE]} />
          <meshToonMaterial color="#ffffff" gradientMap={tileGradient} />
        </mesh>
      ))}

      {Array.from({ length: HIGHLIGHT_POOL }).map((_, i) => (
        <mesh
          key={i}
          geometry={highlightGeo}
          rotation-x={-Math.PI / 2}
          visible={false}
          ref={(m) => {
            if (!m) return;
            const existing = highlightSlotsRef.current[i];
            if (!existing) {
              highlightSlotsRef.current[i] = {
                mesh: m,
                tileGx: 0, tileGz: 0,
                state: "idle", t: 0,
              };
            } else {
              existing.mesh = m;
            }
          }}
        >
          <meshBasicMaterial
            color={HIGHLIGHT_COLOR}
            transparent
            opacity={0}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}

      {Array.from({ length: RING_POOL }).map((_, i) => (
        <mesh
          key={`ring-${i}`}
          geometry={ringGeo}
          rotation-x={-Math.PI / 2}
          visible={false}
          ref={(m) => {
            if (!m) return;
            const existing = ringSlotsRef.current[i];
            if (!existing) {
              ringSlotsRef.current[i] = { mesh: m, state: "idle", t: 0 };
            } else {
              existing.mesh = m;
            }
          }}
        >
          <meshBasicMaterial
            color={RING_COLOR}
            transparent
            opacity={0}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}
