import { useEffect, useRef, useState } from "react";
import { useGooniFaceStore, type GooniFace } from "../stores/useGooniFaceStore";

// Interactive Gooni mascot — single RAF loop owns every phase (peek/drag/walk/idle/
// turning/landing). All per-frame visuals are direct DOM updates via refs; no React
// re-renders per frame, no CSS keyframe animations for the walk cycle.
// Static CSS transitions are used only for facing-change visibility (opacity/scale on
// face/arm/head when the direction enum flips) — these are rare and not per-frame.

type MascotPhase = "peek" | "drag" | "walk" | "idle" | "turning" | "landing";
type FacingDir = "N" | "S" | "E" | "W";
type IdleActionKind = "none" | "lookLR" | "scratch";

interface MascotState {
  phase: MascotPhase;
  x: number; y: number;          // world-space, relative to dashboard top-left
  targetX: number; targetY: number;
  angle: number;                 // radians, direction of travel
  walkFrame: number;             // accumulating float; cycle = Math.sin(walkFrame)
  facingDir: FacingDir;

  // Timers (absolute ms from performance.now)
  pauseUntilMs: number;
  turningUntilMs: number;
  landingUntilMs: number;

  // Idle action
  idleActionKind: IdleActionKind;
  idleActionStartMs: number;
  idleActionDir: 1 | -1;          // sign for look-left vs look-right
  nextIdleActionMs: number;

  // Blink
  blinkStartMs: number;           // 0 when not blinking
  nextBlinkMs: number;

  // Drag
  dragOffsetDx: number;
  dragOffsetDy: number;
}

const WRAPPER_W = 48;
const WRAPPER_H = 68;
const SIDEBAR_SNAP_PX = 40;
const LANDING_MS = 220;
const TURN_MS = 200;

// Arm/leg rest angles (degrees). The v4 SVG has baked-in ±12° on arms; we apply those
// via JS each frame since we're driving all transforms from the RAF loop.
const ARM_REST_L = 12;
const ARM_REST_R = -12;
const LEG_REST = 0;

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function easeInOut(t: number): number { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

function facingFor(dx: number, dy: number): FacingDir {
  // 4 cardinals only — pick the dominant axis. Ties favor horizontal.
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "E" : "W";
  return dy >= 0 ? "S" : "N";
}

// ── Face layer (canonical from v4) ──────────────────────────────────────────

function FaceSmirk() {
  return (
    <g>
      <circle cx="38" cy="32" r="3.5" fill="#1a1a1a" />
      <circle cx="52" cy="32" r="3.5" fill="#1a1a1a" />
      <path d="M38 42 Q45 48 52 43" stroke="#1a1a1a" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </g>
  );
}
function FaceSideEye() {
  return (
    <g>
      <circle cx="38" cy="32" r="3.5" fill="#1a1a1a" />
      <circle cx="40" cy="32" r="1.5" fill="#f2f2f2" />
      <circle cx="52" cy="32" r="3.5" fill="#1a1a1a" />
      <circle cx="54" cy="32" r="1.5" fill="#f2f2f2" />
      <path d="M34 23 Q38 20 43 22" stroke="#1a1a1a" strokeWidth="2.2" fill="none" strokeLinecap="round" />
      <line x1="38" y1="43" x2="52" y2="43" stroke="#1a1a1a" strokeWidth="2.5" strokeLinecap="round" />
    </g>
  );
}
function FaceHyped() {
  return (
    <g>
      <circle cx="38" cy="30" r="3.5" fill="#1a1a1a" />
      <circle cx="52" cy="30" r="3.5" fill="#1a1a1a" />
      <path d="M34 22 Q38 19 42 21" stroke="#1a1a1a" strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M48 21 Q52 18 56 20" stroke="#1a1a1a" strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M34 40 Q45 52 56 40" stroke="#1a1a1a" strokeWidth="2.5" fill="#1a1a1a" strokeLinecap="round" />
    </g>
  );
}
function FaceDeadInside() {
  return (
    <g>
      <circle cx="38" cy="34" r="3" fill="#1a1a1a" />
      <circle cx="52" cy="34" r="3" fill="#1a1a1a" />
      <line x1="38" y1="44" x2="52" y2="44" stroke="#1a1a1a" strokeWidth="2.5" strokeLinecap="round" />
    </g>
  );
}
function FaceSus() {
  return (
    <g>
      <path d="M34 31 Q38 28 42 31" stroke="#1a1a1a" strokeWidth="2" fill="none" strokeLinecap="round" />
      <ellipse cx="38" cy="33" rx="3.5" ry="2" fill="#1a1a1a" />
      <path d="M48 31 Q52 28 56 31" stroke="#1a1a1a" strokeWidth="2" fill="none" strokeLinecap="round" />
      <ellipse cx="52" cy="33" rx="3.5" ry="2" fill="#1a1a1a" />
      <path d="M40 43 Q44 46 48 42" stroke="#1a1a1a" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </g>
  );
}
function FaceCryingLaughing() {
  return (
    <g>
      <path d="M34 30 Q38 26 42 30" stroke="#1a1a1a" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <path d="M48 30 Q52 26 56 30" stroke="#1a1a1a" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <ellipse cx="35" cy="36" rx="2" ry="3" fill="#93C5FD" opacity="0.8" />
      <ellipse cx="55" cy="36" rx="2" ry="3" fill="#93C5FD" opacity="0.8" />
      <path d="M34 40 Q45 54 56 40" stroke="#1a1a1a" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </g>
  );
}

// Internal drag-only face — shocked/yelling. Wide eyes, raised brows, open mouth (red fill).
function FaceShocked() {
  return (
    <g>
      {/* Wide eyes with shine */}
      <circle cx="38" cy="31" r="4.5" fill="#1a1a1a" />
      <circle cx="39.5" cy="29" r="1.3" fill="white" />
      <circle cx="52" cy="31" r="4.5" fill="#1a1a1a" />
      <circle cx="53.5" cy="29" r="1.3" fill="white" />
      {/* Raised brows */}
      <path d="M33 22 Q38 18 43 22" stroke="#1a1a1a" strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M47 22 Q52 18 57 22" stroke="#1a1a1a" strokeWidth="2" fill="none" strokeLinecap="round" />
      {/* Open mouth — oval with red fill, dark stroke */}
      <ellipse cx="45" cy="44" rx="4.5" ry="4" fill="#DC2626" stroke="#1a1a1a" strokeWidth="1.5" />
    </g>
  );
}

// Internal union: selectable face variants plus the drag-only "shocked".
type DisplayFace = GooniFace | "shocked";

export function Face({ face }: { face: DisplayFace }) {
  switch (face) {
    case "smirk": return <FaceSmirk />;
    case "side-eye": return <FaceSideEye />;
    case "hyped": return <FaceHyped />;
    case "dead-inside": return <FaceDeadInside />;
    case "sus": return <FaceSus />;
    case "crying-laughing": return <FaceCryingLaughing />;
    case "shocked": return <FaceShocked />;
  }
}

export function GooniFacePreview({ face, size = 36 }: { face: GooniFace; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="21 10 48 48"
      xmlns="http://www.w3.org/2000/svg"
      aria-label={`Gooni ${face} face`}
    >
      <circle cx="45" cy="34" r="24" fill="#1a1a1a" />
      <circle cx="45" cy="34" r="19" fill="#f2f2f2" />
      <Face face={face} />
    </svg>
  );
}

// ── Mascot ────────────────────────────────────────────────────────────────────

interface GooniMascotProps {
  dashboardRef: React.RefObject<HTMLDivElement | null>;
}

// Avoidance behavior — Gooni flees the mouse when it gets close during walk/idle.
const FLEE_RADIUS = 140;          // px — cursor within this range triggers flee
const FLEE_DISTANCE = 120;        // px — how far to flee per retarget
const FLEE_SPEED_BOOST = 1.25;    // slightly faster than normal walk (still catchable)

export function GooniMascot({ dashboardRef }: GooniMascotProps) {
  const selectedFace = useGooniFaceStore((s) => s.face);

  // React state ONLY for things that determine which face component renders.
  // Peek forces "sus" (sneaky corner look), drag forces "shocked" (wide eyes, open red mouth),
  // everything else uses the user's selected face.
  const [displayFace, setDisplayFace] = useState<DisplayFace>("sus");

  // Drop-zone visibility mirrors the drag phase. React state so we can animate
  // it in/out with CSS transitions cleanly (this is a rare state change, not per-frame).
  const [dropZoneVisible, setDropZoneVisible] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  // Latest mouse position in viewport coords
  const mouseRef = useRef<{ x: number; y: number } | null>(null);

  // Everything else lives in a mutable ref and is written via setAttribute/setProperty
  // directly from the RAF loop. No re-renders per frame.
  const stateRef = useRef<MascotState>({
    phase: "peek",
    x: 0, y: 0,
    targetX: 0, targetY: 0,
    angle: 0,
    walkFrame: 0,
    facingDir: "S",
    pauseUntilMs: 0,
    turningUntilMs: 0,
    landingUntilMs: 0,
    idleActionKind: "none",
    idleActionStartMs: 0,
    idleActionDir: 1,
    nextIdleActionMs: 0,
    blinkStartMs: 0,
    nextBlinkMs: 0,
    dragOffsetDx: 0, dragOffsetDy: 0,
  });

  // DOM refs for direct transform writes
  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const headRef = useRef<SVGGElement>(null);
  const faceGroupRef = useRef<SVGGElement>(null);
  const bodyRef = useRef<SVGGElement>(null);
  const armLRef = useRef<SVGGElement>(null);
  const armRRef = useRef<SVGGElement>(null);
  const legLRef = useRef<SVGGElement>(null);
  const legRRef = useRef<SVGGElement>(null);
  const shadowRef = useRef<SVGEllipseElement>(null);
  const gripRef = useRef<SVGGElement>(null);

  // Last-applied facing so we only update CSS classes when it changes
  const lastFacingRef = useRef<FacingDir>("S");
  const lastPhaseCssRef = useRef<MascotPhase>("peek");
  const rafIdRef = useRef<number>(0);

  // ── Helpers that the RAF loop uses ────────────────────────────────────────

  function setPhase(next: MascotPhase) {
    stateRef.current.phase = next;
    // Face override: peek = sus, drag = shocked, else user's pick.
    const wantFace: DisplayFace =
      next === "peek" ? "sus" :
      next === "drag" ? "shocked" :
      selectedFace;
    setDisplayFace((cur) => (cur === wantFace ? cur : wantFace));
    // Drop-zone only shows while dragging.
    setDropZoneVisible(next === "drag");
  }

  function pickTarget(bounds: DOMRect) {
    const s = stateRef.current;
    const padding = 60;
    const minY = 40;
    const maxY = Math.max(minY + 10, bounds.height - 60);
    const tx = padding + Math.random() * Math.max(1, bounds.width - padding * 2 - WRAPPER_W);
    // Bias toward Y-variance from current position so consecutive waypoints noticeably
    // change depth (avoid two targets both near the current Y, which would look "stuck" at one scale).
    const yRange = maxY - minY;
    let ty: number;
    const attempts = 3;
    let best = minY + Math.random() * yRange;
    let bestDist = -1;
    for (let i = 0; i < attempts; i++) {
      const candidate = minY + Math.random() * yRange;
      const d = Math.abs(candidate - s.y);
      if (d > bestDist) { best = candidate; bestDist = d; }
    }
    ty = best;
    s.targetX = tx;
    s.targetY = ty;
  }

  function scheduleNextIdleAction(now: number) {
    const s = stateRef.current;
    s.idleActionKind = "none";
    s.nextIdleActionMs = now + 800 + Math.random() * 1400;
  }

  function scheduleNextBlink(now: number) {
    stateRef.current.nextBlinkMs = now + 3000 + Math.random() * 2000;
  }

  // ── Global mouse tracking for avoidance ──────────────────────────────────

  useEffect(() => {
    function onMove(e: MouseEvent) {
      mouseRef.current = { x: e.clientX, y: e.clientY };
    }
    function onLeave() {
      mouseRef.current = null;
    }
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  // ── Main RAF loop ─────────────────────────────────────────────────────────

  useEffect(() => {
    // Initial facing/face sync
    setDisplayFace("sus");

    function tick(now: number) {
      const s = stateRef.current;
      const bounds = dashboardRef.current?.getBoundingClientRect();
      const wrapper = wrapperRef.current;
      if (!bounds || !wrapper) {
        rafIdRef.current = requestAnimationFrame(tick);
        return;
      }

      const MIN_Y = 40;
      const MAX_Y = Math.max(MIN_Y + 10, bounds.height - 60);

      // ── Avoidance: if the cursor is close, retarget AWAY from it.
      //    Only kicks in during walk/idle so peek/drag/turning/landing stay deterministic.
      //    Keeps speed close to normal so he's catchable.
      let fleeing = false;
      if (
        mouseRef.current &&
        (s.phase === "walk" || s.phase === "idle")
      ) {
        const mx = mouseRef.current.x - bounds.left;
        const my = mouseRef.current.y - bounds.top;
        // Mascot's on-screen center (approximate, wrapper has scale applied; close enough)
        const cx = s.x + WRAPPER_W / 2;
        const cy = s.y + WRAPPER_H / 2;
        const mdx = cx - mx;
        const mdy = cy - my;
        const mdist = Math.hypot(mdx, mdy);
        if (mdist < FLEE_RADIUS) {
          fleeing = true;
          // Escape vector: away from cursor. Handle degenerate case (cursor on top).
          const ux = mdist > 0.5 ? mdx / mdist : Math.random() - 0.5;
          const uy = mdist > 0.5 ? mdy / mdist : Math.random() - 0.5;
          const rawTx = s.x + ux * FLEE_DISTANCE;
          const rawTy = s.y + uy * FLEE_DISTANCE;
          s.targetX = clamp(rawTx, 40, Math.max(40, bounds.width - WRAPPER_W - 40));
          s.targetY = clamp(rawTy, MIN_Y, MAX_Y);
          s.angle = Math.atan2(s.targetY - s.y, s.targetX - s.x);
          const newDir = facingFor(s.targetX - s.x, s.targetY - s.y);
          if (newDir !== s.facingDir) s.facingDir = newDir;
          if (s.phase === "idle") {
            // Break out of idle immediately — fleeing takes priority over scratching
            s.idleActionKind = "none";
            setPhase("walk");
          }
        }
      }

      // ── Phase logic ───────────────────────────────────────────────────────
      switch (s.phase) {
        case "peek": {
          s.x = -20;
          s.y = bounds.height / 2 - WRAPPER_H / 2;
          break;
        }

        case "drag": {
          // Flail frame increments fast; position driven by pointer handlers.
          s.walkFrame += 0.35;
          break;
        }

        case "walk": {
          const dx = s.targetX - s.x;
          const dy = s.targetY - s.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 4) {
            setPhase("idle");
            s.pauseUntilMs = now + 1500 + Math.random() * 1500;
            s.walkFrame = 0;
            s.nextIdleActionMs = now + 800 + Math.random() * 1200;
            break;
          }
          const depthT = clamp((s.y - MIN_Y) / Math.max(1, MAX_Y - MIN_Y), 0, 1);
          const baseSpeed = 0.8 + depthT * 1.2;
          const walkSpeed = fleeing ? baseSpeed * FLEE_SPEED_BOOST : baseSpeed;
          s.angle = Math.atan2(dy, dx);
          s.x += (dx / dist) * walkSpeed;
          s.y += (dy / dist) * walkSpeed;
          s.walkFrame += 0.08 * walkSpeed;
          break;
        }

        case "turning": {
          if (now >= s.turningUntilMs) {
            setPhase("walk");
          }
          break;
        }

        case "idle": {
          if (now >= s.pauseUntilMs) {
            pickTarget(bounds);
            const dx = s.targetX - s.x;
            const dy = s.targetY - s.y;
            s.angle = Math.atan2(dy, dx);
            const newDir = facingFor(dx, dy);
            if (newDir !== s.facingDir) {
              s.facingDir = newDir;
              s.turningUntilMs = now + TURN_MS;
              s.idleActionKind = "none";
              setPhase("turning");
            } else {
              setPhase("walk");
            }
            break;
          }
          // Idle actions — schedule + run
          if (s.idleActionKind === "none" && now >= s.nextIdleActionMs) {
            const pick = Math.random();
            if (pick < 0.55) {
              s.idleActionKind = "lookLR";
              s.idleActionDir = Math.random() < 0.5 ? -1 : 1;
            } else {
              s.idleActionKind = "scratch";
            }
            s.idleActionStartMs = now;
          }
          // If an action is running, check expiry
          if (s.idleActionKind === "lookLR") {
            // 300ms ramp out, 800ms hold, 300ms ramp back = 1400ms total
            if (now - s.idleActionStartMs > 1400) scheduleNextIdleAction(now);
          } else if (s.idleActionKind === "scratch") {
            // 400 ramp + 400 oscillate + 400 ramp = 1200ms total
            if (now - s.idleActionStartMs > 1200) scheduleNextIdleAction(now);
          }
          break;
        }

        case "landing": {
          if (now >= s.landingUntilMs) {
            pickTarget(bounds);
            const dx = s.targetX - s.x;
            const dy = s.targetY - s.y;
            s.angle = Math.atan2(dy, dx);
            const newDir = facingFor(dx, dy);
            if (newDir !== s.facingDir) {
              s.facingDir = newDir;
              s.turningUntilMs = now + TURN_MS;
              setPhase("turning");
            } else {
              setPhase("walk");
            }
          }
          break;
        }
      }

      // ── Render: wrapper position + scale + flip ──────────────────────────
      const depthT = clamp((s.y - MIN_Y) / Math.max(1, MAX_Y - MIN_Y), 0, 1);
      // Mii-Plaza depth — dramatic scale variance so the character reads as "near/far"
      const scale =
        s.phase === "peek" ? 0.85 :
        s.phase === "drag" ? 1.2 :
        0.5 + depthT * 1.0;  // 0.5 (far/top) → 1.5 (near/bottom) — 3x variance
      const flipX = s.facingDir === "W" ? -1 : 1;

      // Bob the whole character during peek (slow) or walk (sync'd to walkFrame)
      let wrapperBob = 0;
      if (s.phase === "peek") {
        wrapperBob = Math.sin(now / 420) * 2.5;
      } else if (s.phase === "walk") {
        wrapperBob = -Math.abs(Math.sin(s.walkFrame)) * 2.5; // lift at midpoints
      }

      wrapper.style.left = `${bounds.left + s.x}px`;
      wrapper.style.top = `${bounds.top + s.y}px`;
      wrapper.style.transform = `translateY(${wrapperBob}px) scale(${scale * flipX}, ${scale})`;
      wrapper.style.transformOrigin = "50% 100%";

      // Drop zone position — anchored just inside the left edge of the dashboard,
      // vertically centered near the peek Y so dropping there visibly "snaps to base".
      if (dropZoneRef.current) {
        const dzW = 56, dzH = 120;
        dropZoneRef.current.style.left = `${bounds.left + 8}px`;
        dropZoneRef.current.style.top = `${bounds.top + bounds.height / 2 - dzH / 2}px`;
        void dzW;
      }

      // Phase CSS class — swaps visibility of shadow/body/limbs/grip in bulk
      if (lastPhaseCssRef.current !== s.phase) {
        wrapper.className = `gooni-mascot-wrapper gm-${s.phase} gf-${s.facingDir}`;
        lastPhaseCssRef.current = s.phase;
        lastFacingRef.current = s.facingDir;
      } else if (lastFacingRef.current !== s.facingDir) {
        wrapper.className = `gooni-mascot-wrapper gm-${s.phase} gf-${s.facingDir}`;
        lastFacingRef.current = s.facingDir;
      }

      // ── Limb transforms per phase ────────────────────────────────────────
      applyLimbTransforms(s, now);

      rafIdRef.current = requestAnimationFrame(tick);
    }

    function applyLimbTransforms(s: MascotState, now: number) {
      const armL = armLRef.current;
      const armR = armRRef.current;
      const legL = legLRef.current;
      const legR = legRRef.current;
      const body = bodyRef.current;
      const head = headRef.current;
      if (!armL || !armR || !legL || !legR || !body || !head) return;

      if (s.phase === "walk") {
        const cycle = Math.sin(s.walkFrame);            // -1..1 per stride
        const armSwing = cycle * 28;                    // degrees
        const legSwing = cycle * 22;
        // Contralateral: R-arm and L-leg same phase; L-arm and R-leg same phase.
        // Arms rotate OPPOSITE directions so the character doesn't flap.
        armR.setAttribute("transform", `rotate(${ARM_REST_R + armSwing}, 61, 59)`);
        armL.setAttribute("transform", `rotate(${ARM_REST_L - armSwing}, 29, 59)`);
        legR.setAttribute("transform", `rotate(${LEG_REST - legSwing}, 56, 88)`);
        legL.setAttribute("transform", `rotate(${LEG_REST + legSwing}, 34, 88)`);
        body.setAttribute("transform", `rotate(3, 45, 92)`);
        head.setAttribute("transform", "");
      } else if (s.phase === "drag") {
        // Rapid chaotic oscillations, offset phases so limbs don't sync
        const t = s.walkFrame;
        armR.setAttribute("transform", `rotate(${ARM_REST_R + Math.sin(t) * 70}, 61, 59)`);
        armL.setAttribute("transform", `rotate(${ARM_REST_L + Math.sin(t + 1.2) * 70}, 29, 59)`);
        legR.setAttribute("transform", `rotate(${Math.sin(t + 2.1) * 35}, 56, 88)`);
        legL.setAttribute("transform", `rotate(${Math.sin(t + 3.0) * 35}, 34, 88)`);
        body.setAttribute("transform", "");
        head.setAttribute("transform", "");
      } else if (s.phase === "idle") {
        // Breathing scale on body, head actions on the head group
        const breathe = 1 + Math.sin(now / 900) * 0.015;
        body.setAttribute("transform", `scale(${breathe}) translate(0, ${(1 - breathe) * 92})`);

        // Head-tilt look-left-right
        if (s.idleActionKind === "lookLR") {
          const t = now - s.idleActionStartMs;
          let rot = 0;
          if (t < 300) rot = s.idleActionDir * 15 * easeInOut(t / 300);
          else if (t < 1100) rot = s.idleActionDir * 15;
          else if (t < 1400) rot = s.idleActionDir * 15 * (1 - easeInOut((t - 1100) / 300));
          head.setAttribute("transform", `rotate(${rot}, 45, 58)`);
        } else {
          head.setAttribute("transform", "");
        }

        // Scratch head — overrides the right arm only; left arm stays at rest
        if (s.idleActionKind === "scratch") {
          const t = now - s.idleActionStartMs;
          let armRotR = ARM_REST_R;
          if (t < 400) {
            armRotR = lerp(ARM_REST_R, -105, easeInOut(t / 400));
          } else if (t < 800) {
            armRotR = -105 + Math.sin((t - 400) / 60) * 8;
          } else if (t < 1200) {
            armRotR = lerp(-105, ARM_REST_R, easeInOut((t - 800) / 400));
          }
          armR.setAttribute("transform", `rotate(${armRotR}, 61, 59)`);
          armL.setAttribute("transform", `rotate(${ARM_REST_L}, 29, 59)`);
        } else {
          armR.setAttribute("transform", `rotate(${ARM_REST_R}, 61, 59)`);
          armL.setAttribute("transform", `rotate(${ARM_REST_L}, 29, 59)`);
        }
        legR.setAttribute("transform", `rotate(${LEG_REST}, 56, 88)`);
        legL.setAttribute("transform", `rotate(${LEG_REST}, 34, 88)`);
      } else if (s.phase === "turning") {
        // Static rest pose, no animation
        armR.setAttribute("transform", `rotate(${ARM_REST_R}, 61, 59)`);
        armL.setAttribute("transform", `rotate(${ARM_REST_L}, 29, 59)`);
        legR.setAttribute("transform", `rotate(${LEG_REST}, 56, 88)`);
        legL.setAttribute("transform", `rotate(${LEG_REST}, 34, 88)`);
        body.setAttribute("transform", "");
        head.setAttribute("transform", "");
      } else if (s.phase === "landing") {
        // Squash — interpolate body scale over landingUntilMs - LANDING_MS → now
        const startAt = s.landingUntilMs - LANDING_MS;
        const t = clamp((now - startAt) / LANDING_MS, 0, 1);
        // 0 → 0.6: crush (scale 1.2, 0.75). 0.6 → 1: snap back to 1,1.
        let sx = 1, sy = 1;
        if (t < 0.6) {
          sx = lerp(1.2, 0.95, t / 0.6);
          sy = lerp(0.75, 1.05, t / 0.6);
        } else {
          sx = lerp(0.95, 1, (t - 0.6) / 0.4);
          sy = lerp(1.05, 1, (t - 0.6) / 0.4);
        }
        body.setAttribute("transform", `matrix(${sx}, 0, 0, ${sy}, ${45 * (1 - sx)}, ${92 * (1 - sy)})`);
        head.setAttribute("transform", `matrix(${sx}, 0, 0, ${sy}, ${45 * (1 - sx)}, ${92 * (1 - sy)})`);
        armR.setAttribute("transform", `rotate(${ARM_REST_R}, 61, 59)`);
        armL.setAttribute("transform", `rotate(${ARM_REST_L}, 29, 59)`);
        legR.setAttribute("transform", `rotate(${LEG_REST}, 56, 88)`);
        legL.setAttribute("transform", `rotate(${LEG_REST}, 34, 88)`);
      } else if (s.phase === "peek") {
        // Rest pose (everything visible is static; wrapper handles the bob)
        armR.setAttribute("transform", `rotate(${ARM_REST_R}, 61, 59)`);
        armL.setAttribute("transform", `rotate(${ARM_REST_L}, 29, 59)`);
        legR.setAttribute("transform", `rotate(${LEG_REST}, 56, 88)`);
        legL.setAttribute("transform", `rotate(${LEG_REST}, 34, 88)`);
        body.setAttribute("transform", "");
        head.setAttribute("transform", `rotate(-8, 45, 34)`);
      }
    }

    scheduleNextBlink(performance.now());
    rafIdRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafIdRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardRef]);

  // When user changes selected face while not peeking, update the displayed face.
  useEffect(() => {
    if (stateRef.current.phase !== "peek") {
      setDisplayFace(selectedFace);
    }
  }, [selectedFace]);

  // Resize — if out of bounds, snap back to peek
  useEffect(() => {
    if (!dashboardRef.current) return;
    const obs = new ResizeObserver(() => {
      const s = stateRef.current;
      const bounds = dashboardRef.current?.getBoundingClientRect();
      if (!bounds) return;
      if (s.x > bounds.width - WRAPPER_W || s.y > bounds.height - WRAPPER_H || s.x < -WRAPPER_W) {
        setPhase("peek");
        s.facingDir = "S";
      } else {
        s.x = clamp(s.x, -WRAPPER_W / 2, bounds.width - WRAPPER_W);
        s.y = clamp(s.y, 0, bounds.height - WRAPPER_H);
      }
    });
    obs.observe(dashboardRef.current);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardRef]);

  // ── Pointer handlers ─────────────────────────────────────────────────────

  function onPointerDown(e: React.PointerEvent) {
    const s = stateRef.current;
    if (s.phase !== "peek" && s.phase !== "walk" && s.phase !== "idle" && s.phase !== "turning") return;
    const bounds = dashboardRef.current?.getBoundingClientRect();
    if (!bounds) return;
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch {}
    s.dragOffsetDx = e.clientX - (bounds.left + s.x);
    s.dragOffsetDy = e.clientY - (bounds.top + s.y);
    setPhase("drag");
  }

  function onPointerMove(e: React.PointerEvent) {
    const s = stateRef.current;
    if (s.phase !== "drag") return;
    const bounds = dashboardRef.current?.getBoundingClientRect();
    if (!bounds) return;
    s.x = clamp(
      e.clientX - bounds.left - s.dragOffsetDx,
      -WRAPPER_W / 2,
      Math.max(0, bounds.width - WRAPPER_W)
    );
    s.y = clamp(
      e.clientY - bounds.top - s.dragOffsetDy,
      0,
      Math.max(0, bounds.height - WRAPPER_H)
    );
  }

  function onPointerUp(e: React.PointerEvent) {
    const s = stateRef.current;
    if (s.phase !== "drag") return;
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch {}
    if (s.x < SIDEBAR_SNAP_PX) {
      s.facingDir = "S";
      setPhase("peek");
    } else {
      s.landingUntilMs = performance.now() + LANDING_MS;
      setPhase("landing");
    }
  }

  return (
    <>
      <style>{`
        .gooni-mascot-wrapper {
          position: fixed;
          width: ${WRAPPER_W}px;
          height: ${WRAPPER_H}px;
          z-index: 50;
          pointer-events: none;
        }
        /* Interactive in every phase — shape hit-testing via visiblePainted keeps
           notes underneath clickable at transparent corners. */
        .gooni-mascot-wrapper .gooni-mascot-svg { pointer-events: auto; cursor: grab; }
        .gooni-mascot-wrapper.gm-drag .gooni-mascot-svg { cursor: grabbing; }
        .gooni-mascot-svg { width: 100%; height: 100%; display: block; pointer-events: none; }
        .gooni-mascot-svg [data-hit] { pointer-events: visiblePainted; }
        /* Peek hitbox — off by default so it doesn't steal clicks from notes.
           Enabled only during peek where there's no content underneath anyway. */
        .gooni-peek-hitbox { pointer-events: none; cursor: grab; }
        .gooni-mascot-wrapper.gm-peek .gooni-peek-hitbox { pointer-events: all; cursor: grab; }
        /* Explicit grab cursor on every paintable part during peek so the cursor
           flips even on sub-pixel hover-over-the-head cases where browsers route
           hit-testing to the painted child before the sibling hitbox. */
        .gooni-mascot-wrapper.gm-peek .gooni-mascot-svg [data-hit] { cursor: grab; }
        .gooni-mascot-wrapper.gm-drag .gooni-mascot-svg [data-hit] { cursor: grabbing; }

        /* All parts stay visible regardless of facing — flipping horizontally for W is
           the only directional signal. Back-of-head and one-arm side profiles made the
           character read as broken at small scale. */

        /* Peek-only visibility swaps */
        .gooni-mascot-wrapper.gm-peek .gooni-body,
        .gooni-mascot-wrapper.gm-peek .gooni-leg-l,
        .gooni-mascot-wrapper.gm-peek .gooni-leg-r,
        .gooni-mascot-wrapper.gm-peek .gooni-arm-l,
        .gooni-mascot-wrapper.gm-peek .gooni-arm-r,
        .gooni-mascot-wrapper.gm-peek .gooni-shadow { opacity: 0; }
        .gooni-mascot-wrapper.gm-peek .gooni-grip-hand { opacity: 1; }
        .gooni-grip-hand { opacity: 0; }

        /* ─ Drop zone ─ visible while dragging, anchored at sidebar edge */
        .gooni-drop-zone {
          position: fixed;
          width: 56px;
          height: 120px;
          z-index: 49;
          pointer-events: none;
          border-radius: 12px;
          border: 2px dashed #1C1C1E;
          background:
            repeating-linear-gradient(
              45deg,
              rgba(74,222,128,0.18),
              rgba(74,222,128,0.18) 6px,
              rgba(28,28,30,0.06) 6px,
              rgba(28,28,30,0.06) 10px
            ),
            rgba(74,222,128,0.08);
          opacity: 0;
          transform: scale(0.9);
          transition: opacity 0.18s ease, transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .gooni-drop-zone.gdz-visible {
          opacity: 1;
          transform: scale(1);
          animation: gooni-drop-zone-pulse 1.8s ease-in-out infinite;
        }
        @keyframes gooni-drop-zone-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(74,222,128,0.0); }
          50%      { box-shadow: 0 0 0 8px rgba(74,222,128,0.18); }
        }
      `}</style>

      <div
        ref={dropZoneRef}
        className={`gooni-drop-zone ${dropZoneVisible ? "gdz-visible" : ""}`}
        aria-hidden="true"
      />

      <div
        ref={wrapperRef}
        className="gooni-mascot-wrapper gm-peek gf-S"
        aria-hidden="true"
      >
        <svg
          ref={svgRef}
          className="gooni-mascot-svg"
          viewBox="0 0 90 130"
          xmlns="http://www.w3.org/2000/svg"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <ellipse ref={shadowRef} className="gooni-shadow" cx="45" cy="126" rx="18" ry="4" fill="#00000018" />

          <g ref={legLRef} className="gooni-leg gooni-leg-l">
            <rect x="30" y="88" width="8" height="32" rx="4" fill="#1a1a1a" data-hit="1" />
            <rect x="24" y="116" width="18" height="8" rx="4" fill="#1a1a1a" data-hit="1" />
          </g>
          <g ref={legRRef} className="gooni-leg gooni-leg-r">
            <rect x="52" y="88" width="8" height="32" rx="4" fill="#1a1a1a" data-hit="1" />
            <rect x="48" y="116" width="18" height="8" rx="4" fill="#1a1a1a" data-hit="1" />
          </g>

          <g ref={bodyRef} className="gooni-body">
            <rect x="27" y="52" width="36" height="40" rx="6" fill="#4ADE80" data-hit="1" />
          </g>

          <g ref={armLRef} className="gooni-arm gooni-arm-l">
            <rect x="2" y="55" width="27" height="8" rx="4" fill="#1a1a1a" data-hit="1" />
          </g>
          <g ref={armRRef} className="gooni-arm gooni-arm-r">
            <rect x="61" y="55" width="27" height="8" rx="4" fill="#1a1a1a" data-hit="1" />
          </g>

          <g ref={gripRef} className="gooni-grip-hand">
            <rect x="20" y="48" width="16" height="10" rx="5" fill="#1a1a1a" data-hit="1" />
          </g>

          <g ref={headRef} className="gooni-head">
            <circle cx="45" cy="34" r="24" fill="#1a1a1a" data-hit="1" />
            <g ref={faceGroupRef} className="gooni-head-face">
              <circle cx="45" cy="34" r="19" fill="#f2f2f2" data-hit="1" />
              <Face face={displayFace} />
            </g>
          </g>

          {/* Peek hitbox — LAST child so it's topmost in SVG hit-testing. Transparent
              fill + pointer-events: all (during peek only) means the cursor flips to
              grab over the full 90×130 bounding box, even where no painted shape
              exists. Off in other phases so notes beneath stay clickable. */}
          <rect
            className="gooni-peek-hitbox"
            x="0" y="0" width="90" height="130"
            fill="transparent"
          />
        </svg>
      </div>
    </>
  );
}
