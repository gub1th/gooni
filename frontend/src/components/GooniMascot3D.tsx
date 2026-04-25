import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useGooniFaceStore, type GooniFace } from "../stores/useGooniFaceStore";

// ──────────────────────────────────────────────────────────────────────────────
// Face variants — shape of eyes + curve of mouth per stored face type. Updating
// these live on the mounted character is just geometry swaps + scale tweaks,
// no mesh recreation.
// ──────────────────────────────────────────────────────────────────────────────
interface FaceConfig {
  eyeScaleX: number;
  eyeScaleY: number;
  eyeOffsetX: number; // inward shift (positive = eyes move toward each other)
  eyeOffsetY: number; // vertical nudge on the face
  mouthCurveY: number; // positive = smile, negative = frown, 0 = flat
  mouthWidth: number;  // half-width of the mouth bezier
}

const FACES: Record<GooniFace, FaceConfig> = {
  "smirk":           { eyeScaleX: 1.0, eyeScaleY: 1.0, eyeOffsetX: 0.00, eyeOffsetY: 0.00, mouthCurveY: 0.03, mouthWidth: 0.12 },
  "side-eye":        { eyeScaleX: 1.0, eyeScaleY: 1.0, eyeOffsetX: 0.04, eyeOffsetY: 0.00, mouthCurveY: 0.00, mouthWidth: 0.11 },
  "hyped":           { eyeScaleX: 1.2, eyeScaleY: 1.2, eyeOffsetX: 0.00, eyeOffsetY: 0.02, mouthCurveY: 0.08, mouthWidth: 0.18 },
  "dead-inside":     { eyeScaleX: 1.0, eyeScaleY: 0.12, eyeOffsetX: 0.00, eyeOffsetY: 0.00, mouthCurveY: 0.00, mouthWidth: 0.10 },
  "sus":             { eyeScaleX: 0.9, eyeScaleY: 0.45, eyeOffsetX: 0.00, eyeOffsetY: 0.01, mouthCurveY: -0.02, mouthWidth: 0.10 },
  "crying-laughing": { eyeScaleX: 1.0, eyeScaleY: 0.12, eyeOffsetX: 0.00, eyeOffsetY: 0.00, mouthCurveY: 0.10, mouthWidth: 0.20 },
};

// ──────────────────────────────────────────────────────────────────────────────
// GooniFacePreview — 2D canvas thumbnail for SettingsModal. Not Three.js
// because spinning up a WebGL context per 36px preview is absurd. Pure 2D
// canvas drawing — no SVG, no sprite sheet.
// ──────────────────────────────────────────────────────────────────────────────
export function GooniFacePreviewCanvas({ face, size = 36 }: { face: GooniFace; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    // head circle
    ctx.fillStyle = "#F2F2F2";
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.lineWidth = 0.5;
    ctx.stroke();

    const cfg = FACES[face];
    const cx = size / 2;
    const cy = size / 2;

    // eyes — two filled arcs, scaled per variant
    ctx.fillStyle = "#1a1a1a";
    const eyeR = size * 0.08;
    const eyeSpacing = size * 0.13;
    const eyeY = cy - size * 0.03 - cfg.eyeOffsetY * size;
    for (const side of [-1, 1] as const) {
      const eyeX = cx + side * (eyeSpacing - cfg.eyeOffsetX * size);
      ctx.save();
      ctx.translate(eyeX, eyeY);
      ctx.scale(cfg.eyeScaleX, Math.max(0.12, cfg.eyeScaleY));
      ctx.beginPath();
      ctx.arc(0, 0, eyeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // mouth — quadratic curve
    const mouthW = size * cfg.mouthWidth * 2;
    const mouthY = cy + size * 0.15;
    const curveY = mouthY - cfg.mouthCurveY * size * 2;
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = Math.max(1, size * 0.04);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx - mouthW / 2, mouthY);
    ctx.quadraticCurveTo(cx, curveY, cx + mouthW / 2, mouthY);
    ctx.stroke();
  }, [face, size]);

  return <canvas ref={ref} style={{ width: size, height: size, display: "block" }} aria-hidden="true" />;
}

// ──────────────────────────────────────────────────────────────────────────────
// Character construction. Every limb is a pivot Group; the mesh inside is
// offset so rotation happens at the joint (shoulder/hip), not mid-limb.
// Returned refs let the RAF loop mutate specific parts without traversing.
// ──────────────────────────────────────────────────────────────────────────────
interface CharacterRefs {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  leftEye: THREE.Mesh;
  rightEye: THREE.Mesh;
  mouth: THREE.Mesh;
  mouthMaterial: THREE.Material;
  dispose: () => void;
}

const DARK = 0x1a1a1a;
const GREEN = 0x4ade80;
const HEAD_COLOR = 0xf2f2f2;

function buildCharacter(initialFace: FaceConfig): CharacterRefs {
  // Tracked for cleanup
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  const mat = <M extends THREE.Material>(m: M): M => { disposables.push(m); return m; };
  const geom = <G extends THREE.BufferGeometry>(g: G): G => { disposables.push(g); return g; };

  const bodyMat = mat(new THREE.MeshToonMaterial({ color: GREEN }));
  const darkMat = mat(new THREE.MeshToonMaterial({ color: DARK }));
  // Head intentionally unlit — MeshToonMaterial under ambient+directional
  // reads as gray. MeshBasicMaterial ignores lights so the face stays
  // cleanly white from every angle, which is the Mii look we want.
  const headMat = mat(new THREE.MeshBasicMaterial({ color: HEAD_COLOR }));
  const eyeMat = mat(new THREE.MeshBasicMaterial({ color: DARK }));
  const mouthMat = mat(new THREE.MeshBasicMaterial({ color: DARK }));

  const root = new THREE.Group();
  root.name = "gooni";

  // ── Body (torso) — tapered cylinder, slight top-narrow Mii look ─────────
  const body = new THREE.Group();
  body.name = "body";
  const torsoMesh = new THREE.Mesh(geom(new THREE.CylinderGeometry(0.35, 0.4, 0.8, 24)), bodyMat);
  torsoMesh.position.y = 1.1; // lift so feet sit near y=0
  body.add(torsoMesh);

  // ── Arms ─────────────────────────────────────────────────────────────────
  const leftArm = new THREE.Group();
  leftArm.name = "leftArm";
  leftArm.position.set(-0.42, 1.4, 0); // shoulder pivot
  const leftArmMesh = new THREE.Mesh(geom(new THREE.CylinderGeometry(0.08, 0.08, 0.6, 16)), darkMat);
  leftArmMesh.position.y = -0.3; // hangs below shoulder
  leftArm.add(leftArmMesh);

  const rightArm = new THREE.Group();
  rightArm.name = "rightArm";
  rightArm.position.set(0.42, 1.4, 0);
  const rightArmMesh = new THREE.Mesh(geom(new THREE.CylinderGeometry(0.08, 0.08, 0.6, 16)), darkMat);
  rightArmMesh.position.y = -0.3;
  rightArm.add(rightArmMesh);

  // ── Legs ─────────────────────────────────────────────────────────────────
  const leftLeg = new THREE.Group();
  leftLeg.name = "leftLeg";
  leftLeg.position.set(-0.2, 0.7, 0); // hip pivot
  const leftLegMesh = new THREE.Mesh(geom(new THREE.CylinderGeometry(0.1, 0.09, 0.7, 16)), darkMat);
  leftLegMesh.position.y = -0.35;
  leftLeg.add(leftLegMesh);

  const rightLeg = new THREE.Group();
  rightLeg.name = "rightLeg";
  rightLeg.position.set(0.2, 0.7, 0);
  const rightLegMesh = new THREE.Mesh(geom(new THREE.CylinderGeometry(0.1, 0.09, 0.7, 16)), darkMat);
  rightLegMesh.position.y = -0.35;
  rightLeg.add(rightLegMesh);

  body.add(leftArm, rightArm, leftLeg, rightLeg);

  // ── Head ─────────────────────────────────────────────────────────────────
  const head = new THREE.Group();
  head.name = "head";
  head.position.y = 1.95;
  const headMesh = new THREE.Mesh(geom(new THREE.SphereGeometry(0.45, 32, 32)), headMat);
  head.add(headMesh);

  // Eyes — placed on the "front" of the face (+Z direction). Will rotate with the head.
  const eyeGeom = geom(new THREE.SphereGeometry(0.07, 12, 12));
  const leftEye = new THREE.Mesh(eyeGeom, eyeMat);
  leftEye.position.set(-0.15, 0.06, 0.40);
  head.add(leftEye);

  const rightEye = new THREE.Mesh(eyeGeom, eyeMat);
  rightEye.position.set(0.15, 0.06, 0.40);
  head.add(rightEye);

  // Mouth — Tube along a quadratic bezier. Rebuilt when face changes.
  const mouthGeom = geom(buildMouthGeometry(initialFace));
  const mouth = new THREE.Mesh(mouthGeom, mouthMat);
  mouth.position.set(0, -0.15, 0.42);
  head.add(mouth);

  // Apply initial face config (eye scale + mouth curve)
  applyFaceConfig({ leftEye, rightEye, mouth }, initialFace);

  body.add(head);
  root.add(body);

  const dispose = () => {
    for (const d of disposables) d.dispose();
  };

  return {
    root,
    body,
    head,
    leftArm,
    rightArm,
    leftLeg,
    rightLeg,
    leftEye,
    rightEye,
    mouth,
    mouthMaterial: mouthMat,
    dispose,
  };
}

function buildMouthGeometry(cfg: FaceConfig): THREE.TubeGeometry {
  const w = cfg.mouthWidth;
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-w, 0, 0),
    new THREE.Vector3(0, cfg.mouthCurveY * 2, 0),
    new THREE.Vector3(w, 0, 0),
  );
  return new THREE.TubeGeometry(curve, 20, 0.014, 6, false);
}

function applyFaceConfig(refs: Pick<CharacterRefs, "leftEye" | "rightEye" | "mouth">, cfg: FaceConfig) {
  // Eye scale + position — scale.y < 0.2 reads as a closed-eye horizontal line.
  refs.leftEye.scale.set(cfg.eyeScaleX, cfg.eyeScaleY, 1);
  refs.rightEye.scale.set(cfg.eyeScaleX, cfg.eyeScaleY, 1);
  refs.leftEye.position.x = -0.15 + cfg.eyeOffsetX;
  refs.rightEye.position.x = 0.15 + cfg.eyeOffsetX;
  refs.leftEye.position.y = 0.06 + cfg.eyeOffsetY;
  refs.rightEye.position.y = 0.06 + cfg.eyeOffsetY;

  // Mouth — rebuild the Tube geometry. Old geom is disposed on character unmount.
  const oldGeom = refs.mouth.geometry;
  refs.mouth.geometry = buildMouthGeometry(cfg);
  oldGeom.dispose();
}

// ──────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ──────────────────────────────────────────────────────────────────────────────
function lerpAngle(current: number, target: number, alpha: number): number {
  // Shortest-path angle lerp that handles wraparound at ±π.
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * alpha;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ──────────────────────────────────────────────────────────────────────────────
// World constants. World bounds are derived per frame from the dashboard size
// so waypoints stay inside the visible area. Character base feet at world y=0.
// ──────────────────────────────────────────────────────────────────────────────
const WORLD_MARGIN = 1.0;           // inset from dashboard edges
const WALK_SPEED = 2.2;             // world units/sec
const FLEE_SPEED_BOOST = 1.35;
// Wider radius than before so the flee is noticeable — character now spooks
// when the cursor enters ~18% of viewport width, matching 2D mascot's feel.
const FLEE_RADIUS = 4.0;
const FLEE_DISTANCE = 3.5;
const IDLE_PAUSE_MIN_MS = 500;
const IDLE_PAUSE_MAX_MS = 2000;

type MascotPhase = "peek" | "walk" | "idle" | "drag" | "landing";

interface MascotState {
  phase: MascotPhase;
  pos: THREE.Vector3;
  target: THREE.Vector3;
  pauseUntil: number;
  walkPhase: number;
  landingTimer: number;
  landingDuration: number; // remembered so the squash curve normalizes cleanly
  grabOffset: THREE.Vector3; // offset from cursor at pointerdown
}

// ──────────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────────
interface GooniMascotProps {
  dashboardRef: React.RefObject<HTMLDivElement | null>;
}

export function GooniMascot3D({ dashboardRef }: GooniMascotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectedFace = useGooniFaceStore((s) => s.face);
  const selectedFaceRef = useRef<GooniFace>(selectedFace);

  // Keep the ref current so the RAF loop / face-update effect can see the latest pick.
  useEffect(() => { selectedFaceRef.current = selectedFace; }, [selectedFace]);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    // dashboardRef is kept in the props contract as a signal that the mascot
    // belongs to the dashboard view — if it's unmounted, the mascot unmounts
    // with it. We no longer size the canvas to its rect (canvas is full
    // viewport now) but still require it as a readiness gate.
    if (!canvasEl || !dashboardRef.current) return;
    const canvas: HTMLCanvasElement = canvasEl;

    // ── Scene ─────────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Shadows off: no shadow-map render pass, no shadow-sampling fragment
    // work. Scene has one character, one directional light, and a flat
    // ground — the shadow was barely visible anyway.

    const scene = new THREE.Scene();

    // Perspective camera looking down onto the "floor" the character walks on.
    // Wider FOV + further back = character reads as a small figure in the
    // dashboard, not a main character that hides the content.
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
    camera.position.set(0, 3.8, 14);
    camera.lookAt(0, 0.8, 0);

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);

    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(3, 6, 4);
    scene.add(key);

    // ── Drop zone (3D) — flat ring on the ground at the peek anchor, fades
    //    in during drag. Outer radius 1.0 matches the 1.5 snap distance.
    const dropZoneGroup = new THREE.Group();
    const dropFillGeom = new THREE.CircleGeometry(0.95, 48);
    const dropFillMat = new THREE.MeshBasicMaterial({
      color: GREEN, transparent: true, opacity: 0, side: THREE.DoubleSide,
    });
    const dropFill = new THREE.Mesh(dropFillGeom, dropFillMat);
    dropFill.rotation.x = -Math.PI / 2;

    const dropRingGeom = new THREE.RingGeometry(0.95, 1.05, 48);
    const dropRingMat = new THREE.MeshBasicMaterial({
      color: 0x1a1a1a, transparent: true, opacity: 0, side: THREE.DoubleSide,
    });
    const dropRing = new THREE.Mesh(dropRingGeom, dropRingMat);
    dropRing.rotation.x = -Math.PI / 2;

    dropZoneGroup.add(dropFill, dropRing);
    scene.add(dropZoneGroup);

    // ── Character ─────────────────────────────────────────────────────────
    const character = buildCharacter(FACES[selectedFaceRef.current]);
    scene.add(character.root);

    // ── Sizing: canvas covers the full viewport, not just the dashboard,
    //    so the character can be dragged anywhere on screen. Canvas stays
    //    pointer-events:none so the underlying UI remains clickable.
    function sizeToViewport() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      canvas.style.left = "0px";
      canvas.style.top = "0px";
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      // Re-project the sidebar edge / world corners after every viewport change.
      // Guarded with a `if (canvas)` since first call happens before state is
      // set up, in which case recomputeBounds isn't defined yet.
      try { recomputeBounds(); } catch { /* first call */ }
    }

    // Initial size pass (recomputeBounds will no-op via try/catch since
    // worldMin/peekWorldPos are declared below).
    sizeToViewport();
    window.addEventListener("resize", sizeToViewport);

    // ── World-coord helpers ──────────────────────────────────────────────
    // Project from screen pixel coords (within the canvas) to a point on the
    // ground plane (y = 0). Ray-plane intersection.
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    function screenToWorld(clientX: number, clientY: number, out: THREE.Vector3): boolean {
      // Canvas is position:fixed at (0,0) covering the viewport, so client
      // coords equal canvas-local coords. Reading from window is more
      // reliable than canvas.getBoundingClientRect() immediately after
      // style mutations, before the browser has laid out.
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (w === 0 || h === 0) return false;
      ndc.x = (clientX / w) * 2 - 1;
      ndc.y = -(clientY / h) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      return raycaster.ray.intersectPlane(groundPlane, out) !== null;
    }

    // Bounds of the walkable floor — derived from the camera frustum at y=0,
    // minus a margin. Computed via two diagonal projections.
    const worldMin = new THREE.Vector3();
    const worldMax = new THREE.Vector3();
    // Peek position — world coord at the sidebar's right edge, mid-height.
    // Sidebar width is known (Sidebar.tsx: 200px). Recomputed on resize.
    const SIDEBAR_WIDTH_PX = 200;
    const peekWorldPos = new THREE.Vector3();
    function recomputeBounds() {
      const tl = new THREE.Vector3();
      const br = new THREE.Vector3();
      const rect = canvas.getBoundingClientRect();
      screenToWorld(rect.left, rect.top, tl);
      screenToWorld(rect.left + rect.width, rect.top + rect.height, br);
      worldMin.set(
        Math.min(tl.x, br.x) + WORLD_MARGIN,
        0,
        Math.min(tl.z, br.z) + WORLD_MARGIN * 0.4,
      );
      worldMax.set(
        Math.max(tl.x, br.x) - WORLD_MARGIN,
        0,
        Math.max(tl.z, br.z) - WORLD_MARGIN * 0.4,
      );
      // Peek anchor: at the sidebar's right edge, vertically centered.
      const ok = screenToWorld(SIDEBAR_WIDTH_PX, window.innerHeight / 2, peekWorldPos);
      // If the projection silently failed (canvas not laid out yet) or
      // came back at the world origin, fall back to a hand-picked world
      // coord that reliably lands in the left 15% of a desktop viewport.
      if (!ok || peekWorldPos.lengthSq() < 0.1) {
        peekWorldPos.set(-7, 0, -2);
      }
      // 3D drop zone follows the peek anchor (via external closure).
      if (typeof dropZoneGroup !== "undefined") {
        dropZoneGroup.position.copy(peekWorldPos);
        dropZoneGroup.position.y = 0.01;
      }
    }
    recomputeBounds();
    // Re-run after the browser has had a chance to lay out — the initial
    // call can hit stale rect dims, giving (0,0,0) that looks like "middle
    // of screen". A deferred tick + next-RAF catches both cases.
    setTimeout(() => recomputeBounds(), 0);
    requestAnimationFrame(() => recomputeBounds());

    // ── State ────────────────────────────────────────────────────────────
    // Spawn in landing squash at world origin (visually: center of screen).
    // Activate-Gooni drops him into the middle; the landing animation plays
    // once, then he transitions to walk + starts wandering. Drag him into
    // the drop-zone ring (left edge) to park him in peek.
    const state: MascotState = {
      phase: "landing",
      pos: new THREE.Vector3(0, 0, 0),
      target: new THREE.Vector3(),
      pauseUntil: 0,
      walkPhase: 0,
      landingTimer: 0.32, // longer on spawn for a satisfying drop
      landingDuration: 0.32,
      grabOffset: new THREE.Vector3(),
    };
    character.root.position.copy(state.pos);
    // Drop zone is positioned at the peek anchor and only shown during drag.
    dropZoneGroup.position.copy(peekWorldPos);
    dropZoneGroup.position.y = 0.01; // slightly above ground to avoid z-fighting

    function pickWaypoint(out: THREE.Vector3) {
      out.set(
        worldMin.x + Math.random() * (worldMax.x - worldMin.x),
        0,
        worldMin.z + Math.random() * (worldMax.z - worldMin.z),
      );
    }

    function setPhase(p: MascotPhase) {
      state.phase = p;
    }

    // ── Pointer input ────────────────────────────────────────────────────
    // Canvas is pointer-events: none — events hit notes/buttons underneath
    // as intended. We track pointer position at window level and re-project
    // to world coords EVERY FRAME in the RAF loop, so drag follows the
    // cursor reliably even when events are throttled or move over scroll
    // areas that consume pointermove.
    const mouseWorld = new THREE.Vector3();
    let mouseInScene = false;
    let lastClientX = -1;
    let lastClientY = -1;

    function onPointerMove(e: PointerEvent) {
      lastClientX = e.clientX;
      lastClientY = e.clientY;
    }

    function onPointerDown(e: PointerEvent) {
      if (state.phase === "drag" || state.phase === "landing") return;
      lastClientX = e.clientX;
      lastClientY = e.clientY;
      if (!screenToWorld(e.clientX, e.clientY, mouseWorld)) return;
      // Raycast against character meshes to see if the pointer actually hit him.
      const rect = canvas.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObject(character.root, true);
      if (hits.length === 0) return;
      e.preventDefault();
      // Grab offset intentionally zero — character's center snaps to the
      // cursor, matching Mii Plaza pick-up behavior.
      state.grabOffset.set(0, 0, 0);
      setPhase("drag");
    }

    function onPointerUp() {
      if (state.phase !== "drag") return;
      // Drop within the 3D ring (outer radius 1.05 world units) snaps to
      // peek. 1.6 gives some slack for fast releases that overshoot slightly.
      const distToPeek = state.pos.distanceTo(peekWorldPos);
      if (distToPeek < 1.6) {
        setPhase("peek");
      } else {
        setPhase("landing");
        state.landingTimer = 0.22;
        state.landingDuration = 0.22;
      }
    }

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);

    // ── Face updates via ref (so useEffect doesn't rebuild the whole scene) ──
    let lastAppliedFace: GooniFace = selectedFaceRef.current;

    // ── RAF loop — delta-driven ──────────────────────────────────────────
    const clock = new THREE.Clock();
    function animate() {
      const delta = Math.min(clock.getDelta(), 0.066); // cap big frame gaps
      const now = performance.now();

      // Face swap without recreating the character
      if (selectedFaceRef.current !== lastAppliedFace) {
        applyFaceConfig(character, FACES[selectedFaceRef.current]);
        lastAppliedFace = selectedFaceRef.current;
      }

      // ── 3D drop zone — fade in/out + pulse during drag ─────────────
      {
        const targetOpacity = state.phase === "drag" ? 1 : 0;
        // Exponential approach, time-constant ≈ 0.18s
        const k = 1 - Math.exp(-delta / 0.18);
        dropFillMat.opacity += (targetOpacity * 0.35 - dropFillMat.opacity) * k;
        dropRingMat.opacity += (targetOpacity * 0.8 - dropRingMat.opacity) * k;
        // Pulse scale while visible
        if (state.phase === "drag") {
          const pulse = 1 + 0.06 * Math.sin(now / 300);
          dropZoneGroup.scale.set(pulse, 1, pulse);
        }
      }

      // Re-project cursor to world coords every frame. Cheap (one ray-plane
      // test) and makes drag position resilient to event-loop hiccups.
      if (lastClientX >= 0 && lastClientY >= 0) {
        mouseInScene = screenToWorld(lastClientX, lastClientY, mouseWorld);
      }

      // Drag: character center tracks the cursor exactly. Unclamped — he
      // can be dragged anywhere the cursor goes, including over the sidebar
      // or off the dashboard area entirely.
      if (state.phase === "drag" && mouseInScene) {
        state.pos.x = mouseWorld.x;
        state.pos.z = mouseWorld.z;
      }

      // ── Phase logic ─────────────────────────────────────────────────
      switch (state.phase) {
        case "peek": {
          // Anchor to the sidebar's right edge in screen space, so he appears
          // to peek out from behind the sidebar into the dashboard. The canvas
          // is z-index 50 so he renders on top of the sidebar visually.
          state.pos.x = peekWorldPos.x;
          state.pos.z = peekWorldPos.z;
          state.walkPhase = 0;
          break;
        }

        case "walk": {
          // Flee: if mouse is within FLEE_RADIUS while walking/idling, retarget away.
          if (mouseInScene) {
            const d = state.pos.distanceTo(mouseWorld);
            if (d < FLEE_RADIUS) {
              const away = state.pos.clone().sub(mouseWorld);
              if (away.lengthSq() < 0.01) away.set(1, 0, 0);
              away.normalize().multiplyScalar(FLEE_DISTANCE);
              state.target.copy(state.pos).add(away);
              state.target.x = clamp(state.target.x, worldMin.x, worldMax.x);
              state.target.z = clamp(state.target.z, worldMin.z, worldMax.z);
            }
          }

          const dir = state.target.clone().sub(state.pos);
          dir.y = 0;
          const dist = dir.length();
          if (dist < 0.08) {
            setPhase("idle");
            state.pauseUntil = now + IDLE_PAUSE_MIN_MS + Math.random() * (IDLE_PAUSE_MAX_MS - IDLE_PAUSE_MIN_MS);
            state.walkPhase = 0;
          } else {
            dir.normalize();
            const speed = WALK_SPEED * (mouseInScene && state.pos.distanceTo(mouseWorld) < FLEE_RADIUS ? FLEE_SPEED_BOOST : 1);
            state.pos.addScaledVector(dir, speed * delta);
            state.walkPhase += delta * 7.5; // visible limb swing rate
            // Face the direction of travel — smooth short-path rotation
            const targetAngle = Math.atan2(dir.x, dir.z);
            character.root.rotation.y = lerpAngle(character.root.rotation.y, targetAngle, 0.18);
          }
          break;
        }

        case "idle": {
          // Flee: if the cursor enters FLEE_RADIUS while idling, cut the
          // pause short, pick an escape target, and transition straight to walk.
          if (mouseInScene && state.pos.distanceTo(mouseWorld) < FLEE_RADIUS) {
            const away = state.pos.clone().sub(mouseWorld);
            if (away.lengthSq() < 0.01) away.set(1, 0, 0);
            away.normalize().multiplyScalar(FLEE_DISTANCE);
            state.target.copy(state.pos).add(away);
            state.target.x = clamp(state.target.x, worldMin.x, worldMax.x);
            state.target.z = clamp(state.target.z, worldMin.z, worldMax.z);
            setPhase("walk");
            state.walkPhase = 0;
            break;
          }
          // Gentle breathe on the head/body, waiting for next waypoint.
          if (now >= state.pauseUntil) {
            pickWaypoint(state.target);
            setPhase("walk");
          }
          break;
        }

        case "drag": {
          // Position is driven by pointermove. Flail limbs wildly.
          const t = now / 1000;
          character.leftArm.rotation.x = Math.sin(t * 15) * 1.2;
          character.rightArm.rotation.x = Math.sin(t * 15 + Math.PI) * 1.2;
          character.leftArm.rotation.z = Math.sin(t * 12 + 1) * 0.6;
          character.rightArm.rotation.z = Math.sin(t * 12 + 2) * -0.6;
          character.leftLeg.rotation.x = Math.sin(t * 13) * 0.7;
          character.rightLeg.rotation.x = Math.sin(t * 13 + Math.PI) * 0.7;
          // Hang slightly — as if picked up by the torso
          character.root.position.y = 0.3 + Math.sin(t * 8) * 0.06;
          break;
        }

        case "landing": {
          state.landingTimer -= delta;
          if (state.landingTimer <= 0) {
            // Reset limbs, pick a waypoint, transition to walk.
            character.leftArm.rotation.set(0, 0, 0);
            character.rightArm.rotation.set(0, 0, 0);
            character.leftLeg.rotation.set(0, 0, 0);
            character.rightLeg.rotation.set(0, 0, 0);
            character.root.scale.set(1, 1, 1);
            pickWaypoint(state.target);
            setPhase("walk");
          } else {
            // Squash: compress Y, stretch X/Z, ease back to 1.
            const t = 1 - state.landingTimer / state.landingDuration; // 0 → 1
            const sy = 0.75 + 0.25 * t;
            const sx = 1.2 - 0.2 * t;
            character.root.scale.set(sx, sy, sx);
          }
          break;
        }
      }

      // ── Animate limbs/body based on phase (post-phase so it's consistent) ──
      if (state.phase === "walk") {
        const swing = Math.sin(state.walkPhase);
        character.leftArm.rotation.x = swing * 0.55;
        character.rightArm.rotation.x = -swing * 0.55;
        character.leftLeg.rotation.x = -swing * 0.5;
        character.rightLeg.rotation.x = swing * 0.5;
        // Body bob (abs so both feet-down moments lift the body, not just one)
        character.root.position.y = Math.abs(Math.sin(state.walkPhase)) * 0.06;
        character.body.rotation.x = 0.05; // slight forward lean
      } else if (state.phase === "idle") {
        // Breathe — gentle scale pulse on the torso only.
        const t = now / 1000;
        const breathe = 1 + Math.sin(t * 2) * 0.02;
        character.body.scale.set(breathe, 1, breathe);
        // Decay limbs back to rest.
        character.leftArm.rotation.x *= 0.85;
        character.rightArm.rotation.x *= 0.85;
        character.leftLeg.rotation.x *= 0.85;
        character.rightLeg.rotation.x *= 0.85;
        character.root.position.y *= 0.9;
      } else if (state.phase === "peek") {
        const t = now / 1000;
        character.root.position.y = Math.sin(t * 1.5) * 0.04;
        character.leftArm.rotation.x *= 0.85;
        character.rightArm.rotation.x *= 0.85;
        character.leftLeg.rotation.x *= 0.85;
        character.rightLeg.rotation.x *= 0.85;
        character.body.scale.set(1, 1, 1);
        // Face right (toward dashboard) during peek so he looks into the content area.
        character.root.rotation.y = lerpAngle(character.root.rotation.y, Math.PI / 2, 0.12);
      }

      character.root.position.x = state.pos.x;
      character.root.position.z = state.pos.z;
      // y is set by phase logic above

      renderer.render(scene, camera);
    }
    renderer.setAnimationLoop(animate);

    // ── Visibility pause ─────────────────────────────────────────────────
    // Stop the RAF loop when the tab is hidden. GPU idle, 0% work until
    // the tab comes back. On resume, restart the clock so delta doesn't
    // explode on the first frame.
    function onVisibilityChange() {
      if (document.hidden) {
        renderer.setAnimationLoop(null);
      } else {
        clock.start();
        renderer.setAnimationLoop(animate);
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Cleanup
    return () => {
      renderer.setAnimationLoop(null);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("resize", sizeToViewport);
      character.dispose();
      dropFillGeom.dispose();
      dropFillMat.dispose();
      dropRingGeom.dispose();
      dropRingMat.dispose();
      renderer.dispose();
    };
    // dashboardRef is a ref object — its .current changes don't re-trigger the effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drop zone is now a 3D mesh in the scene (see buildCharacter-adjacent
  // dropZoneGroup); no DOM overlay needed.
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        pointerEvents: "none",
        zIndex: 50,
        // left/top/width/height are set by sizeToViewport()
      }}
    />
  );
}
