import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as THREE from "three";
import { Html } from "@react-three/drei";
import { fetchPublicNotes, type PublicNote } from "../../services/api";
import { buildTileGrid, tileKey } from "./tileGrid";
import { buildNoteTileMap } from "./noteTileMap";
import { subscribeLandings, subscribeTileState } from "./useDanielControls";
import { fireVfx } from "./vfx";
import { playCoinPickup } from "./sfx";
import { NoteCoin } from "./NoteCoin";
import { NotePeekCard } from "./NotePeekCard";

// Orchestrates note-coins across the plaza:
//   1. fetches public notes (cached 60s)
//   2. assigns each to a deterministic tile via buildNoteTileMap
//   3. tracks player landings (filtered to actor="player" so NPC hops
//      don't pop the peek)
//   4. renders one NoteCoin per assignment plus a bottom-anchored
//      NotePeekCard portal showing the current note's title + excerpt;
//      click peek → onSelect → fullscreen NoteReaderOverlay
//   5. proximity glow: coins within 2 tiles of player ramp emissive
//   6. read state: localStorage tracks expanded notes; visited coins
//      desaturate so the plaza becomes a journey log

const READ_STORAGE_KEY = "gooni-creative-read-v1";
const PROXIMITY_TILES = 2;

function loadReadIds(): Set<number> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(READ_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((n) => typeof n === "number"));
  } catch {
    return new Set();
  }
}

function saveReadIds(ids: Set<number>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(READ_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Quota exceeded / disabled — ignore; read state is best-effort.
  }
}

type Props = {
  onSelect: (note: PublicNote, worldPos: THREE.Vector3) => void;
};

export function NoteCoins({ onSelect }: Props) {
  const { data } = useQuery({
    queryKey: ["public-notes-coins"],
    queryFn: fetchPublicNotes,
    staleTime: 60_000,
  });

  const tiles = useMemo(() => buildTileGrid(), []);
  const assignments = useMemo(() => {
    if (!data) return [];
    return buildNoteTileMap(data, tiles);
  }, [data, tiles]);

  const noteByTile = useMemo(() => {
    const m = new Map<string, PublicNote>();
    for (const a of assignments) m.set(tileKey(a.tile.gx, a.tile.gz), a.note);
    return m;
  }, [assignments]);

  // Read tracking — set of note IDs already expanded. Persisted to
  // localStorage so the plaza reflects history across sessions.
  const [readIds, setReadIds] = useState<Set<number>>(() => loadReadIds());

  // Latest player landing — drives proximity glow + current peek tile.
  const [playerGrid, setPlayerGrid] = useState<{ gx: number; gz: number } | null>(null);
  const [currentNote, setCurrentNote] = useState<PublicNote | null>(null);

  // Refs let the landing subscriber read current assignment + read
  // state without re-subscribing on every change.
  const assignmentsRef = useRef(assignments);
  const readIdsRef = useRef(readIds);
  useEffect(() => { assignmentsRef.current = assignments; }, [assignments]);
  useEffect(() => { readIdsRef.current = readIds; }, [readIds]);

  useEffect(() => {
    return subscribeLandings((e) => {
      if (e.actor !== "player") return;
      if (e.fellOff) {
        setPlayerGrid(null);
        setCurrentNote(null);
        return;
      }
      setPlayerGrid({ gx: e.gx, gz: e.gz });
      const note = noteByTile.get(tileKey(e.gx, e.gz)) ?? null;
      setCurrentNote(note);
      // Pickup chime + sparkle burst when player lands on a coin-tile.
      // Use the assignment's pinned-or-not status for tint so the
      // sparkle matches the coin (rose for pinned, gold for regular).
      if (note) {
        const assignment = assignmentsRef.current.find((a) => a.note.id === note.id);
        if (assignment) {
          const isPinned = Boolean(note.is_public_pinned);
          const isRead = readIdsRef.current.has(note.id);
          // Re-reading shouldn't re-chime — feels noisy on every revisit.
          if (!isRead) {
            playCoinPickup();
          }
          fireVfx({
            kind: "puff",
            world: { x: e.world.x, y: 1.30, z: e.world.z },
            intensity: isRead ? 0.6 : 1.1,
            color: isPinned
              ? { r: 1.0, g: 0.55, b: 0.78 }     // rose-magenta
              : { r: 1.0, g: 0.85, b: 0.42 },    // gold
          });
        }
      }
    });
  }, [noteByTile]);

  // Hide peek + drop current if the standing tile breaks under us.
  useEffect(() => {
    return subscribeTileState((e) => {
      if (e.state !== "broken") return;
      setCurrentNote((prev) => {
        if (!prev) return prev;
        const tileNote = noteByTile.get(tileKey(e.gx, e.gz));
        return tileNote && tileNote.id === prev.id ? null : prev;
      });
    });
  }, [noteByTile]);

  const handleExpand = useCallback((note: PublicNote) => {
    const assignment = assignmentsRef.current.find((a) => a.note.id === note.id);
    if (!assignment) return;
    // Mark read on expand — that's the meaningful "I opened this"
    // signal, not the peek-on-land.
    if (!readIdsRef.current.has(note.id)) {
      const next = new Set(readIdsRef.current);
      next.add(note.id);
      readIdsRef.current = next;
      setReadIds(next);
      saveReadIds(next);
    }
    const world = new THREE.Vector3(assignment.tile.x, 1.30, assignment.tile.z);
    onSelect(note, world);
  }, [onSelect]);

  const handleDismiss = useCallback(() => {
    setCurrentNote(null);
  }, []);

  // Empty-state sign floats above plaza center when there are no
  // public notes to surface as coins.
  if (data && assignments.length === 0) {
    return <EmptyPlazaSign />;
  }

  if (!data) return null;

  return (
    <>
      <group>
        {assignments.map(({ note, tile }) => {
          const isRead = readIds.has(note.id);
          const isNear =
            playerGrid !== null &&
            Math.abs(playerGrid.gx - tile.gx) + Math.abs(playerGrid.gz - tile.gz) <= PROXIMITY_TILES;
          return (
            <NoteCoin
              key={note.id}
              note={note}
              tile={tile}
              isRead={isRead}
              isNear={isNear}
              onSelect={onSelect}
            />
          );
        })}
      </group>
      <NotePeekCard note={currentNote} onExpand={handleExpand} onDismiss={handleDismiss} />
    </>
  );
}

const FONT = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
const DISPLAY = "'Iowan Old Style', 'Hoefler Text', Georgia, 'Times New Roman', serif";

function EmptyPlazaSign() {
  return (
    <Html
      position={[0, 2.4, 0]}
      center
      distanceFactor={9}
      pointerEvents="none"
      zIndexRange={[60, 70]}
      style={{ pointerEvents: "none" }}
    >
      <div
        style={{
          background: "rgba(20,22,28,0.78)",
          color: "#fff",
          padding: "12px 18px",
          borderRadius: 14,
          fontFamily: FONT,
          userSelect: "none",
          backdropFilter: "blur(8px) saturate(160%)",
          WebkitBackdropFilter: "blur(8px) saturate(160%)",
          boxShadow: "0 6px 22px rgba(0,0,0,0.42), 0 0 0 1px rgba(255,255,255,0.10) inset",
          textAlign: "center",
        }}
      >
        <div style={{ fontFamily: DISPLAY, fontSize: 18, color: "#ffe79a", marginBottom: 4 }}>
          empty plaza
        </div>
        <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.78)" }}>
          no public notes yet — coins will appear here once one is published
        </div>
      </div>
    </Html>
  );
}
