// Tile occupancy registry — tracks which avatars are on which tile so
// avatars can stack on top of each other. List order = stacking order
// (index 0 = bottom). Used by DanielAvatar + NpcAvatar.

export type OccupantId = string;

const tileKey = (gx: number, gz: number) => `${gx},${gz}`;

const tileToList = new Map<string, OccupantId[]>();
const idToTile = new Map<OccupantId, string>();

// Effective stacking step. Tuned so a Daniel landing on top of an NPC
// stands flush on the NPC's head, not sunken in (was 0.85 — too low).
export const STACK_OFFSET = 1.05;

/**
 * Move an occupant to a new tile. Removes from any previous tile.
 * Appends to the destination tile's stack (top of stack).
 */
export function setOccupant(id: OccupantId, gx: number, gz: number): void {
  clearOccupant(id);
  const k = tileKey(gx, gz);
  let list = tileToList.get(k);
  if (!list) {
    list = [];
    tileToList.set(k, list);
  }
  if (!list.includes(id)) list.push(id);
  idToTile.set(id, k);
}

export function clearOccupant(id: OccupantId): void {
  const k = idToTile.get(id);
  if (k === undefined) return;
  const list = tileToList.get(k);
  if (list) {
    const idx = list.indexOf(id);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) tileToList.delete(k);
  }
  idToTile.delete(id);
}

/**
 * Stack level of `id` at the given tile. If id is currently registered
 * on the tile, returns its index. Otherwise returns the next slot
 * (i.e. where it would land if added).
 */
export function stackLevelOf(id: OccupantId, gx: number, gz: number): number {
  const k = tileKey(gx, gz);
  const list = tileToList.get(k);
  if (!list) return 0;
  const idx = list.indexOf(id);
  return idx === -1 ? list.length : idx;
}

/** Where the next avatar to land on this tile would stack. */
export function topOfStack(gx: number, gz: number): number {
  const k = tileKey(gx, gz);
  const list = tileToList.get(k);
  return list ? list.length : 0;
}

/** How many avatars are on a given tile right now. */
export function occupantCount(gx: number, gz: number): number {
  const k = tileKey(gx, gz);
  return tileToList.get(k)?.length ?? 0;
}

/** Get current Y offset for an occupant based on their stack position. */
export function stackYOf(id: OccupantId, gx: number, gz: number): number {
  return stackLevelOf(id, gx, gz) * STACK_OFFSET;
}
