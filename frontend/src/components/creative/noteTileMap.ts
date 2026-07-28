import type { PublicNote } from "../../services/api";
import { isTileBlocked } from "./useDanielControls";
import { isReservedTile } from "./landmarkPlacement";
import { tileKey, type BaseTile } from "./tileGrid";

// Deterministic note → tile mapping. Same note.id always lands on the
// same tile across reloads, so "the note near the rock" is a stable
// memory.
//
// Selection: cap at NOTE_COIN_CAP. Pinned-public notes first, then
// newest by updated_at desc.
//
// Spawn tile (0,0): reserved for the top-ranked pinned note (the
// "what is Gooni" intro coin) so the player lands on it immediately.
// All other notes hash-and-probe past spawn.
//
// Hash: Knuth multiplicative on note.id, linear-probe on collision.
// Skip any nature-blocked tile.

export const NOTE_COIN_CAP = 10;

export type NoteTileAssignment = {
  note: PublicNote;
  tile: BaseTile;
};

function rankNotes(notes: PublicNote[]): PublicNote[] {
  return [...notes].sort((a, b) => {
    const pa = a.is_public_pinned ? 1 : 0;
    const pb = b.is_public_pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return b.updated_at.localeCompare(a.updated_at);
  });
}

function knuthHash(n: number): number {
  return (n * 2654435761) >>> 0;
}

function isSpawnTile(t: BaseTile): boolean {
  return t.gx === 0 && t.gz === 0;
}

export function buildNoteTileMap(
  notes: PublicNote[],
  tiles: BaseTile[],
  cap: number = NOTE_COIN_CAP,
): NoteTileAssignment[] {
  if (tiles.length === 0) return [];
  const ranked = rankNotes(notes).slice(0, cap);
  const taken = new Set<string>();
  const out: NoteTileAssignment[] = [];

  // Spawn used to anchor the top pinned note. It's now the Gooni
  // monument's tile (landmarkPlacement) — the first thing a visitor
  // stands on should be the work, not a note about the work — so every
  // note, pinned or not, goes through hashed placement and skips the
  // tiles landmarks own.
  for (const note of ranked) {
    const start = knuthHash(note.id) % tiles.length;
    let placed = false;
    for (let i = 0; i < tiles.length; i++) {
      const idx = (start + i) % tiles.length;
      const t = tiles[idx];
      const key = tileKey(t.gx, t.gz);
      if (taken.has(key)) continue;
      if (isSpawnTile(t)) continue;
      if (isReservedTile(t.gx, t.gz)) continue;
      if (isTileBlocked(t.gx, t.gz)) continue;
      taken.add(key);
      out.push({ note, tile: t });
      placed = true;
      break;
    }
    if (!placed) break;
  }
  return out;
}
