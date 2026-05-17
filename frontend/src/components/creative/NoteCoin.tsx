import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import type { PublicNote } from "../../services/api";
import { getToonGradient } from "./toonGradient";
import { subscribeTileState } from "./useDanielControls";
import { useReducedMotion } from "./useReducedMotion";
import type { BaseTile } from "./tileGrid";

// Floating coin above a note-tile. Spins around the world-Y axis (the
// classic Mario-coin look: coin face turns toward then away from the
// camera). Bobs up and down. Emits a soft vertical glow beam.
//
// Visual states:
//   - read:  dim emissive, slow spin, no bob — "already visited"
//   - near:  proximity boost — beam + emissive ramp when player is
//            within a couple of tiles, even before landing on this one
//   - reducedMotion: no bob, very slow spin, static beam opacity
//
// Hidden while the underlying tile is broken; returns on heal
// (Pokemon-coin lifecycle). Peek + expand UI lives in NoteCoins (a
// fixed bottom DOM bar) — this component is the visual marker only.

const COIN_BASE_Y = 1.30;       // height above tile top
const COIN_RADIUS = 0.45;
const COIN_THICKNESS = 0.10;
const SPIN_SPEED = 2.2;         // rad/s — around world-Y
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

// "Read" state desaturates the coin so visited notes recede.
const READ_COIN_COLOR = "#b0a48a";
const READ_COIN_EMISSIVE = "#6e6650";
const READ_BEAM_COLOR = "#b8b0a0";

type Props = {
  note: PublicNote;
  tile: BaseTile;
  isRead: boolean;
  isNear: boolean;
  onSelect: (note: PublicNote, worldPos: THREE.Vector3) => void;
};

export function NoteCoin({ note, tile, isRead, isNear, onSelect }: Props) {
  const spinnerRef = useRef<THREE.Group>(null);
  const beamRef = useRef<THREE.Mesh>(null);
  const [tileAlive, setTileAlive] = useState(true);
  const [hovered, setHovered] = useState(false);
  const reduceMotion = useReducedMotion();

  const toonGradient = useMemo(() => getToonGradient(), []);

  const isPinned = Boolean(note.is_public_pinned);

  // Color choice cascades: read > pinned > regular gold.
  const coinColor = isRead ? READ_COIN_COLOR : isPinned ? PINNED_COIN_COLOR : COIN_COLOR;
  const coinEmissive = isRead ? READ_COIN_EMISSIVE : isPinned ? PINNED_COIN_EMISSIVE : COIN_EMISSIVE;
  const beamColor = isRead ? READ_BEAM_COLOR : isPinned ? PINNED_BEAM_COLOR : BEAM_COLOR;

  // Emissive intensity: base by state, boosted on hover or proximity.
  const baseEmissive = isRead ? 0.08 : isPinned ? 0.45 : 0.30;
  const hoverEmissive = isRead ? 0.20 : isPinned ? 0.85 : 0.65;
  const nearBoost = isRead ? 0.0 : 0.20;  // read coins stay dim — don't re-attract
  const activeEmissive = (hovered ? hoverEmissive : baseEmissive) + (isNear ? nearBoost : 0);

  const spinSpeed = reduceMotion ? 0.2 : isRead ? SPIN_SPEED * 0.4 : SPIN_SPEED;
  const bobAmp = reduceMotion || isRead ? 0 : BOB_AMP;
  const beamOpacityBase = isRead ? 0.08 : 0.20;
  const beamOpacityBoost = isRead ? 0 : (isNear ? 0.14 : 0);

  useEffect(() => {
    return subscribeTileState((e) => {
      if (e.gx !== tile.gx || e.gz !== tile.gz) return;
      if (e.state === "broken") setTileAlive(false);
      else if (e.state === "healed") setTileAlive(true);
    });
  }, [tile.gx, tile.gz]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const spinner = spinnerRef.current;
    const beam = beamRef.current;
    if (!spinner) return;
    // Spin the WORLD-Y axis: spinner group has no tilt of its own, so
    // its local Y == world Y. The inner mesh has the [PI/2, 0, 0] tilt
    // that puts the coin face vertical.
    spinner.rotation.y += spinSpeed * dt;
    const now = performance.now() / 1000;
    const bob = bobAmp === 0 ? 0 : Math.sin(now * BOB_FREQ + tile.gx + tile.gz) * bobAmp;
    spinner.position.y = COIN_BASE_Y + bob;
    if (beam) {
      const mat = beam.material as THREE.MeshBasicMaterial;
      const pulse = reduceMotion
        ? beamOpacityBase + beamOpacityBoost
        : beamOpacityBase + beamOpacityBoost + 0.08 * (0.5 + 0.5 * Math.sin(now * BOB_FREQ + tile.gx));
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
    <group position={[tile.x, 0, tile.z]}>
      {/* Vertical beam — visible-from-far marker */}
      <mesh ref={beamRef} position={[0, BEAM_HEIGHT / 2 + 0.15, 0]}>
        <cylinderGeometry args={[BEAM_RADIUS, BEAM_RADIUS * 0.6, BEAM_HEIGHT, 16, 1, true]} />
        <meshBasicMaterial
          color={beamColor}
          transparent
          opacity={beamOpacityBase}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Spinner group rotates around world-Y. Inner mesh has the tilt
          so the coin face stands vertical. */}
      <group ref={spinnerRef} position={[0, COIN_BASE_Y, 0]}>
        <mesh
          rotation={[Math.PI / 2, 0, 0]}
          onClick={handleClick}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
          castShadow
        >
          <cylinderGeometry args={[COIN_RADIUS, COIN_RADIUS, COIN_THICKNESS, 32]} />
          <meshToonMaterial
            color={coinColor}
            emissive={coinEmissive}
            emissiveIntensity={activeEmissive}
            gradientMap={toonGradient}
          />
        </mesh>
      </group>
    </group>
  );
}
