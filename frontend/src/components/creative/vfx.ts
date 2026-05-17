// Lightweight VFX event bus — fires off "spawn particles here" pings.
// The Particles component subscribes + pulls from its pool. Decouples
// gameplay code (DanielAvatar / TileFloor) from rendering pipeline.

export type VfxKind = "dust" | "debris" | "puff";

export type VfxEvent = {
  kind: VfxKind;
  world: { x: number; y: number; z: number };
  intensity: number;             // 0..1 — caller hint for size/count
  color?: { r: number; g: number; b: number };  // optional per-event tint
};

type Listener = (e: VfxEvent) => void;
const listeners = new Set<Listener>();

export function fireVfx(e: VfxEvent) {
  listeners.forEach((l) => l(e));
}
export function subscribeVfx(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
