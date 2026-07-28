import type { Project } from "../../content/portfolio";
import { MONUMENTS, PYLONS, ARCHIVE, PROFILE } from "../../content/portfolio";
import { tileKey, type BaseTile } from "./tileGrid";

// Landmark placement — DELIBERATE, not hashed.
//
// Note-coins hash onto whatever tile is free (noteTileMap.ts) because a
// note is one of many and its exact spot doesn't carry meaning. A
// landmark is the opposite: it's the destination, so its tile is chosen
// and fixed. "The resume board is three hops south of spawn" has to
// stay true across reloads and across content edits.
//
// Tiles avoid Nature's props (trees at the cardinal outer tiles, bushes
// on the diagonals, rocks scattered on the outer ring — see
// Nature.tsx buildPlacements) so nothing spawns inside a tree.
//
// (0,0) is the spawn tile: the Gooni monument sits there on purpose, so
// the first thing a visitor stands on is the strongest work. Note-coins
// used to anchor the top pinned note there; they now hash around every
// reserved tile instead (RESERVED_TILES, consumed by noteTileMap).

export type LandmarkKind = "monument" | "pylon" | "kiosk" | "signpost" | "archive";

export type Landmark = {
  id: string;
  kind: LandmarkKind;
  gx: number;
  gz: number;
  /** Card heading. */
  title: string;
  /** One line under the heading. */
  subtitle: string;
  color: string;
  /** Present for project-backed landmarks; absent for kiosk/signpost. */
  project?: Project;
  /** Kiosk/signpost payloads. */
  href?: string;
  links?: { label: string; href: string }[];
  /** Archive payload. */
  items?: Project[];
};

// Hand-placed. Keep these spread far enough apart that two cards can't
// both be in reach from one tile, and close enough that every landmark
// is a handful of hops from spawn.
// A processional axis runs north from spawn: you land facing the Gooni
// monument, and the contact signpost sits behind it at the island's
// edge. Work first, then the way to reach him.
//
// Gooni deliberately does NOT sit on spawn (0,0). Standing the player
// inside a 2m obelisk merged the green avatar into the green monument
// and read as a glitch — the monument wants to be seen from a couple of
// metres, not worn. Spawn stays empty; the monument is the first thing
// in view instead of the thing you're inside.
const SLOTS: Record<string, { gx: number; gz: number }> = {
  gooni: { gx: 0, gz: -2 },     // dead ahead on entry
  contact: { gx: 0, gz: -4 },   // past it, at the north edge
  kreatify: { gx: 3, gz: -1 },  // east, one ridge over
  lucid: { gx: -3, gz: 1 },     // west, mirrors kreatify
  resume: { gx: 0, gz: 3 },     // due south of spawn — the findable one
  archive: { gx: 2, gz: 3 },    // southeast, past the resume board
};

function slotFor(id: string): { gx: number; gz: number } | null {
  return SLOTS[id] ?? null;
}

export function buildLandmarks(): Landmark[] {
  const out: Landmark[] = [];

  for (const project of [...MONUMENTS, ...PYLONS]) {
    const slot = slotFor(project.id);
    if (!slot) continue;
    out.push({
      id: project.id,
      kind: project.weight === "monument" ? "monument" : "pylon",
      gx: slot.gx,
      gz: slot.gz,
      title: project.name,
      subtitle: project.tagline,
      color: project.color,
      project,
    });
  }

  const resume = slotFor("resume");
  if (resume) {
    out.push({
      id: "resume",
      kind: "kiosk",
      gx: resume.gx,
      gz: resume.gz,
      title: "Résumé",
      subtitle: "One page, the whole thing.",
      color: "#E8C468",
      href: PROFILE.resumeHref,
    });
  }

  const contact = slotFor("contact");
  if (contact) {
    out.push({
      id: "contact",
      kind: "signpost",
      gx: contact.gx,
      gz: contact.gz,
      title: "Say hello",
      subtitle: "The island's edge. Mind the drop.",
      color: "#E88AA0",
      links: [...PROFILE.links],
    });
  }

  const archive = slotFor("archive");
  if (archive && ARCHIVE.length > 0) {
    out.push({
      id: "archive",
      kind: "archive",
      gx: archive.gx,
      gz: archive.gz,
      title: "The archive",
      subtitle: `${ARCHIVE.length} earlier things, from the CMU years.`,
      color: "#A79B8A",
      items: ARCHIVE,
    });
  }

  return out;
}

export const LANDMARKS = buildLandmarks();

/** Tiles landmarks own. noteTileMap skips these so a coin never
 *  overlaps a monument. */
export const RESERVED_TILES: ReadonlySet<string> = new Set(
  LANDMARKS.map((l) => tileKey(l.gx, l.gz)),
);

export function isReservedTile(gx: number, gz: number): boolean {
  return RESERVED_TILES.has(tileKey(gx, gz));
}

export function landmarkAt(gx: number, gz: number): Landmark | null {
  return LANDMARKS.find((l) => l.gx === gx && l.gz === gz) ?? null;
}

/** World-space tile for a landmark, for VFX + camera work. */
export function landmarkTile(l: Landmark): BaseTile {
  return { gx: l.gx, gz: l.gz, x: l.gx * 2.0, z: l.gz * 2.0 };
}
