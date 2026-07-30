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

// ~30% smaller than the original gold-coin pass — these read as
// floating notes, not collectibles.
const COIN_BASE_Y = 1.30;       // height above tile top
const COIN_RADIUS = 0.315;
const COIN_THICKNESS = 0.07;
const SPIN_SPEED = (2 * Math.PI) / 4.5;  // ~4.5s per revolution
const BOB_AMP = 0.10;
const BOB_FREQ = (2 * Math.PI) / 3.0;    // 3s bob cycle
const BEAM_HEIGHT = 0.85;
const BEAM_RADIUS = 0.14;
const COIN_OPACITY = 0.80;
// Tilt the disc ~17° off vertical so it reads as a floating page,
// not a perfect coin face.
const COIN_TILT_Z = (17 * Math.PI) / 180;

// Cream paper (regular public note) with a faint teal-tinged emissive
// edge for warmth.
const COIN_COLOR = "#F5F0E8";
const COIN_EMISSIVE = "#9FE1CB";
const BEAM_COLOR = "#E7F4EE";

// Pinned ("what is Gooni" / start-here coin): vibrant violet paper body
// + punchy purple emissive edge. Distinguishes the spawn-anchored intro
// coin from the regular cream-paper notes scattered around the plaza —
// reads as the obvious "start here" anchor from across the plaza.
const PINNED_COIN_COLOR = "#C8A2F5";
const PINNED_COIN_EMISSIVE = "#9333EA";
const PINNED_BEAM_COLOR = "#B388F5";

// Read state: drained warmth — visited notes recede further.
const READ_COIN_COLOR = "#D7D2CA";
const READ_COIN_EMISSIVE = "#9C9A93";
const READ_BEAM_COLOR = "#CFCBC3";

// A little page-with-lines glyph stamped on the coin faces so it reads as
// a NOTE, not a blank chip. Drawn once to a canvas, shared across every
// coin (module-level singleton — one texture, not one per coin).
let _noteIcon: THREE.CanvasTexture | null | undefined;
function noteIconTexture(): THREE.CanvasTexture | null {
  if (_noteIcon !== undefined) return _noteIcon;
  const s = 128;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const g = c.getContext("2d");
  if (!g) {
    _noteIcon = null;
    return null;
  }
  // Just a few soft ruled lines — "writing on the note" — instead of a
  // hard dark page icon. Tonal + semi-transparent, so it reads as text on
  // the coin's OWN paper colour (cream / violet / grey) rather than a
  // pasted-on glyph.
  g.strokeStyle = "rgba(58,46,30,0.4)";
  g.lineCap = "round";
  g.lineWidth = 8;
  const lx = 42;
  const rx = s - 42;
  const rows = [50, 72, 94];
  rows.forEach((ly, i) => {
    g.beginPath();
    g.moveTo(lx, ly);
    g.lineTo(i === rows.length - 1 ? rx - 24 : rx, ly); // last line runs short
    g.stroke();
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  _noteIcon = t;
  return t;
}

type Props = {
  note: PublicNote;
  tile: BaseTile;
  isRead: boolean;
  isNear: boolean;
  /** Target opacity multiplier (1 = full, low = faded near the player). */
  fadeTarget: number;
  onSelect: (note: PublicNote, worldPos: THREE.Vector3) => void;
};

export function NoteCoin({ note, tile, isRead, isNear, fadeTarget, onSelect }: Props) {
  const spinnerRef = useRef<THREE.Group>(null);
  const beamRef = useRef<THREE.Mesh>(null);
  const coinMatRef = useRef<THREE.MeshToonMaterial>(null);
  const fadeRef = useRef(1); // eased opacity multiplier, → low when on-tile
  const [tileAlive, setTileAlive] = useState(true);
  const [hovered, setHovered] = useState(false);
  const reduceMotion = useReducedMotion();

  const toonGradient = useMemo(() => getToonGradient(), []);
  const noteIcon = useMemo(() => noteIconTexture(), []);
  const ICON_SIZE = COIN_RADIUS * 1.5;
  // One shared material for both coin faces so a single opacity write fades
  // the glyph in step with the coin body.
  const iconMat = useMemo(
    () =>
      noteIcon
        ? new THREE.MeshBasicMaterial({ map: noteIcon, transparent: true, depthWrite: false, toneMapped: false })
        : null,
    [noteIcon],
  );

  const isPinned = Boolean(note.is_public_pinned);

  // The pinned "start here" coin is the permanent plaza anchor — it must
  // stay vibrant violet even after Daniel has opened it once. So pinned
  // OUTRANKS read: a pinned coin never desaturates to the visited-gray
  // state. effRead drops read styling whenever the coin is pinned.
  const effRead = isRead && !isPinned;

  // Color choice cascades: pinned > read > regular paper.
  const coinColor = isPinned ? PINNED_COIN_COLOR : effRead ? READ_COIN_COLOR : COIN_COLOR;
  const coinEmissive = isPinned ? PINNED_COIN_EMISSIVE : effRead ? READ_COIN_EMISSIVE : COIN_EMISSIVE;
  const beamColor = isPinned ? PINNED_BEAM_COLOR : effRead ? READ_BEAM_COLOR : BEAM_COLOR;

  // Emissive intensity: paper-quiet by default. Hover/proximity warms
  // the edge slightly, never bright. Numbers tuned to keep the coin
  // from outshining the mushrooms + trees.
  const baseEmissive = isPinned ? 0.18 : effRead ? 0.04 : 0.10;
  const hoverEmissive = isPinned ? 0.32 : effRead ? 0.10 : 0.24;
  const nearBoost = effRead ? 0.0 : 0.08;
  const activeEmissive = (hovered ? hoverEmissive : baseEmissive) + (isNear ? nearBoost : 0);

  const spinSpeed = reduceMotion ? 0.2 : effRead ? SPIN_SPEED * 0.5 : SPIN_SPEED;
  const bobAmp = reduceMotion || effRead ? 0 : BOB_AMP;
  const beamOpacityBase = effRead ? 0.04 : 0.10;
  const beamOpacityBoost = effRead ? 0 : (isNear ? 0.06 : 0);

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
    // Ease toward the target fade — coin, glyph + beam all dim together so
    // the coin gets out of the way near the player / its own peek card.
    fadeRef.current += (fadeTarget - fadeRef.current) * Math.min(1, dt * 8);
    const fade = fadeRef.current;
    if (coinMatRef.current) coinMatRef.current.opacity = COIN_OPACITY * fade;
    if (iconMat) iconMat.opacity = fade;
    if (beam) {
      const mat = beam.material as THREE.MeshBasicMaterial;
      const pulse = reduceMotion
        ? beamOpacityBase + beamOpacityBoost
        : beamOpacityBase + beamOpacityBoost + 0.08 * (0.5 + 0.5 * Math.sin(now * BOB_FREQ + tile.gx));
      mat.opacity = pulse * fade;
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
      {/* Vertical beam — visible-from-far marker, dialed way down so it
          ambient-glows the tile instead of advertising. */}
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

      {/* Spinner group rotates around world-Y. Inner mesh keeps the
          [PI/2, 0, 0] tilt that stands the face vertical, plus a small
          Z tilt so the page sits ~17° off-axis (floating leaf, not
          coin face). */}
      <group ref={spinnerRef} position={[0, COIN_BASE_Y, 0]}>
        <mesh
          rotation={[Math.PI / 2, 0, COIN_TILT_Z]}
          onClick={handleClick}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
          castShadow
        >
          <cylinderGeometry args={[COIN_RADIUS, COIN_RADIUS, COIN_THICKNESS, 32]} />
          <meshToonMaterial
            ref={coinMatRef}
            color={coinColor}
            emissive={coinEmissive}
            emissiveIntensity={activeEmissive}
            gradientMap={toonGradient}
            transparent
            opacity={COIN_OPACITY}
            depthWrite={false}
          />
          {/* Note glyph on both faces (the cylinder axis is local Y after
              the tilt, so the faces sit at ±Y). Shared material → fades with
              the coin. */}
          {iconMat && (
            <>
              <mesh position={[0, COIN_THICKNESS / 2 + 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
                <planeGeometry args={[ICON_SIZE, ICON_SIZE]} />
                <primitive object={iconMat} attach="material" />
              </mesh>
              <mesh position={[0, -COIN_THICKNESS / 2 - 0.002, 0]} rotation={[Math.PI / 2, 0, 0]} renderOrder={2}>
                <planeGeometry args={[ICON_SIZE, ICON_SIZE]} />
                <primitive object={iconMat} attach="material" />
              </mesh>
            </>
          )}
        </mesh>
      </group>

    </group>
  );
}
