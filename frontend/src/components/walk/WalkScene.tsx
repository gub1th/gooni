import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { AdaptiveDpr, RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import { Clouds } from "../creative/Clouds";
import { playJumpGrunt, playLandThud } from "../creative/sfx";
import { GLTFGooni, type GooniHandle } from "../creative/GLTFGooni";
import { getToonGradient } from "../creative/toonGradient";
import { getIdentity } from "../creative/avatarIdentity";
import { useReducedMotion } from "../creative/useReducedMotion";
import { STATIONS, type Station } from "../../content/walk";
import { PROFILE } from "../../content/portfolio";
import { getScroll } from "./scrollBus";
import { BIOMES, type PropKind } from "./biomes";
import { getBiome, updateBiome } from "./biomeBus";
import { playFall } from "../creative/sfx";

// The 3D backdrop for the walk — a hopping TREADMILL.
//
// The reader never actually travels. Gooni hops in place at a fixed spot;
// the FLOOR streams past underneath (a narrow tile strip), which is what
// sells forward motion. The world doesn't scroll props past you either —
// a small fixed DIORAMA stays put and MORPHS through the biomes as you
// advance, and one big poster swaps its content with a TV-static burst.
// Progressing the page is like flipping channels, not walking a road.
//
// Still a BACKDROP: pointer-events off, no controls, nothing here needed
// to read the page. The DOM sections carry every word; if WebGL is off the
// page is still complete. Scroll drives it all via scrollBus.walkPos.

const toon = getToonGradient();

const TILE = 2.0;
const STRIP_HALF = 1; // 3 tiles wide (-1, 0, 1)
const HOP_H = 0.7;
const JUMP_DUR = 0.5; // one deliberate jump per advance, not a rapid bounce
// The strip ENDS exactly under the last station — the character stands on
// the final tile at the very edge, void immediately ahead, so pressing
// forward / over-scrolling walks straight off. (LAST_STATION * STATION_SCROLL
// = 40, so treadZ tops out with the char over local z = -40.)
const LAST_STATION = 4;
const STRIP_END = -40; // last tile == the character's edge-station tile
const TAPER_FROM = -34; // narrow to a single-file spit before the end
const WALK_FACING = Math.PI; // face down-path, back to the camera
const CHAR_X = 0;
const CHAR_Z = 0;
const POSTER_H = 3.4; // big — sized for video later

// World units of floor scroll per station. walkPos (hero −1 … footer 5)
// times this is how far the treadmill has run; the character hops once per
// TILE of it.
const STATION_SCROLL = TILE * 5;

// Static pose: camera well to the left looking at the character, which puts
// Gooni + the strip near screen-centre and the poster off to the right —
// leaving the left third clear for the DOM copy card.
const CAM_POS: [number, number, number] = [-7.5, 5.2, 10];
const CAM_LOOK = new THREE.Vector3(0, 1.3, -4);

// Treadmill floor scroll + the character's hop, driven TOGETHER so they can't
// drift. Module-level (read every frame in useFrame, must not re-render). One
// driver (TreadmillDriver, mounted first) advances all of it: the floor moves
// ONLY during a hop and lands with it — no pre-slide, no post-slide.
let treadZ = 0;
let charJumpY = 0.35;
let charJumping = false;
const treadStep = { active: false, t: 0, fromZ: 0, toZ: 0, lastStation: 0, ready: false };

export function WalkScene() {
  // scrollBus + these module vars survive route changes; reset on mount so
  // re-entering the walk doesn't start mid-scroll from a stale value.
  useEffect(() => {
    treadZ = 0;
    charJumpY = 0.35;
    charJumping = false;
    treadStep.active = false;
    treadStep.ready = false;
  }, []);

  return (
    <div aria-hidden style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "auto" }}>
      <Canvas
        dpr={[1, 1.75]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        camera={{ fov: 42, near: 0.1, far: 500, position: CAM_POS }}
      >
        <AdaptiveDpr pixelated />
        {/* First each frame: ease the treadmill, then blend the biome. */}
        <TreadmillDriver />
        <BiomeDriver />
        <fogExp2 attach="fog" args={["#e8e0d0", 0.012]} />
        <BiomeSky />
        <BiomeLights />
        <Clouds />
        <Treadmill />
        <LinkTiles />
        <Diorama />
        <PosterFixture />
        <BiomeParticles />
        <Suspense fallback={null}>
          <Walker />
        </Suspense>
        <StaticCamera />
      </Canvas>
    </div>
  );
}

// ── drivers ─────────────────────────────────────────────────────────

function TreadmillDriver() {
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    // Nearest station (clamped at the last — the footer must not scroll past
    // the edge; the over-scroll fall takes it from the island's end).
    const station = Math.round(Math.min(getScroll().walkPos, LAST_STATION));
    const s = treadStep;
    if (!s.ready) {
      s.ready = true;
      s.lastStation = station;
      treadZ = station * STATION_SCROLL;
      charJumpY = 0.35;
      charJumping = false;
      return;
    }
    // A station changed → fire ONE hop that CARRIES the floor with it. The
    // floor + the arc share the same eased progress, so they start and stop
    // together (the "slide before/after the jump" bug was the floor easing
    // continuously while the hop was a separate discrete arc).
    if (!s.active && station !== s.lastStation) {
      s.active = true;
      s.t = 0;
      s.fromZ = treadZ;
      s.toZ = station * STATION_SCROLL;
      s.lastStation = station;
      charJumping = true;
      playJumpGrunt(); // hop off (muted globally via setSfxMuted)
    }
    if (s.active) {
      s.t += dt;
      const u = Math.min(1, s.t / JUMP_DUR);
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; // easeInOut
      treadZ = s.fromZ + (s.toZ - s.fromZ) * e;
      charJumpY = 0.35 + Math.sin(u * Math.PI) * HOP_H;
      if (u >= 1) {
        s.active = false;
        treadZ = s.toZ;
        charJumpY = 0.35;
        charJumping = false;
        playLandThud(); // touch down
      }
    }
  });
  return null;
}

// Blends the two adjacent biomes by scroll position and pushes it into the
// scene fog. Everything else reads getBiome().
function BiomeDriver() {
  useFrame((state) => {
    updateBiome(getScroll().walkPos);
    const b = getBiome();
    const fog = state.scene.fog as THREE.FogExp2 | null;
    if (fog && (fog as THREE.FogExp2).isFogExp2) {
      fog.color.copy(b.fogColor);
      fog.density = b.fogDensity;
    }
  });
  return null;
}

// Static camera — no follow. The whole point of the treadmill is that the
// frame holds still while the world flows through it. EXCEPT the fall off
// the edge: then the frame itself plunges + the FOV widens (freefall) with
// a cartoon falling scream, mirroring the plaza jump-in.
function StaticCamera() {
  const fallStart = useRef<number | null>(null);
  const heldY = useRef(0);
  const heldFov = useRef(42);
  useFrame((state) => {
    const cam = state.camera as THREE.PerspectiveCamera;
    if (getScroll().falling) {
      if (fallStart.current === null) {
        fallStart.current = performance.now();
        heldY.current = cam.position.y;
        heldFov.current = cam.fov;
        playFall();
      }
      const e = Math.min(1, (performance.now() - fallStart.current) / 1200) ** 2;
      cam.position.y = heldY.current - 22 * e;
      cam.fov = heldFov.current + 24 * e;
      cam.updateProjectionMatrix();
      cam.lookAt(CHAR_X, cam.position.y - 6, CHAR_Z);
      return;
    }
    fallStart.current = null;
    cam.lookAt(CAM_LOOK);
  });
  return null;
}

// ── the treadmill floor ─────────────────────────────────────────────

function Treadmill() {
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const matRef = useRef<THREE.MeshToonMaterial>(null);

  const tiles = useMemo(() => {
    const out: { x: number; y: number; z: number; jitter: number }[] = [];
    // Long enough to cover the whole run under the fixed character (the
    // strip translates, it doesn't recycle — the journey is bounded). Past
    // TAPER_FROM it narrows to a single file and stops at STRIP_END, so the
    // last station sits right at the island's edge.
    for (let z = 12; z >= STRIP_END; z -= TILE) {
      const single = z < TAPER_FROM;
      for (let c = -STRIP_HALF; c <= STRIP_HALF; c++) {
        if (single && c !== 0) continue;
        const h = Math.abs(c * 37 + z * 71 + c * z * 13) & 0xff;
        out.push({ x: c * TILE, y: (((h >> 2) & 0xff) / 255 - 0.5) * 0.05, z, jitter: ((h >> 4) / 255 - 0.5) * 0.05 });
      }
    }
    return out;
  }, []);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const d = new THREE.Object3D();
    tiles.forEach((t, i) => {
      d.position.set(t.x, t.y, t.z);
      d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);
      // Faint per-tile lightness variation; the biome tint rides on top via
      // the shared material colour (instanceColor × material.color).
      mesh.setColorAt(i, new THREE.Color(1, 1, 1).offsetHSL(0, 0, t.jitter));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [tiles]);

  useFrame(() => {
    // Stream the whole strip toward the camera as the treadmill runs.
    if (groupRef.current) groupRef.current.position.z = treadZ;
    // Re-tint to the blended biome — smooth as walkPos crosses biomes.
    if (matRef.current) matRef.current.color.copy(getBiome().ground);
  });

  return (
    <group ref={groupRef}>
      <instancedMesh ref={meshRef} args={[undefined, undefined, tiles.length]} receiveShadow>
        <boxGeometry args={[TILE * 0.97, 0.5, TILE * 0.97]} />
        <meshToonMaterial ref={matRef} color="#ffffff" gradientMap={toon} />
      </instancedMesh>
    </group>
  );
}

// ── engraved link tiles ─────────────────────────────────────────────
//
// The wayfinding links carved into the START floor tiles (view cv · resume ·
// linkedin · github), lying flat so they read as engraved at the camera's
// angle. They ride the treadmill (so they scroll away) and FADE once the
// reader has moved past the intro — no reason to keep them once you're gone.
// Real clickable/hover meshes (the 3D layer's pointer-events are on).

// Official brand marks (24×24), drawn via Path2D.
const GITHUB_PATH =
  "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12";
const LINKEDIN_PATH =
  "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z";

type LinkIcon = "cv" | "resume" | "github" | "linkedin";

// The tile face, modelled on the "view cv" pill: a glowing-green icon sitting
// in a soft dark-green disc, with a muted-gray label under it (cv/résumé). The
// socials are logo-ONLY (no label, Daniel) in their real brand white marks. cv =
// a page you read (doc + lines); resume = a file you download (doc + down-arrow).
function makeLinkTexture(
  label: string,
  icon: LinkIcon,
  iconColor: string,
  labelColor: string,
  showLabel: boolean,
  disc: boolean,
): THREE.CanvasTexture | null {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const g = c.getContext("2d");
  if (!g) return null;
  g.clearRect(0, 0, S, S);

  // Icon rides high when there's a label under it; dead-centre when logo-only.
  const cx = S / 2;
  const iconCY = showLabel ? 96 : 128;

  // Soft dark-green glow disc behind the icon — the pill's signature.
  if (disc) {
    g.fillStyle = "rgba(74,222,128,0.16)";
    g.beginPath();
    g.arc(cx, iconCY, 66, 0, Math.PI * 2);
    g.fill();
  }

  if (icon === "github" || icon === "linkedin") {
    const size = 106;
    const scale = size / 24;
    const p = new Path2D(icon === "github" ? GITHUB_PATH : LINKEDIN_PATH);
    g.save();
    g.translate(cx - size / 2, iconCY - size / 2);
    g.scale(scale, scale);
    g.fillStyle = iconColor;
    g.fill(p);
    g.restore();
  } else if (icon === "cv") {
    // "read" — a document with text lines.
    g.save();
    g.strokeStyle = iconColor;
    g.lineJoin = "round";
    g.lineCap = "round";
    const pw = 58;
    const ph = 74;
    const px = cx - pw / 2;
    const py = iconCY - ph / 2;
    g.lineWidth = 7;
    g.beginPath();
    g.roundRect(px, py, pw, ph, 8);
    g.stroke();
    g.lineWidth = 6;
    for (let i = 0; i < 4; i++) {
      const ly = py + 20 + i * 15;
      g.beginPath();
      g.moveTo(px + 13, ly);
      g.lineTo(px + pw - 13, ly);
      g.stroke();
    }
    g.restore();
  } else {
    // "download" — a down-arrow landing on a tray. Distinct from the cv doc.
    g.save();
    g.strokeStyle = iconColor;
    g.lineJoin = "round";
    g.lineCap = "round";
    g.lineWidth = 8;
    const topY = iconCY - 34;
    const tipY = iconCY + 16;
    g.beginPath();
    g.moveTo(cx, topY);
    g.lineTo(cx, tipY);
    g.stroke();
    const a = 20;
    g.beginPath();
    g.moveTo(cx - a, tipY - a);
    g.lineTo(cx, tipY);
    g.lineTo(cx + a, tipY - a);
    g.stroke();
    const tw = 66;
    const tray = iconCY + 34;
    g.beginPath();
    g.moveTo(cx - tw / 2, tray);
    g.lineTo(cx - tw / 2, tray + 12);
    g.lineTo(cx + tw / 2, tray + 12);
    g.lineTo(cx + tw / 2, tray);
    g.stroke();
    g.restore();
  }

  if (showLabel) {
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = "600 38px Inter, system-ui, -apple-system, sans-serif";
    g.fillStyle = labelColor;
    g.fillText(label, cx, 208);
  }

  return finishScreenTex(c);
}

function linkFade(): number {
  // Full at the intro (treadZ ≈ −10), gone by ~station 0.
  return Math.max(0, Math.min(1, 1 - Math.max(0, treadZ + 6) / 8));
}

// Very-slightly-rounded square shared by every tile's block + glow. One
// ShapeGeometry reused across all tiles.
const TILE_SIDE = TILE * 0.97;
const TILE_GEO = (() => {
  const w = TILE_SIDE;
  const h = TILE_SIDE;
  const r = 0.16; // subtle corner
  const x = -w / 2;
  const y = -h / 2;
  const s = new THREE.Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return new THREE.ShapeGeometry(s);
})();

function LinkTiles() {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    if (ref.current) ref.current.position.z = treadZ; // rides the floor
  });
  const links = useMemo(() => {
    const li = PROFILE.links.find((l) => /linkedin/i.test(l.label))?.href ?? "#";
    const gh = PROFILE.links.find((l) => /github/i.test(l.label))?.href ?? "#";
    // cv/résumé mirror the "view cv" pill: DARK tile, glowing-green icon in a
    // soft disc, muted-gray label. The socials are logo-ONLY (no text) on their
    // real brand tile (black github / blue linkedin) with a white mark.
    const GLOW = "#4ADE80"; // the true ambient green (block is toneMapped=false)
    const INK = "#DBD9D2"; // the pill's muted-gray label
    const DARK = "#23272b";
    const W = "#ffffff";
    return [
      { label: "cv", href: "/public/cv", icon: "cv" as LinkIcon, x: -TILE, z: 12, tile: DARK, iconColor: GLOW, labelColor: INK, showLabel: true, disc: true },
      { label: "resume", href: PROFILE.resumeHref, icon: "resume" as LinkIcon, x: 0, z: 12, tile: DARK, iconColor: GLOW, labelColor: INK, showLabel: true, disc: true },
      { label: "linkedin", href: li, icon: "linkedin" as LinkIcon, x: TILE, z: 12, tile: "#0A66C2", iconColor: W, labelColor: W, showLabel: false, disc: false },
      { label: "github", href: gh, icon: "github" as LinkIcon, x: TILE, z: 10, tile: "#0d0d0d", iconColor: W, labelColor: W, showLabel: false, disc: false },
    ];
  }, []);
  return (
    <group ref={ref}>
      {links.map((l) => (
        <LinkTile key={l.label} {...l} />
      ))}
    </group>
  );
}

function LinkTile({
  label,
  href,
  icon,
  x,
  z,
  tile,
  iconColor,
  labelColor,
  showLabel,
  disc,
}: {
  label: string;
  href: string;
  icon: LinkIcon;
  x: number;
  z: number;
  tile: string;
  iconColor: string;
  labelColor: string;
  showLabel: boolean;
  disc: boolean;
}) {
  const block = useRef<THREE.MeshBasicMaterial>(null);
  const eng = useRef<THREE.MeshBasicMaterial>(null);
  const glow = useRef<THREE.MeshBasicMaterial>(null);
  const tex = useMemo(
    () => makeLinkTexture(label, icon, iconColor, labelColor, showLabel, disc),
    [label, icon, iconColor, labelColor, showLabel, disc],
  );
  const [hover, setHover] = useState(false);
  useFrame((_, rawDt) => {
    const f = linkFade();
    if (block.current) block.current.opacity = f;
    if (eng.current) eng.current.opacity = f;
    // Additive green glow eases in on hover (bloom-free "glows on hover").
    if (glow.current) {
      const target = hover ? 0.32 * f : 0;
      glow.current.opacity += (target - glow.current.opacity) * Math.min(1, rawDt * 12);
    }
  });
  const open = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    window.open(href, href.startsWith("/") ? "_self" : "_blank", "noopener");
  };
  return (
    <group position={[x, 0, z]}>
      {/* Solid brand block — slightly rounded corners (shared TILE_GEO).
          toneMapped OFF so the tile colour is true (no washed-out tone-map). */}
      <mesh
        geometry={TILE_GEO}
        position={[0, 0.262, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        onClick={open}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHover(false);
          document.body.style.cursor = "";
        }}
      >
        <meshBasicMaterial ref={block} color={tile} toneMapped={false} transparent depthWrite={false} />
      </mesh>
      {/* Icon + label engraving (inset). */}
      <mesh position={[0, 0.27, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[TILE * 0.9, TILE * 0.9]} />
        <meshBasicMaterial ref={eng} map={tex} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      {/* Green additive glow — same footprint, fades in on hover. */}
      <mesh geometry={TILE_GEO} position={[0, 0.28, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <meshBasicMaterial
          ref={glow}
          color="#4ADE80"
          transparent
          opacity={0}
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  );
}

// ── the walker (hops in place) ──────────────────────────────────────

function Walker() {
  const group = useRef<THREE.Group>(null);
  const gooni = useRef<GooniHandle>(null);
  const fall = useRef(0);
  const fellStarted = useRef(false);
  const clipJumping = useRef(false);
  const faceTarget = useRef(WALK_FACING);
  const me = useMemo(() => getIdentity(), []);

  // Plant an Idle the moment the GLTF resolves so it's never a T-pose.
  useEffect(() => {
    gooni.current?.setClip("Idle", { loop: true });
  }, []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const g = group.current;
    if (!g) return;

    // Over-scrolled past the end → JUMP off the edge, then freefall back to
    // the plaza. Launch up first (v0·u), then gravity (−½g·u²), so it reads
    // as leaping off, not toppling over.
    if (getScroll().falling) {
      fall.current += dt;
      const u = fall.current;
      if (!fellStarted.current) {
        fellStarted.current = true;
        gooni.current?.setClip("HitReact", { loop: true, fadeMs: 80 }); // arms flail
      }
      // Leap FORWARD off the edge (−Z is the way it faces), then freefall —
      // stays UPRIGHT with a panicked sway (no tumbling flat / lying down).
      g.position.set(CHAR_X, 0.35 + 3.5 * u - 12 * u * u, CHAR_Z - 7 * u);
      g.rotation.set(0, faceTarget.current, Math.sin(u * 22) * 0.16);
      g.scale.setScalar(Math.max(0, 1 - u * 0.3));
      return;
    }

    // Position + clip come straight from the shared stepped-jump driver, so
    // the hop and the floor are always in lockstep (no slide before/after).
    g.position.set(CHAR_X, charJumpY, CHAR_Z);
    if (charJumping !== clipJumping.current) {
      clipJumping.current = charJumping;
      gooni.current?.setClip(charJumping ? "Jump" : "Idle", {
        loop: !charJumping,
        timeScale: charJumping ? 1.5 : 1,
        fadeMs: charJumping ? 80 : 160,
      });
    }
    // Face the direction of travel: scrolling forward → face down the path
    // (away); scrolling BACK → turn around toward the camera. Holds facing
    // when idle.
    const v = getScroll().velocity;
    if (v > 0.4) faceTarget.current = WALK_FACING;
    else if (v < -0.4) faceTarget.current = 0;
    g.rotation.y += (faceTarget.current - g.rotation.y) * Math.min(1, dt * 6);
  });

  return (
    <group ref={group} position={[CHAR_X, 0.35, CHAR_Z]} rotation={[0, WALK_FACING, 0]}>
      <GLTFGooni ref={gooni} bodyColor={me.bodyColor} accentColor={me.accentColor} />
    </group>
  );
}

// ── biome sky + lights + particles ──────────────────────────────────

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uHorizon;
  uniform vec3 uTop;
  void main() {
    float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 c = mix(uHorizon, uTop, pow(h, 0.75));
    c = pow(c, vec3(0.4545));
    gl_FragColor = vec4(c, 1.0);
  }
`;

function BiomeSky() {
  const uniforms = useMemo(
    () => ({
      uHorizon: { value: new THREE.Color("#ffe2c4") },
      uTop: { value: new THREE.Color("#a7bce0") },
    }),
    [],
  );
  useFrame(() => {
    const b = getBiome();
    uniforms.uHorizon.value.copy(b.skyHorizon);
    uniforms.uTop.value.copy(b.skyTop);
  });
  return (
    <mesh>
      <sphereGeometry args={[300, 32, 16]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={SKY_VERT}
        fragmentShader={SKY_FRAG}
        side={THREE.BackSide}
        depthWrite={false}
        fog={false}
      />
    </mesh>
  );
}

function BiomeLights() {
  const sun = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  useFrame(() => {
    const b = getBiome();
    if (sun.current) {
      sun.current.color.copy(b.sunColor);
      sun.current.intensity = b.sunIntensity;
    }
    if (hemi.current) {
      hemi.current.color.copy(b.hemiSky);
      hemi.current.groundColor.copy(b.hemiGround);
      hemi.current.intensity = b.hemiIntensity;
    }
  });
  return (
    <>
      <hemisphereLight ref={hemi} intensity={0.55} />
      <directionalLight ref={sun} position={[5, 8, 3]} intensity={1.1} />
    </>
  );
}

function BiomeParticles() {
  const N = 260;
  const pts = useRef<THREE.Points>(null);
  const mat = useRef<THREE.PointsMaterial>(null);
  const reduce = useReducedMotion();

  const base = useMemo(() => {
    const a = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      a[i * 3] = (pseudo(i * 1.3) - 0.5) * 40;
      a[i * 3 + 1] = pseudo(i * 2.1) * 20;
      a[i * 3 + 2] = (pseudo(i * 3.7) - 0.5) * 44;
    }
    return a;
  }, []);
  const work = useMemo(() => base.slice(), [base]);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const b = getBiome();
    if (mat.current) {
      mat.current.color.copy(b.particleColor);
      mat.current.opacity = b.particleOpacity;
    }
    const g = pts.current;
    if (!g) return;
    const attr = g.geometry.getAttribute("position") as THREE.BufferAttribute;
    const tnow = state.clock.getElapsedTime();
    for (let i = 0; i < N; i++) {
      let y = work[i * 3 + 1] - (reduce ? 0 : b.particleFall * dt * 3);
      if (y < 0) y += 20;
      work[i * 3 + 1] = y;
      const x = base[i * 3] + (reduce ? 0 : Math.sin(tnow * 0.4 + i) * b.particleDrift);
      attr.setXYZ(i, x, y, base[i * 3 + 2]);
    }
    attr.needsUpdate = true;
  });

  return (
    <points ref={pts}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={N} array={work} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial ref={mat} size={0.16} sizeAttenuation transparent depthWrite={false} opacity={0.3} />
    </points>
  );
}

// ── the morphing diorama ────────────────────────────────────────────
//
// A small FIXED set of prop pedestals beside the path. They never scroll
// past — as the biome changes they cross-fade (old shrinks out, new grows
// in) into the new biome's prop, so the surroundings TRANSFORM in place
// rather than parade by. Everything is lit by the biome lights, so colour
// coordinates for free.

// Pedestals beside the path. The far-right one used to hide BEHIND the floating
// screen ([13,0,-9]); pulled forward to [9.5,0,0.5] so it sits IN FRONT of the
// screen (fine that it clips the screen's bottom corner). Left one at [-4.5,0,3]
// beside the path near the front. They float on low-poly cloud puffs (PropBase).
const DIORAMA_SLOTS: [number, number, number][] = [
  [7, 0, 3],
  [9.5, 0, 0.5],
  [-4.5, 0, 3],
];

function Diorama() {
  return (
    <group>
      {DIORAMA_SLOTS.map(([x, y, z], i) => (
        <group
          key={i}
          position={[x, y, z]}
          rotation={[0, pseudo(i * 13.1) * Math.PI * 2, 0]}
          scale={0.9 + pseudo(i * 7.3) * 0.6}
        >
          <DioramaSlot seed={i} />
        </group>
      ))}
    </group>
  );
}

function DioramaSlot({ seed }: { seed: number }) {
  const [pair, setPair] = useState({ from: 0, to: 0 });
  const tRef = useRef(1);
  const lastIdx = useRef(0);
  const spinRef = useRef<THREE.Group>(null);
  const fromRef = useRef<THREE.Group>(null);
  const toRef = useRef<THREE.Group>(null);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const idx = getBiome().index;
    if (idx !== lastIdx.current) {
      lastIdx.current = idx;
      setPair((p) => ({ from: p.to, to: idx }));
      tRef.current = 0;
    }
    tRef.current = Math.min(1, tRef.current + dt * 2.2);
    const e = tRef.current * tRef.current * (3 - 2 * tRef.current); // smoothstep
    if (fromRef.current) fromRef.current.scale.setScalar(Math.max(0, 1 - e));
    if (toRef.current) toRef.current.scale.setScalar(e);
    // The whole pedestal spins ONE full turn over the morph — same timing, so
    // it lands settled (2π ≡ 0) exactly as the new prop finishes growing in.
    if (spinRef.current) spinRef.current.rotation.y = e * Math.PI * 2;
  });

  return (
    <group ref={spinRef}>
      <PropBase />
      {pair.from !== pair.to && (
        <group ref={fromRef}>
          <PropFor kind={BIOMES[pair.from].prop} seed={seed} />
        </group>
      )}
      <group ref={toRef}>
        <PropFor kind={BIOMES[pair.to].prop} seed={seed} />
      </group>
    </group>
  );
}

function PropBase() {
  return (
    <group position={[0, -0.05, 0]}>
      <mesh position={[0, -0.12, 0]} receiveShadow>
        <cylinderGeometry args={[1.05, 0.82, 0.5, 6]} />
        <meshStandardMaterial color="#b0a488" flatShading roughness={0.96} />
      </mesh>
      <mesh position={[0, -0.78, 0]}>
        <coneGeometry args={[0.78, 1.5, 6]} />
        <meshStandardMaterial color="#8f8264" flatShading roughness={0.96} />
      </mesh>
      <PropCloud />
    </group>
  );
}

// A little low-poly cloud tucked under the pedestal's point — sells the
// floating-island read. Flattened icosahedron puffs, matching the scene's
// faceted look.
function PropCloud() {
  const puffs: [number, number, number, number][] = [
    [0, 0, 0, 1.0],
    [0.75, 0.08, 0.2, 0.68],
    [-0.72, 0.05, -0.15, 0.72],
    [0.25, 0.14, -0.6, 0.6],
    [-0.35, 0.1, 0.55, 0.6],
  ];
  return (
    <group position={[0, -1.85, 0]}>
      {puffs.map(([x, y, z, s], i) => (
        <mesh key={i} position={[x, y, z]} scale={[s, s * 0.62, s]}>
          <icosahedronGeometry args={[0.72, 0]} />
          {/* Emissive lift so it reads WHITE, not the gray the biome light left it. */}
          <meshStandardMaterial
            color="#ffffff"
            flatShading
            roughness={1}
            emissive="#ffffff"
            emissiveIntensity={0.55}
            transparent
            opacity={0.95}
          />
        </mesh>
      ))}
    </group>
  );
}

function PropFor({ kind, seed }: { kind: PropKind; seed: number }) {
  switch (kind) {
    case "plains":
      return <Boulder />;
    case "coast":
      return <Reeds />;
    case "desert":
      return <Cactus />;
    case "grassland":
      return <Shrub />;
    case "snow":
      return pseudo(seed * 3.3) > 0.5 ? <IceShard /> : <SnowPine />;
  }
}

function Boulder() {
  return (
    <group>
      <mesh position={[0, 0.5, 0]}>
        <dodecahedronGeometry args={[0.7, 0]} />
        <meshStandardMaterial color="#b6a988" flatShading roughness={0.95} />
      </mesh>
      <mesh position={[0.6, 0.24, 0.3]}>
        <dodecahedronGeometry args={[0.32, 0]} />
        <meshStandardMaterial color="#a99c7c" flatShading roughness={0.95} />
      </mesh>
    </group>
  );
}

function Reeds() {
  return (
    <group>
      {[0, 1, 2, 3, 4].map((b) => (
        <mesh
          key={b}
          position={[(pseudo(b * 9.1) - 0.5) * 0.7, 0.9, (pseudo(b * 4.3) - 0.5) * 0.7]}
          rotation={[0, 0, (pseudo(b * 2.7) - 0.5) * 0.3]}
        >
          <coneGeometry args={[0.09, 1.8, 5]} />
          <meshStandardMaterial color="#8fa96e" flatShading roughness={0.8} />
        </mesh>
      ))}
    </group>
  );
}

function Cactus() {
  return (
    <group>
      <mesh position={[0, 1.0, 0]}>
        <cylinderGeometry args={[0.28, 0.32, 2.0, 6]} />
        <meshStandardMaterial color="#4f9e63" flatShading roughness={0.7} />
      </mesh>
      <mesh position={[0.42, 1.15, 0]} rotation={[0, 0, -0.5]}>
        <cylinderGeometry args={[0.14, 0.16, 0.9, 6]} />
        <meshStandardMaterial color="#57a86b" flatShading roughness={0.7} />
      </mesh>
      <mesh position={[-0.4, 0.85, 0]} rotation={[0, 0, 0.55]}>
        <cylinderGeometry args={[0.13, 0.15, 0.8, 6]} />
        <meshStandardMaterial color="#57a86b" flatShading roughness={0.7} />
      </mesh>
    </group>
  );
}

function Shrub() {
  const lobes = [
    [0, 0.42, 0, 0.5],
    [0.34, 0.6, 0.1, 0.4],
    [-0.28, 0.56, -0.14, 0.36],
  ] as const;
  return (
    <group>
      {lobes.map(([x, y, z, r], i) => (
        <mesh key={i} position={[x, y, z]}>
          <icosahedronGeometry args={[r, 0]} />
          <meshStandardMaterial color="#6bb872" flatShading roughness={0.75} />
        </mesh>
      ))}
    </group>
  );
}

function IceShard() {
  return (
    <group>
      <mesh position={[0, 0.9, 0]} scale={[0.5, 1.5, 0.5]}>
        <octahedronGeometry args={[0.7, 0]} />
        <meshStandardMaterial color="#c3e2f2" flatShading roughness={0.15} metalness={0.1} emissive="#4f8fc4" emissiveIntensity={0.12} />
      </mesh>
      <mesh position={[0.32, 0.5, 0.16]} scale={[0.4, 1.0, 0.4]} rotation={[0, 0, 0.3]}>
        <octahedronGeometry args={[0.5, 0]} />
        <meshStandardMaterial color="#cfe8f5" flatShading roughness={0.15} metalness={0.1} emissive="#4f8fc4" emissiveIntensity={0.1} />
      </mesh>
    </group>
  );
}

function SnowPine() {
  const tiers: [number, number, number][] = [
    [0.95, 0.9, 0.62],
    [1.5, 0.72, 0.5],
    [2.0, 0.52, 0.4],
  ];
  return (
    <group>
      <mesh position={[0, 0.4, 0]}>
        <cylinderGeometry args={[0.09, 0.11, 0.8, 5]} />
        <meshStandardMaterial color="#7a5b40" flatShading roughness={0.9} />
      </mesh>
      {tiers.map(([y, r, h], i) => (
        <mesh key={i} position={[0, y, 0]}>
          <coneGeometry args={[r, h, 6]} />
          <meshStandardMaterial color={i === 2 ? "#eef4f8" : "#5f7d68"} flatShading roughness={0.8} />
        </mesh>
      ))}
    </group>
  );
}

// ── the poster: one big screen, channel-swaps per station ───────────
//
// A single large framed screen off the right of the path. Its content is
// the current station's title-card, swapped INSTANTLY per station (no
// static — the old TV-static shader is gone). Sized for video (the plan is
// each becomes a clip). Content lives on a plain unlit plane held clear of
// the bezel's depth so the two never z-fight.

function PosterFixture() {
  const textures = useStationTextures();
  const contentMat = useRef<THREE.MeshBasicMaterial>(null);
  const shownIdx = useRef(-1); // −1 → (re)paints the channel on the next frame

  // Repaint when the textures change (e.g. the pixel font finishes loading).
  useEffect(() => {
    shownIdx.current = -1;
  }, [textures]);

  useFrame(() => {
    // Instant channel swap per station (no static). Texture 0 = home, 1..5 = stations.
    const idx = Math.max(0, Math.min(STATIONS.length, getBiome().index));
    if (idx !== shownIdx.current) {
      shownIdx.current = idx;
      const tex = textures[idx];
      if (contentMat.current && tex) {
        contentMat.current.map = tex;
        contentMat.current.needsUpdate = true;
      }
    }
  });

  const w = POSTER_H * 1.6;
  const h = POSTER_H;
  const cy = 2.9; // screen-centre height above ground

  return (
    <group position={[5.6, cy, -4]} rotation={[0, -0.62, 0]}>
      {/* Bezel — thinner rim, slightly rounded corners, a touch translucent.
          Front face pushed BEHIND the content plane so the two never share a
          depth (the coincident z was the "black squares" — a z-fight between
          this dark bezel and the cream screen). */}
      <RoundedBox args={[w + 0.14, h + 0.14, 0.1]} radius={0.06} smoothness={3} position={[0, 0, -0.06]}>
        <meshStandardMaterial color="#20242a" roughness={0.7} transparent opacity={0.9} />
      </RoundedBox>
      {/* Content plane WELL in front of the bezel front face (z 0.09 ≫ -0.01)
          so there is no shared-depth flicker. color WHITE — the material colour
          MULTIPLIES the map, so a dark colour would darken the card. */}
      <mesh position={[0, 0, 0.09]}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial ref={contentMat} color="#ffffff" toneMapped={false} />
      </mesh>
      {/* Sits ON a cloud (tucked under the bottom edge), like the pedestals. */}
      <group position={[0, -h / 2 - 0.05, 0]} scale={2.4}>
        <PropCloud />
      </group>
    </group>
  );
}

// The home screen gets its OWN card (not station 0's title) — a greeting.
function makeHomeTexture(): THREE.CanvasTexture | null {
  const W = 640;
  const H = 400;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  if (!g) return null;
  g.fillStyle = "#ECE7DB";
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#2E7D57";
  g.fillRect(0, 0, W, 8);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#2E7D57";
  g.font = "18px 'Press Start 2P', monospace";
  g.fillText("WELCOME", W / 2, 72);
  // Phosphor green (not near-black): the high-contrast dark pixel font at 34px
  // dithered into black-block "static" when the angled plane minified it. Same
  // green as WELCOME (which always read clean) + a CRT look.
  g.fillStyle = "#2E7D57";
  g.font = "34px 'Press Start 2P', monospace";
  g.fillText("hi, i'm", W / 2, 186);
  g.fillText("daniel", W / 2, 250);
  return finishScreenTex(c);
}

// Shared finisher for the canvas textures on the poster + floor tiles. High
// anisotropy keeps them crisp at the grazing angles; mipmaps stay ON (the
// "black squares" were a bezel z-fight, not a filtering artifact).
function finishScreenTex(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// The screens: index 0 = home greeting, 1..5 = station title cards. Text is
// the plaza's pixel font (Press Start 2P) for consistency — re-draw once the
// web font resolves so it isn't a mono fallback.
function useStationTextures(): (THREE.Texture | null)[] {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    document.fonts
      ?.load("24px 'Press Start 2P'")
      .then(() => setReady(true))
      .catch(() => {});
  }, []);
  return useMemo(
    () => [makeHomeTexture(), ...STATIONS.map((s) => makeCardTexture(s))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready],
  );
}

// Title-card for a station with no screenshot: eyebrow + wrapped title +
// headline stat, in the page's own type, on a dark panel with the accent.
function makeCardTexture(s: Station): THREE.CanvasTexture | null {
  const W = 640;
  const H = 400;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  if (!g) return null;

  // LIGHT card (was near-black + unreadable) — dark text on paper.
  g.fillStyle = "#ECE7DB";
  g.fillRect(0, 0, W, H);
  g.fillStyle = s.color;
  g.fillRect(0, 0, W, 8);

  // Just the title (a placeholder until videos go in) — eyebrow small on top,
  // title big + centred, wrapped so long ones stay legible.
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = s.color;
  g.font = "15px 'Press Start 2P', monospace";
  g.fillText(s.eyebrow.toUpperCase(), W / 2, 60);

  g.fillStyle = "#26221a";
  g.font = "27px 'Press Start 2P', monospace";
  const lines = wrapText(g, s.title, W - 70);
  const lh = 42;
  let y = H / 2 + 20 - ((lines.length - 1) * lh) / 2;
  for (const line of lines) {
    g.fillText(line, W / 2, y);
    y += lh;
  }

  return finishScreenTex(c);
}

/** Greedy word-wrap against a canvas context's measured width. */
function wrapText(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (g.measureText(test).width > maxW && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Deterministic 0–1 from a number. Stable scatter across reloads. */
function pseudo(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}
