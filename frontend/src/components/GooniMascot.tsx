import { useEffect, useRef, useState } from "react";
import { useGooniFaceStore, type GooniFace } from "../stores/useGooniFaceStore";

// Interactive mascot: peeks from sidebar, drag-to-toss, wanders with perspective.
// Supports 4 cardinal facing directions (N/S/E/W) with a proper turn-in-place state —
// the character stops, rotates to the new facing, then resumes walking.
// Walk cycle uses contralateral limb swing (opposite arm + leg move together).

type MascotState = "peek" | "drag" | "walk" | "idle" | "landing" | "turning";
type Facing = "N" | "S" | "E" | "W";

interface GooniMascotProps {
  dashboardRef: React.RefObject<HTMLDivElement | null>;
}

// Half of the v4 natural size (90×130 → 45×65)
const WRAPPER_W = 48;
const WRAPPER_H = 68;
const SIDEBAR_SNAP_PX = 40;
const TURN_MS = 220;

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function facingFor(dx: number, dy: number): Facing {
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

export function Face({ face }: { face: GooniFace }) {
  switch (face) {
    case "smirk": return <FaceSmirk />;
    case "side-eye": return <FaceSideEye />;
    case "hyped": return <FaceHyped />;
    case "dead-inside": return <FaceDeadInside />;
    case "sus": return <FaceSus />;
    case "crying-laughing": return <FaceCryingLaughing />;
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

export function GooniMascot({ dashboardRef }: GooniMascotProps) {
  const selectedFace = useGooniFaceStore((s) => s.face);

  const [state, setState] = useState<MascotState>("peek");
  const stateRef = useRef<MascotState>("peek");
  stateRef.current = state;

  const [facing, setFacing] = useState<Facing>("S");
  const facingRef = useRef<Facing>("S");
  facingRef.current = facing;

  const wrapperRef = useRef<HTMLDivElement>(null);
  const pos = useRef({ x: 0, y: 0 });
  const target = useRef({ x: 0, y: 0 });
  const pauseUntil = useRef<number>(0);
  const grabOffset = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const rafId = useRef<number>(0);

  const activeFace: GooniFace = state === "peek" ? "sus" : selectedFace;

  function pickWaypoint(bounds: DOMRect) {
    const insetX = 40;
    const insetTop = 30;
    const insetBottom = 60;
    const tx = insetX + Math.random() * Math.max(1, bounds.width - WRAPPER_W - insetX * 2);
    const ty = insetTop + Math.random() * Math.max(1, bounds.height - WRAPPER_H - insetTop - insetBottom);
    target.current = { x: tx, y: ty };
  }

  // Transition helper: if target facing differs from current, enter turn state
  function setFacingWithTurn(newFacing: Facing, afterTurn: () => void) {
    if (newFacing === facingRef.current) { afterTurn(); return; }
    setFacing(newFacing);
    setState("turning");
    setTimeout(() => {
      if (stateRef.current === "turning") afterTurn();
    }, TURN_MS);
  }

  // rAF loop
  useEffect(() => {
    function tick(now: number) {
      const bounds = dashboardRef.current?.getBoundingClientRect();
      const wrapper = wrapperRef.current;
      if (!bounds || !wrapper) {
        rafId.current = requestAnimationFrame(tick);
        return;
      }
      const s = stateRef.current;

      if (s === "walk") {
        const depth = clamp(pos.current.y / Math.max(1, bounds.height), 0, 1);
        const speed = 1.2 * lerp(0.9, 1.5, depth);
        const dx = target.current.x - pos.current.x;
        const dy = target.current.y - pos.current.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 2) {
          setState("idle");
          pauseUntil.current = now + 1500 + Math.random() * 1500;
        } else {
          pos.current.x += (dx / dist) * speed;
          pos.current.y += (dy / dist) * speed;
        }
      } else if (s === "idle") {
        if (now >= pauseUntil.current) {
          pickWaypoint(bounds);
          const dx = target.current.x - pos.current.x;
          const dy = target.current.y - pos.current.y;
          const nextFacing = facingFor(dx, dy);
          setFacingWithTurn(nextFacing, () => setState("walk"));
        }
      } else if (s === "peek") {
        pos.current.x = -18;
        pos.current.y = bounds.height / 2 - WRAPPER_H / 2;
      }

      const depth = clamp(pos.current.y / Math.max(1, bounds.height), 0, 1);
      const scaleBase = s === "peek" ? 0.85 : s === "drag" ? 1.1 : 0.7 + depth * 0.5;
      // Flip horizontally only when facing west (character's left profile mirrored from east)
      const flipX = facingRef.current === "W" ? -1 : 1;

      wrapper.style.left = `${bounds.left + pos.current.x}px`;
      wrapper.style.top = `${bounds.top + pos.current.y}px`;
      wrapper.style.transform = `scale(${scaleBase * flipX}, ${scaleBase})`;
      wrapper.style.transformOrigin = "50% 100%";

      rafId.current = requestAnimationFrame(tick);
    }
    rafId.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId.current);
  }, [dashboardRef]);

  // ResizeObserver — snap back to peek if out of bounds
  useEffect(() => {
    if (!dashboardRef.current) return;
    const obs = new ResizeObserver(() => {
      const bounds = dashboardRef.current?.getBoundingClientRect();
      if (!bounds) return;
      if (
        pos.current.x > bounds.width - WRAPPER_W ||
        pos.current.y > bounds.height - WRAPPER_H ||
        pos.current.x < -WRAPPER_W
      ) {
        setState("peek");
      } else {
        pos.current.x = clamp(pos.current.x, -WRAPPER_W / 2, bounds.width - WRAPPER_W);
        pos.current.y = clamp(pos.current.y, 0, bounds.height - WRAPPER_H);
      }
    });
    obs.observe(dashboardRef.current);
    return () => obs.disconnect();
  }, [dashboardRef]);

  function onPointerDown(e: React.PointerEvent) {
    const s = stateRef.current;
    if (s !== "peek" && s !== "walk" && s !== "idle" && s !== "turning") return;
    const bounds = dashboardRef.current?.getBoundingClientRect();
    if (!bounds) return;
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch {}
    grabOffset.current = {
      dx: e.clientX - (bounds.left + pos.current.x),
      dy: e.clientY - (bounds.top + pos.current.y),
    };
    setState("drag");
  }

  function onPointerMove(e: React.PointerEvent) {
    if (stateRef.current !== "drag") return;
    const bounds = dashboardRef.current?.getBoundingClientRect();
    if (!bounds) return;
    pos.current.x = clamp(
      e.clientX - bounds.left - grabOffset.current.dx,
      -WRAPPER_W / 2,
      Math.max(0, bounds.width - WRAPPER_W)
    );
    pos.current.y = clamp(
      e.clientY - bounds.top - grabOffset.current.dy,
      0,
      Math.max(0, bounds.height - WRAPPER_H)
    );
  }

  function onPointerUp(e: React.PointerEvent) {
    if (stateRef.current !== "drag") return;
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch {}
    if (pos.current.x < SIDEBAR_SNAP_PX) {
      setFacing("S");
      setState("peek");
    } else {
      setState("landing");
      setTimeout(() => {
        if (stateRef.current !== "landing") return;
        const bounds = dashboardRef.current?.getBoundingClientRect();
        if (!bounds) return;
        pickWaypoint(bounds);
        const dx = target.current.x - pos.current.x;
        const dy = target.current.y - pos.current.y;
        const nextFacing = facingFor(dx, dy);
        setFacingWithTurn(nextFacing, () => setState("walk"));
      }, 220);
    }
  }

  const stateClass = `gm-${state}`;
  const facingClass = `gf-${facing}`;

  return (
    <>
      <style>{`
        .gooni-mascot-wrapper {
          position: fixed;
          width: ${WRAPPER_W}px;
          height: ${WRAPPER_H}px;
          z-index: 50;
          pointer-events: none;
          transition: left 0.28s cubic-bezier(0.22,1,0.36,1), top 0.28s cubic-bezier(0.22,1,0.36,1);
        }
        .gooni-mascot-wrapper.gm-peek .gooni-mascot-svg,
        .gooni-mascot-wrapper.gm-walk .gooni-mascot-svg,
        .gooni-mascot-wrapper.gm-idle .gooni-mascot-svg,
        .gooni-mascot-wrapper.gm-turning .gooni-mascot-svg,
        .gooni-mascot-wrapper.gm-drag .gooni-mascot-svg { pointer-events: auto; }
        .gooni-mascot-wrapper.gm-drag .gooni-mascot-svg { cursor: grabbing; }
        .gooni-mascot-wrapper.gm-peek .gooni-mascot-svg,
        .gooni-mascot-wrapper.gm-walk .gooni-mascot-svg,
        .gooni-mascot-wrapper.gm-idle .gooni-mascot-svg,
        .gooni-mascot-wrapper.gm-turning .gooni-mascot-svg { cursor: grab; }
        .gooni-mascot-wrapper.gm-walk,
        .gooni-mascot-wrapper.gm-idle,
        .gooni-mascot-wrapper.gm-landing,
        .gooni-mascot-wrapper.gm-turning,
        .gooni-mascot-wrapper.gm-drag { transition: none; }
        .gooni-mascot-svg { width: 100%; height: 100%; display: block; pointer-events: none; }
        .gooni-mascot-svg [data-hit] { pointer-events: visiblePainted; }

        /* Arm rest poses, baked in via CSS so keyframes can override */
        .gooni-arm-l { transform: rotate(12deg); transform-origin: 29px 59px; transition: opacity 0.2s; }
        .gooni-arm-r { transform: rotate(-12deg); transform-origin: 61px 59px; transition: opacity 0.2s; }
        .gooni-head-face { transition: opacity 0.2s; }
        .gooni-head { transition: transform 0.25s; }

        /* ── FACING modifiers ── */
        /* Facing E (right) — side profile. Hide the far arm (the left arm). */
        .gooni-mascot-wrapper.gf-E .gooni-arm-l { opacity: 0; }
        /* Facing W (left) — same sprite but horizontally flipped by wrapper's scaleX(-1).
           After flip, the SVG's left arm renders on the right visually but is still the
           "behind the body" arm — hide it to keep the profile clean. */
        .gooni-mascot-wrapper.gf-W .gooni-arm-l { opacity: 0; }
        /* Facing N (back to camera) — hide the face; head slightly smaller */
        .gooni-mascot-wrapper.gf-N .gooni-head-face { opacity: 0; }
        .gooni-mascot-wrapper.gf-N .gooni-head { transform: scale(0.88); transform-origin: 45px 58px; }

        /* ── PEEK ── */
        @keyframes gm-peek-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
        .gooni-mascot-wrapper.gm-peek .gooni-mascot-svg { animation: gm-peek-bob 2.2s ease-in-out infinite; }
        .gooni-mascot-wrapper.gm-peek .gooni-body,
        .gooni-mascot-wrapper.gm-peek .gooni-leg-l,
        .gooni-mascot-wrapper.gm-peek .gooni-leg-r,
        .gooni-mascot-wrapper.gm-peek .gooni-arm-l,
        .gooni-mascot-wrapper.gm-peek .gooni-arm-r,
        .gooni-mascot-wrapper.gm-peek .gooni-shadow { opacity: 0; }
        .gooni-mascot-wrapper.gm-peek .gooni-grip-hand { opacity: 1; }
        .gooni-mascot-wrapper.gm-peek .gooni-head { transform: rotate(-8deg); transform-origin: 45px 34px; }

        /* ── DRAG ── */
        @keyframes gm-flail-arm-l { 0%,100% { transform: rotate(-30deg); } 50% { transform: rotate(60deg); } }
        @keyframes gm-flail-arm-r { 0%,100% { transform: rotate(30deg); } 50% { transform: rotate(-60deg); } }
        @keyframes gm-flail-leg-l { 0%,100% { transform: rotate(-25deg); } 50% { transform: rotate(25deg); } }
        @keyframes gm-flail-leg-r { 0%,100% { transform: rotate(25deg); } 50% { transform: rotate(-25deg); } }
        .gooni-mascot-wrapper.gm-drag .gooni-arm-l { animation: gm-flail-arm-l 0.15s linear infinite; }
        .gooni-mascot-wrapper.gm-drag .gooni-arm-r { animation: gm-flail-arm-r 0.15s linear infinite; }
        .gooni-mascot-wrapper.gm-drag .gooni-leg-l { animation: gm-flail-leg-l 0.17s linear infinite; }
        .gooni-mascot-wrapper.gm-drag .gooni-leg-r { animation: gm-flail-leg-r 0.16s linear infinite; }

        /* ── WALK ── Proper contralateral stride.
           L-arm and R-leg swing together (same phase). R-arm and L-leg swing together.
           Arms rotate OPPOSITE directions (one CW while other CCW) so character
           doesn't "flap". Leg pivots at hip, arm pivots at shoulder. */
        @keyframes gm-walk-arm-l {
          0%, 100% { transform: rotate(35deg); }   /* L-arm BACK (down) */
          50%      { transform: rotate(-10deg); }  /* L-arm FWD (up) */
        }
        @keyframes gm-walk-arm-r {
          0%, 100% { transform: rotate(-35deg); }  /* R-arm FWD (up) */
          50%      { transform: rotate(10deg); }   /* R-arm BACK (down) */
        }
        @keyframes gm-walk-leg-l {
          0%, 100% { transform: rotate(-20deg); }  /* L-leg FWD */
          50%      { transform: rotate(20deg); }   /* L-leg BACK */
        }
        @keyframes gm-walk-leg-r {
          0%, 100% { transform: rotate(20deg); }   /* R-leg BACK */
          50%      { transform: rotate(-20deg); }  /* R-leg FWD */
        }
        /* Head bobs once per full stride — up at midpoint, neutral at extremes */
        @keyframes gm-walk-head-bob {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-2px); }
        }
        .gooni-mascot-wrapper.gm-walk .gooni-arm-l { animation: gm-walk-arm-l 0.5s ease-in-out infinite; }
        .gooni-mascot-wrapper.gm-walk .gooni-arm-r { animation: gm-walk-arm-r 0.5s ease-in-out infinite; }
        .gooni-mascot-wrapper.gm-walk .gooni-leg-l { animation: gm-walk-leg-l 0.5s ease-in-out infinite; }
        .gooni-mascot-wrapper.gm-walk .gooni-leg-r { animation: gm-walk-leg-r 0.5s ease-in-out infinite; }
        .gooni-mascot-wrapper.gm-walk .gooni-head  { animation: gm-walk-head-bob 0.5s ease-in-out infinite; transform-origin: 45px 58px; }
        /* Forward body lean (auto-flips with wrapper scaleX when facing W) */
        .gooni-mascot-wrapper.gm-walk .gooni-body { transform: rotate(3deg); transform-origin: 45px 92px; }

        /* ── TURNING — static pose during the flip. No walk animation, no position change. ── */
        .gooni-mascot-wrapper.gm-turning .gooni-arm-l,
        .gooni-mascot-wrapper.gm-turning .gooni-arm-r,
        .gooni-mascot-wrapper.gm-turning .gooni-leg-l,
        .gooni-mascot-wrapper.gm-turning .gooni-leg-r { animation: none; }

        /* ── IDLE ── */
        @keyframes gm-breathe { 0%,100% { transform: scale(1,1); } 50% { transform: scale(1.02, 0.98); } }
        @keyframes gm-head-tilt { 0%,100% { transform: rotate(0deg); } 40% { transform: rotate(-4deg); } 80% { transform: rotate(3deg); } }
        .gooni-mascot-wrapper.gm-idle .gooni-body { animation: gm-breathe 2.6s ease-in-out infinite; transform-origin: 45px 92px; }
        .gooni-mascot-wrapper.gm-idle .gooni-head { animation: gm-head-tilt 3.2s ease-in-out infinite; transform-origin: 45px 58px; }

        /* ── LANDING ── */
        @keyframes gm-land { 0% { transform: scale(1.2, 0.75); } 55% { transform: scale(0.95, 1.05); } 100% { transform: scale(1, 1); } }
        @keyframes gm-shadow-land { 0% { transform: scale(1.6, 1); opacity: 0.35; } 100% { transform: scale(1, 1); opacity: 0.15; } }
        .gooni-mascot-wrapper.gm-landing .gooni-body,
        .gooni-mascot-wrapper.gm-landing .gooni-head { animation: gm-land 0.22s ease-out forwards; transform-origin: 50% 100%; }
        .gooni-mascot-wrapper.gm-landing .gooni-shadow { animation: gm-shadow-land 0.22s ease-out forwards; transform-origin: 50% 100%; }

        .gooni-grip-hand { opacity: 0; }
      `}</style>

      <div
        ref={wrapperRef}
        className={`gooni-mascot-wrapper ${stateClass} ${facingClass}`}
        aria-hidden="true"
      >
        <svg
          className="gooni-mascot-svg"
          viewBox="0 0 90 130"
          xmlns="http://www.w3.org/2000/svg"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <ellipse className="gooni-shadow" cx="45" cy="126" rx="18" ry="4" fill="#00000018" />

          <g className="gooni-leg gooni-leg-l" style={{ transformOrigin: "34px 88px" }}>
            <rect x="30" y="88" width="8" height="32" rx="4" fill="#1a1a1a" data-hit="1" />
            <rect x="24" y="116" width="18" height="8" rx="4" fill="#1a1a1a" data-hit="1" />
          </g>
          <g className="gooni-leg gooni-leg-r" style={{ transformOrigin: "56px 88px" }}>
            <rect x="52" y="88" width="8" height="32" rx="4" fill="#1a1a1a" data-hit="1" />
            <rect x="48" y="116" width="18" height="8" rx="4" fill="#1a1a1a" data-hit="1" />
          </g>

          <g className="gooni-body">
            <rect x="27" y="52" width="36" height="40" rx="6" fill="#4ADE80" data-hit="1" />
          </g>

          <g className="gooni-arm gooni-arm-l">
            <rect x="2" y="55" width="27" height="8" rx="4" fill="#1a1a1a" data-hit="1" />
          </g>
          <g className="gooni-arm gooni-arm-r">
            <rect x="61" y="55" width="27" height="8" rx="4" fill="#1a1a1a" data-hit="1" />
          </g>

          <g className="gooni-grip-hand">
            <rect x="20" y="48" width="16" height="10" rx="5" fill="#1a1a1a" data-hit="1" />
          </g>

          <g className="gooni-head">
            <circle cx="45" cy="34" r="24" fill="#1a1a1a" data-hit="1" />
            {/* face layer — hidden when facing N */}
            <g className="gooni-head-face">
              <circle cx="45" cy="34" r="19" fill="#f2f2f2" data-hit="1" />
              <Face face={activeFace} />
            </g>
          </g>
        </svg>
      </div>
    </>
  );
}
