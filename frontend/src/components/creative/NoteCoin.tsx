import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import type { PublicNote } from "../../services/api";
import { getToonGradient } from "./toonGradient";
import { NotePeekCard } from "./NotePeekCard";
import { subscribeTileState } from "./useDanielControls";
import type { BaseTile } from "./tileGrid";

// Floating gold coin above a note-tile. Spins on Y, bobs slightly,
// emits a soft vertical glow beam so it reads as an "objective" from
// across the plaza. Hidden while the underlying tile is broken; comes
// back on heal (Pokemon-coin lifecycle).
//
// Click → onSelect(note, worldPos) → Scene.handleSelect → expands into
// the existing NoteReaderOverlay fullscreen reader.

const COIN_BASE_Y = 1.30;       // height above tile top
const COIN_RADIUS = 0.42;
const COIN_THICKNESS = 0.10;
const SPIN_SPEED = 1.6;         // rad/s
const BOB_AMP = 0.10;
const BOB_FREQ = 1.2;           // rad/s
const BEAM_HEIGHT = 1.1;
const BEAM_RADIUS = 0.18;

// Gold coin (regular public note).
const COIN_COLOR = "#ffd56b";
const COIN_EMISSIVE = "#ffaa1f";
const BEAM_COLOR = "#fff1c2";

// Rose-magenta coin (pinned public note) — distinct silhouette from
// across the plaza so a YC-reviewer-style "start here" reads at a
// glance.
const PINNED_COIN_COLOR = "#ff7ab8";
const PINNED_COIN_EMISSIVE = "#ff3d8c";
const PINNED_BEAM_COLOR = "#ffd6ea";

type Props = {
  note: PublicNote;
  tile: BaseTile;
  isCurrent: boolean;
  onSelect: (note: PublicNote, worldPos: THREE.Vector3) => void;
};

export function NoteCoin({ note, tile, isCurrent, onSelect }: Props) {
  const isPinned = Boolean(note.is_public_pinned);
  const coinColor = isPinned ? PINNED_COIN_COLOR : COIN_COLOR;
  const coinEmissive = isPinned ? PINNED_COIN_EMISSIVE : COIN_EMISSIVE;
  const beamColor = isPinned ? PINNED_BEAM_COLOR : BEAM_COLOR;
  const baseEmissive = isPinned ? 0.45 : 0.30;
  const hoverEmissive = isPinned ? 0.75 : 0.55;
  const coinRef = useRef<THREE.Mesh>(null);
  const beamRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);
  const [tileAlive, setTileAlive] = useState(true);
  const [hovered, setHovered] = useState(false);

  const toonGradient = useMemo(() => getToonGradient(), []);

  useEffect(() => {
    return subscribeTileState((e) => {
      if (e.gx !== tile.gx || e.gz !== tile.gz) return;
      if (e.state === "broken") setTileAlive(false);
      else if (e.state === "healed") setTileAlive(true);
    });
  }, [tile.gx, tile.gz]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const coin = coinRef.current;
    const beam = beamRef.current;
    if (!coin) return;
    coin.rotation.y += SPIN_SPEED * dt;
    const now = performance.now() / 1000;
    const bob = Math.sin(now * BOB_FREQ + tile.gx + tile.gz) * BOB_AMP;
    coin.position.y = COIN_BASE_Y + bob;
    if (beam) {
      // Beam pulses opacity in sync with bob so the column reads as a
      // soft heartbeat under the coin.
      const mat = beam.material as THREE.MeshBasicMaterial;
      const pulse = 0.18 + 0.10 * (0.5 + 0.5 * Math.sin(now * BOB_FREQ + tile.gx));
      mat.opacity = pulse;
    }
  });

  function handleClick(e: ThreeEvent<MouseEvent>) {
    e.stopPropagation();
    if (!tileAlive) return;
    const world = new THREE.Vector3(tile.x, COIN_BASE_Y, tile.z);
    onSelect(note, world);
  }

  function handlePointerEnter(e: ThreeEvent<PointerEvent>) {
    e.stopPropagation();
    setHovered(true);
    document.body.style.cursor = "pointer";
  }

  function handlePointerLeave() {
    setHovered(false);
    document.body.style.cursor = "";
  }

  if (!tileAlive) return null;

  return (
    <group ref={groupRef} position={[tile.x, 0, tile.z]}>
      {/* Vertical beam (visible-from-far marker) */}
      <mesh ref={beamRef} position={[0, BEAM_HEIGHT / 2 + 0.15, 0]}>
        <cylinderGeometry args={[BEAM_RADIUS, BEAM_RADIUS * 0.6, BEAM_HEIGHT, 16, 1, true]} />
        <meshBasicMaterial
          color={beamColor}
          transparent
          opacity={0.20}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Coin */}
      <mesh
        ref={coinRef}
        position={[0, COIN_BASE_Y, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        onClick={handleClick}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        castShadow
      >
        <cylinderGeometry args={[COIN_RADIUS, COIN_RADIUS, COIN_THICKNESS, 24]} />
        <meshToonMaterial
          color={coinColor}
          emissive={coinEmissive}
          emissiveIntensity={hovered ? hoverEmissive : baseEmissive}
          gradientMap={toonGradient}
        />
      </mesh>

      {isCurrent && (
        <NotePeekCard
          note={note}
          height={COIN_BASE_Y + 0.95}
        />
      )}
    </group>
  );
}
