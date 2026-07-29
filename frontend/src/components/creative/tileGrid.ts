import { GRID_PITCH } from "./useDanielControls";

// Shared tile-grid geometry. TileFloor renders these as the visible
// hex/grid plaza; NoteCoins picks a deterministic subset to place
// note-coins on. Both consume buildTileGrid() so the grid stays
// authoritative in one place.

export const PLAZA_INNER = 12.5;
export const GRID_RADIUS_TILES = 6;

export type BaseTile = {
  gx: number;
  gz: number;
  x: number;
  z: number;
};

export function buildTileGrid(): BaseTile[] {
  const out: BaseTile[] = [];
  for (let gz = -GRID_RADIUS_TILES; gz <= GRID_RADIUS_TILES; gz++) {
    for (let gx = -GRID_RADIUS_TILES; gx <= GRID_RADIUS_TILES; gx++) {
      const x = gx * GRID_PITCH;
      const z = gz * GRID_PITCH;
      if (Math.hypot(x, z) > PLAZA_INNER) continue;
      out.push({ gx, gz, x, z });
    }
  }
  return out;
}

export function tileKey(gx: number, gz: number): string {
  return `${gx},${gz}`;
}

/** The hole into the walk. Lives here rather than in Portal.tsx so
 *  TileFloor can skip RENDERING it while the grid still REGISTERS it:
 *  the tile has to stay walkable or you could never hop in, but a
 *  drawn tile sits across the opening and cuts it in half. */
export const PORTAL_TILE = { gx: 0, gz: -2 };

export function isPortalTile(gx: number, gz: number): boolean {
  return gx === PORTAL_TILE.gx && gz === PORTAL_TILE.gz;
}
