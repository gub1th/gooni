import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as THREE from "three";
import { Html } from "@react-three/drei";
import { fetchPublicNotes, type PublicNote } from "../../services/api";
import { buildTileGrid, tileKey } from "./tileGrid";
import { buildNoteTileMap } from "./noteTileMap";
import { subscribeLandings } from "./useDanielControls";
import { NoteCoin } from "./NoteCoin";

// Orchestrates note-coins across the plaza:
//   1. fetches public notes (cached 60s)
//   2. assigns each to a deterministic tile via buildNoteTileMap
//   3. tracks which tile the player is standing on via landing events
//   4. renders one NoteCoin per assignment; the coin for the current
//      tile renders its peek card

type Props = {
  onSelect: (note: PublicNote, worldPos: THREE.Vector3) => void;
};

export function NoteCoins({ onSelect }: Props) {
  const { data } = useQuery({
    queryKey: ["public-notes-coins"],
    queryFn: fetchPublicNotes,
    staleTime: 60_000,
  });

  // Recomputed when notes change. Tile grid itself is static.
  const tiles = useMemo(() => buildTileGrid(), []);
  const assignments = useMemo(() => {
    if (!data) return [];
    return buildNoteTileMap(data, tiles);
  }, [data, tiles]);

  // Tile the player is currently on. Updated on every landing event;
  // cleared when they fall off the world (sky-fall respawn).
  const [currentTileKey, setCurrentTileKey] = useState<string | null>(null);

  useEffect(() => {
    return subscribeLandings((e) => {
      if (e.fellOff) {
        setCurrentTileKey(null);
        return;
      }
      setCurrentTileKey(tileKey(e.gx, e.gz));
    });
  }, []);

  // Empty-state sign floats above plaza center when there are no
  // public notes to surface as coins.
  if (data && assignments.length === 0) {
    return <EmptyPlazaSign />;
  }

  if (!data) return null;

  return (
    <group>
      {assignments.map(({ note, tile }) => {
        const key = tileKey(tile.gx, tile.gz);
        return (
          <NoteCoin
            key={note.id}
            note={note}
            tile={tile}
            isCurrent={currentTileKey === key}
            onSelect={onSelect}
          />
        );
      })}
    </group>
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
