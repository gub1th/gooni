import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as THREE from "three";
import { Avatar } from "./Avatar";
import { fetchPublicNotes, type PublicNote } from "../../services/api";

type Props = {
  onSelect: (note: PublicNote, worldPos: THREE.Vector3) => void;
  focusedNoteId: number | null;
};

// Fetches public notes once + spawns an Avatar per note. Initial
// positions are deterministic from each note's id so the layout is
// stable across reloads, but per-frame wander state lives inside each
// Avatar.
export function AvatarCrowd({ onSelect, focusedNoteId }: Props) {
  const { data } = useQuery({
    queryKey: ["public-notes-crowd"],
    queryFn: fetchPublicNotes,
    staleTime: 60_000,
  });

  const [hoveredId, setHoveredId] = useState<number | null>(null);

  const positions = useMemo(() => {
    if (!data) return new Map<number, THREE.Vector3>();
    const m = new Map<number, THREE.Vector3>();
    data.forEach((n, i) => {
      // Spread across a sunflower-spiral pattern so distribution is
      // even without grid artifacts.
      const golden = Math.PI * (3 - Math.sqrt(5));
      const r = Math.sqrt(i / Math.max(1, data.length)) * 11;
      const a = i * golden + (n.id % 360) * 0.01;
      m.set(n.id, new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    });
    return m;
  }, [data]);

  if (!data || data.length === 0) return null;

  return (
    <group>
      {data.map((note) => {
        const pos = positions.get(note.id);
        if (!pos) return null;
        return (
          <group
            key={note.id}
            onPointerEnter={(e) => {
              e.stopPropagation();
              setHoveredId(note.id);
              document.body.style.cursor = "pointer";
            }}
            onPointerLeave={() => {
              setHoveredId((id) => (id === note.id ? null : id));
              document.body.style.cursor = "";
            }}
          >
            <Avatar
              note={note}
              initialPos={pos}
              onClick={onSelect}
              hovered={hoveredId === note.id}
              focused={focusedNoteId === note.id}
              active={focusedNoteId === null}
            />
          </group>
        );
      })}
    </group>
  );
}
