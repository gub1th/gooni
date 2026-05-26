import { useEffect } from "react";

// Discrete tile-hop input. Direction is locked at the moment a key is
// pressed — if the user rotates the camera mid-hold the direction the
// arrow represents does NOT change, so a sequence of presses always
// feels consistent.

export const GRID_PITCH = 2.0;
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 230;

export type Direction = "up" | "down" | "left" | "right";

export type LandingEvent = {
  gx: number;
  gz: number;
  world: { x: number; z: number };
  from: { gx: number; gz: number } | null;
  fellOff: boolean;
  impactVel: number;
  // If false, the departing avatar's hop does NOT break the `from` tile
  // (it was stacked on top of someone, not on the actual tile). Default
  // is undefined → treated as true by TileFloor.
  breaksTile?: boolean;
  // Who landed: the human player vs an autonomous NPC. Consumers that
  // care about user intent (e.g. note-coin peek) filter to "player";
  // tile lifecycle (break/heal) treats both the same.
  actor: "player" | "npc";
};

type LandingListener = (e: LandingEvent) => void;
const landingListeners = new Set<LandingListener>();

// Retained value: where the player currently stands. The landing stream
// is transient, so a consumer that mounts AFTER a landing (e.g. NoteCoins,
// which only mounts once the intro finishes) would miss the spawn entirely
// and never resolve its peek. Holding the last player landing lets late
// mounters seed off the player's real position.
let lastPlayerLanding: LandingEvent | null = null;
export function getLastPlayerLanding(): LandingEvent | null {
  return lastPlayerLanding;
}

export function fireLanding(e: LandingEvent) {
  if (e.actor === "player") lastPlayerLanding = e.fellOff ? null : e;
  landingListeners.forEach((l) => l(e));
}

// Record the spawn tile WITHOUT notifying listeners. The intro ends with
// the avatar standing on (0,0) but never hops there, so no landing fires.
// We want late mounters to see the spawn position, but firing a real
// landing here would trip the landing chime / sparkle / tile-break side
// effects — so this only updates the retained value.
export function recordPlayerSpawn(gx: number, gz: number, world: { x: number; z: number }) {
  lastPlayerLanding = {
    gx, gz, world, from: null, fellOff: false, impactVel: 0, actor: "player",
  };
}

export function subscribeLandings(fn: LandingListener): () => void {
  landingListeners.add(fn);
  return () => landingListeners.delete(fn);
}

// Tile lifecycle events — emitted by TileFloor when a tile enters its
// `breaking` phase or completes a `rising` heal. Consumers (e.g. coins
// on note-tiles) use this to hide/show without duplicating TileFloor's
// internal phase tracking.
export type TileStateEvent = {
  gx: number;
  gz: number;
  state: "broken" | "healed";
};
type TileStateListener = (e: TileStateEvent) => void;
const tileStateListeners = new Set<TileStateListener>();
export function fireTileState(e: TileStateEvent) {
  tileStateListeners.forEach((l) => l(e));
}
export function subscribeTileState(fn: TileStateListener): () => void {
  tileStateListeners.add(fn);
  return () => tileStateListeners.delete(fn);
}

type Snap = { dx: number; dz: number };

const input = {
  enabled: false,
  queued: null as Direction | null,
  // Cardinal forward direction captured at the moment the current
  // held key was pressed. Used to resolve hop direction so input never
  // re-maps mid-press.
  queuedSnap: null as Snap | null,
  held: null as Direction | null,
  heldSnap: null as Snap | null,
  heldSince: 0,
  lastFiredAt: 0,
};

export function setControlsEnabled(on: boolean) {
  input.enabled = on;
  if (!on) {
    input.queued = null;
    input.queuedSnap = null;
    input.held = null;
    input.heldSnap = null;
  }
}

export type QueuedHop = { dir: Direction; snap: Snap };

export function consumeQueuedHop(): QueuedHop | null {
  // Auto-repeat first
  if (input.held && input.heldSnap && input.enabled) {
    const now = performance.now();
    const sinceHeld = now - input.heldSince;
    const sinceFire = now - input.lastFiredAt;
    if (sinceHeld >= REPEAT_DELAY_MS && sinceFire >= REPEAT_INTERVAL_MS) {
      input.lastFiredAt = now;
      return { dir: input.held, snap: input.heldSnap };
    }
  }
  if (input.queued && input.queuedSnap) {
    const out = { dir: input.queued, snap: input.queuedSnap };
    input.queued = null;
    input.queuedSnap = null;
    return out;
  }
  return null;
}

function dirForCode(code: string): Direction | null {
  switch (code) {
    case "ArrowUp": case "KeyW": return "up";
    case "ArrowDown": case "KeyS": return "down";
    case "ArrowLeft": case "KeyA": return "left";
    case "ArrowRight": case "KeyD": return "right";
    default: return null;
  }
}

// Fixed-world key mapping. UP=-Z, DOWN=+Z, LEFT=-X, RIGHT=+X. Zero
// camera dependency — pressing the same key always moves the character
// in the same world direction, period. Camera can orbit freely; the
// arrow keys never re-aim.
const FIXED_SNAP: Snap = { dx: 0, dz: -1 };

// kept for callers that still import these; both are no-ops now.
export function resetSnap() { /* world-fixed mapping never needs reset */ }

function snappedForwardNow(): Snap {
  return FIXED_SNAP;
}

export function useDanielKeyboard() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!input.enabled) return;
      const dir = dirForCode(e.code);
      if (!dir) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      if (e.repeat) return;          // we handle repeat ourselves
      // Lock the cardinal direction at the moment of press.
      const snap = snappedForwardNow();
      input.queued = dir;
      input.queuedSnap = snap;
      input.held = dir;
      input.heldSnap = snap;
      input.heldSince = performance.now();
      input.lastFiredAt = performance.now();
    }
    function onKeyUp(e: KeyboardEvent) {
      const dir = dirForCode(e.code);
      if (!dir) return;
      if (input.held === dir) {
        input.held = null;
        input.heldSnap = null;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);
}

// ── Camera forward ────────────────────────────────────────────────

const cameraForward = { x: 0, z: -1 };
export function setCameraForward(x: number, z: number) {
  const len = Math.hypot(x, z) || 1;
  cameraForward.x = x / len;
  cameraForward.z = z / len;
}

// Resolve direction + snapped camera-forward (captured at press time)
// into a grid delta. Same math as before, but the snap is fixed.
export function deltaForSnap(dir: Direction, snap: Snap): { dx: number; dz: number } {
  const right = { dx: -snap.dz, dz: snap.dx };
  switch (dir) {
    case "up":    return { dx: snap.dx, dz: snap.dz };
    case "down":  return { dx: -snap.dx, dz: -snap.dz };
    case "right": return right;
    case "left":  return { dx: -right.dx, dz: -right.dz };
  }
}

// ── Tile registry ──────────────────────────────────────────────────

const tileExists = new Set<string>();
const tileSolid = new Map<string, boolean>();
// Tiles physically occupied by a prop (tree/rock/bush). Avatars can't
// land on these — the hop attempt becomes a bump.
const tileBlocked = new Set<string>();
function tileKey(gx: number, gz: number) { return `${gx},${gz}`; }

export function registerTileExists(gx: number, gz: number) {
  const k = tileKey(gx, gz);
  tileExists.add(k);
  tileSolid.set(k, true);
}
export function setTileSolid(gx: number, gz: number, solid: boolean) {
  const k = tileKey(gx, gz);
  if (!tileExists.has(k)) return;
  tileSolid.set(k, solid);
}
export function isTileSolid(gx: number, gz: number): boolean {
  const k = tileKey(gx, gz);
  return tileExists.has(k) && (tileSolid.get(k) ?? true);
}
export function tileWithin(gx: number, gz: number): boolean {
  return tileExists.has(tileKey(gx, gz));
}
export function setTileBlocked(gx: number, gz: number, blocked: boolean) {
  const k = tileKey(gx, gz);
  if (blocked) tileBlocked.add(k);
  else tileBlocked.delete(k);
}
export function isTileBlocked(gx: number, gz: number): boolean {
  return tileBlocked.has(tileKey(gx, gz));
}
export function gridToWorld(gx: number, gz: number): { x: number; z: number } {
  return { x: gx * GRID_PITCH, z: gz * GRID_PITCH };
}
