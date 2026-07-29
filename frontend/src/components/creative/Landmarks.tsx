import { useCallback, useEffect, useRef, useState } from "react";
import { Landmark } from "./Landmark";
import { LANDMARKS, type Landmark as LandmarkData } from "./landmarkPlacement";
import { getLastPlayerLanding, subscribeLandings } from "./useDanielControls";
import { setLandmarkState } from "./landmarkBus";
import { fireVfx } from "./vfx";
import { playCoinPickup } from "./sfx";

// Orchestrates the portfolio landmarks, mirroring NoteCoins:
//   1. landmarks come from content (landmarkPlacement), not the network
//      — so they render on the first frame instead of after a fetch
//   2. player landings publish peek state onto landmarkBus
//   3. proximity within PROXIMITY_TILES warms the emissive
//   4. visited state persists so a second visit is quieter
//
// Unlike coins these are NOT filtered by tile-break state: a monument
// standing on a broken tile still reads fine, and hiding the spawn
// monument the first time the player breaks the spawn tile was worse
// than leaving it floating.

const VISITED_KEY = "gooni-plaza-landmarks-v1";
const PROXIMITY_TILES = 2;

function loadVisited(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(VISITED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((s): s is string => typeof s === "string"));
  } catch {
    return new Set();
  }
}

function saveVisited(ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VISITED_KEY, JSON.stringify([...ids]));
  } catch {
    // Best-effort only.
  }
}

export function Landmarks() {
  const [playerGrid, setPlayerGrid] = useState<{ gx: number; gz: number } | null>(() => {
    const last = getLastPlayerLanding();
    return last ? { gx: last.gx, gz: last.gz } : null;
  });
  const [visited, setVisited] = useState<Set<string>>(() => loadVisited());
  const visitedRef = useRef(visited);
  useEffect(() => {
    visitedRef.current = visited;
  }, [visited]);

  // Landing → publish which landmark (if any) the player is standing on.
  useEffect(() => {
    return subscribeLandings((e) => {
      if (e.actor !== "player") return;
      if (e.fellOff) {
        setPlayerGrid(null);
        setLandmarkState({ active: null });
        return;
      }
      setPlayerGrid({ gx: e.gx, gz: e.gz });
      const hit = LANDMARKS.find((l) => l.gx === e.gx && l.gz === e.gz) ?? null;
      setLandmarkState({ active: hit });
      if (hit) {
        const seen = visitedRef.current.has(hit.id);
        if (!seen) playCoinPickup();
        const c = new THREE_Color(hit.color);
        fireVfx({
          kind: "puff",
          world: { x: e.world.x, y: 1.1, z: e.world.z },
          intensity: seen ? 0.6 : 1.25,
          color: { r: c.r, g: c.g, b: c.b },
        });
      }
    });
  }, []);

  // Resolve the standing tile whenever it changes, including the first
  // one. This component mounts only after the intro camera finishes, by
  // which point the spawn landing has already fired — so the subscriber
  // above alone would never resolve the tile the player is standing on
  // at world-entry, and a landmark on that tile would stay silent until
  // you hopped off and back. Falling back to the retained landing
  // covers the case where playerGrid hasn't been seeded yet.
  useEffect(() => {
    const g = playerGrid ?? getLastPlayerLanding();
    if (!g) return;
    const hit = LANDMARKS.find((l) => l.gx === g.gx && l.gz === g.gz) ?? null;
    setLandmarkState({ active: hit });
  }, [playerGrid]);

  const handleExpand = useCallback((l: LandmarkData) => {
    if (!visitedRef.current.has(l.id)) {
      const next = new Set(visitedRef.current);
      next.add(l.id);
      visitedRef.current = next;
      setVisited(next);
      saveVisited(next);
    }
    setLandmarkState({ expanded: l });
  }, []);

  const handleDismiss = useCallback(() => {
    setLandmarkState({ active: null });
  }, []);

  const handleClose = useCallback(() => {
    setLandmarkState({ expanded: null });
  }, []);

  useEffect(() => {
    setLandmarkState({ onExpand: handleExpand, onDismiss: handleDismiss, onClose: handleClose });
  }, [handleExpand, handleDismiss, handleClose]);

  useEffect(() => {
    return () => {
      setLandmarkState({ active: null, expanded: null });
    };
  }, []);

  return (
    <group>
      {LANDMARKS.map((l) => {
        const isNear =
          playerGrid !== null &&
          Math.abs(playerGrid.gx - l.gx) + Math.abs(playerGrid.gz - l.gz) <= PROXIMITY_TILES;
        return (
          <Landmark
            key={l.id}
            data={l}
            isNear={isNear}
            isVisited={visited.has(l.id)}
            onSelect={handleExpand}
          />
        );
      })}
    </group>
  );
}

// Local hex → linear-ish rgb for the vfx puff tint. Imported THREE just
// for Color would pull the whole namespace into this module for one
// conversion; this keeps it to the three lines actually needed.
class THREE_Color {
  r = 1;
  g = 1;
  b = 1;
  constructor(hex: string) {
    const h = hex.replace("#", "");
    if (h.length !== 6) return;
    this.r = parseInt(h.slice(0, 2), 16) / 255;
    this.g = parseInt(h.slice(2, 4), 16) / 255;
    this.b = parseInt(h.slice(4, 6), 16) / 255;
  }
}
