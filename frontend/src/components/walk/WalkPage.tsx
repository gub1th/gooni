import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Volume2, VolumeX, Home, FileText, Footprints } from "lucide-react";
import { STATIONS, type Station } from "../../content/walk";
import { PROFILE } from "../../content/portfolio";
import { CtrlButton } from "../CtrlButton";
import { AmbientAudio } from "../creative/AmbientAudio";
import { setSfxMuted } from "../creative/sfx";
import { setScroll } from "./scrollBus";
import { WalkScene } from "./WalkScene";

// The converged portfolio: one document, two renderings.
//
// Everything a reader needs is real DOM here — selectable, searchable,
// screen-readable, and complete with WebGL switched off. The 3D scene
// behind it is enrichment, never the carrier. That's what let the "3D
// version" and the "flat CV" collapse into a single surface instead of
// two that drift apart.
//
// Scroll is the only control. There is no avatar to steer, no nickname
// to enter, no drop-in gate — you arrive already moving, and the one
// direction available is forward.

const DISPLAY = "'Iowan Old Style', 'Hoefler Text', Palatino, Georgia, serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

function useWebGL(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    try {
      const c = document.createElement("canvas");
      setOk(Boolean(c.getContext("webgl2") ?? c.getContext("webgl")));
    } catch {
      setOk(false);
    }
  }, []);
  return ok;
}

export function WalkPage() {
  const webgl = useWebGL();
  const navigate = useNavigate();
  const [falling, setFalling] = useState(false);
  const fallingRef = useRef(false);
  const [active, setActive] = useState(0);
  const sectionRefs = useRef<(HTMLElement | null)[]>([]);
  const heroRef = useRef<HTMLElement | null>(null);
  const footerRef = useRef<HTMLElement | null>(null);
  const lastY = useRef(0);
  const vel = useRef(0);
  // Current anchor across the whole document: 0 = hero, 1..n = stations,
  // n+1 = footer. Arrow keys step this; the scroll sampler keeps it in
  // sync with where the reader actually is.
  const navIndex = useRef(0);
  // True while a programmatic snap/hop scroll is animating, so the idle
  // sampler doesn't try to re-snap on the scroll events it generates.
  const snapping = useRef(false);

  // One rAF-throttled listener drives both the 3D rig and the active
  // station. Scroll fires far faster than paint; doing this work per
  // event would starve the render loop the scene depends on.
  useEffect(() => {
    let raf = 0;
    let queued = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const prefersReduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // hero + stations + footer, in document order.
    const anchors = () => [heroRef.current, ...sectionRefs.current, footerRef.current];

    function nearestAnchor(): number {
      const mid = window.innerHeight * 0.5;
      let idx = navIndex.current;
      let best = Infinity;
      anchors().forEach((el, i) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - mid);
        if (d < best) {
          best = d;
          idx = i;
        }
      });
      return idx;
    }

    // Continuous station-space position from the ACTUAL section geometry.
    // The 3D walker rides this, not whole-document `progress`: anchors are
    // [hero, st0..st4, footer], so anchor-index `k` maps to station-space
    // `k - 1` (hero = -1, station i = i, footer = last). Interpolating
    // between the two anchors the viewport centre sits between is what
    // keeps a poster fixed at station i's Z framed exactly when card i is
    // centred — the mapping raw `progress` never had.
    function walkPos(): number {
      const list = anchors();
      const vdc = window.scrollY + window.innerHeight * 0.5;
      const centers: number[] = [];
      for (const el of list) {
        if (!el) return 0; // not all mounted yet
        const r = el.getBoundingClientRect();
        centers.push(r.top + window.scrollY + r.height / 2);
      }
      const last = centers.length - 1;
      if (vdc <= centers[0]) return -1;
      if (vdc >= centers[last]) return last - 1;
      for (let k = 0; k < last; k++) {
        if (vdc >= centers[k] && vdc <= centers[k + 1]) {
          const t = (vdc - centers[k]) / (centers[k + 1] - centers[k]);
          return k + t - 1;
        }
      }
      return last - 1;
    }

    // Ease onto the nearest station once scrolling settles — a firm,
    // eased anchor instead of the browser's proximity snap (which fired
    // mid-scroll and felt like it was fighting you). Skipped for the
    // short footer, when already centred (deadzone), and under reduced
    // motion.
    function maybeSnap() {
      // Phones read, they don't tour — snapping a thumb-skimmed document
      // fights the reader. Anchor only on the desktop tour (>760px).
      if (snapping.current || prefersReduce || window.innerWidth <= 760) return;
      const idx = navIndex.current;
      if (idx === sectionRefs.current.length + 1) return; // footer: let it rest
      const el = anchors()[idx];
      if (!el) return;
      const r = el.getBoundingClientRect();
      const offset = r.top + r.height / 2 - window.innerHeight * 0.5;
      if (Math.abs(offset) > 14) {
        snapping.current = true;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        window.setTimeout(() => {
          snapping.current = false;
        }, 700);
      }
    }

    function sample() {
      queued = false;
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      const y = window.scrollY;
      const progress = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0;

      const dy = y - lastY.current;
      lastY.current = y;
      // Smooth the velocity so a trackpad's jitter doesn't flicker the
      // walk/idle animation on every frame.
      vel.current = vel.current * 0.82 + dy * 0.18;

      const mid = window.innerHeight * 0.45;
      let nearest = 0;
      let best = Infinity;
      sectionRefs.current.forEach((el, i) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - mid);
        if (d < best) {
          best = d;
          nearest = i;
        }
      });

      navIndex.current = nearestAnchor();
      setScroll({ progress, station: nearest, velocity: vel.current, walkPos: walkPos() });
      setActive((cur) => (cur === nearest ? cur : nearest));

      // Hard-stop the walk once scrolling actually ends, then anchor.
      // The smoothing above is an IIR filter — it approaches zero but
      // never arrives, so the walk-vs-idle threshold alone left the
      // character striding on the spot forever after the page came to
      // rest. Scroll events stop firing when motion stops, so a short
      // timer is the only reliable "settled" signal.
      clearTimeout(settle);
      settle = setTimeout(() => {
        vel.current = 0;
        setScroll({ velocity: 0 });
        maybeSnap();
      }, 160);
    }

    function onScroll() {
      if (queued) return;
      queued = true;
      raf = requestAnimationFrame(sample);
    }

    sample();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  // Fall back to the plaza — shared by the over-scroll gesture AND pressing
  // forward (↑) at the very end, so the arrow keys keep working at the edge.
  const doFall = useCallback(() => {
    if (fallingRef.current) return;
    fallingRef.current = true;
    setFalling(true);
    setScroll({ falling: true });
    // Let the drop + veil play, then hand off to the plaza.
    window.setTimeout(() => navigate({ to: "/public" }), 1100);
  }, [navigate]);

  // Keyboard navigation — arrow/page keys hop station to station (the
  // character walks the gap), the way the plaza was navigated. Scroll
  // still works; this is additive. Focus inside a scrollable card or a
  // field is left alone so those keep their own arrow behaviour.
  useEffect(() => {
    const prefersReduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    function hop(target: number) {
      const list = [heroRef.current, ...sectionRefs.current, footerRef.current];
      // Forward from the LAST STATION = walk off the edge → fall to plaza.
      // `>=` (not `>`) so ↑ at the edge falls in ONE press instead of first
      // stopping on the footer; the footer stays reachable by scroll.
      if (target >= list.length - 1) {
        doFall();
        return;
      }
      const clamped = Math.max(0, Math.min(list.length - 1, target));
      const el = list[clamped];
      if (!el) return;
      navIndex.current = clamped;
      snapping.current = true;
      window.setTimeout(() => {
        snapping.current = false;
      }, 700);
      el.scrollIntoView({
        behavior: prefersReduce ? "auto" : "smooth",
        block: clamped === list.length - 1 ? "end" : "center",
      });
    }
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && t.closest(".walk-col, input, textarea, [contenteditable='true']")) return;
      switch (e.key) {
        // Up = forward. The walk's metaphor is "press forward to advance"
        // (W/↑), not "scroll the document down" — so ↑ walks deeper and ↓
        // steps back. PageDown/PageUp stay conventional for readers who
        // expect page paging.
        case "ArrowUp":
        case "PageDown":
          e.preventDefault();
          hop(navIndex.current + 1);
          break;
        case "ArrowDown":
        case "PageUp":
          e.preventDefault();
          hop(navIndex.current - 1);
          break;
        case "Home":
          e.preventDefault();
          hop(0);
          break;
        case "End":
          e.preventDefault();
          hop(sectionRefs.current.length); // last station (the edge)
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doFall]);

  // The loop back to the plaza. Over-scroll past the very bottom and the
  // walker drops off the edge of the world → we fall back into the plaza,
  // the mirror of jumping into the hole there. scrollBus is module-level
  // and survives the route change, so reset the flag on mount too.
  useEffect(() => {
    fallingRef.current = false;
    setScroll({ falling: false });

    let over = 0;
    const atBottom = () =>
      window.scrollY >= document.documentElement.scrollHeight - window.innerHeight - 2;
    function onWheel(e: WheelEvent) {
      if (fallingRef.current) return;
      // A deliberate push PAST the end, not merely arriving at it: only
      // count downward wheel once already pinned to the bottom, and bleed
      // it off otherwise so idling at the footer never trips it.
      if (atBottom() && e.deltaY > 0) {
        over += e.deltaY;
        if (over > 380) doFall();
      } else {
        over = Math.max(0, over - 24);
      }
    }
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [doFall]);

  return (
    <div className="walk-root">
      <style>{`
        .walk-root {
          --w-ink: #F2EFE8;
          /* Alphas raised after a contrast audit: over a BRIGHT sky the
             old panel (0.62) left body text near 4.1:1 and the mono meta
             near 2.6:1 — both under the 4.5:1 floor. The panel has to
             carry the contrast because the backdrop is deliberately
             light and changes as you scroll. */
          --w-ink2: rgba(242,239,232,0.88);
          --w-dim: rgba(242,239,232,0.66);
          --w-panel: rgba(12,15,18,0.84);
          --w-line: rgba(242,239,232,0.14);
          --w-cut: #E9736F;
          background: #0C0F12;
          color: var(--w-ink);
          font-family: ${SANS};
          line-height: 1.62;
          -webkit-font-smoothing: antialiased;
          position: relative;
        }
        /* The sky is warm and light, so over the 3D the copy needs the
           dark treatment in BOTH colour schemes — a light-on-light pass
           would be unreadable against the horizon. Only the no-WebGL
           fallback follows the viewer's theme. */
        .walk-root.flat { background: #0C0F12; }
        @media (prefers-color-scheme: light) {
          .walk-root.flat { background: #F4F2ED; --w-ink:#14171A;
            --w-ink2: rgba(20,23,26,0.74); --w-dim: rgba(20,23,26,0.48);
            --w-panel: rgba(255,255,255,0.72); --w-line: rgba(20,23,26,0.14); --w-cut:#B03A36; }
        }
        .walk-root :where(h1,h2,h3){ font-family:${DISPLAY}; font-weight:500;
          letter-spacing:-0.022em; text-wrap:balance; margin:0; }
        /* Anchoring is done in JS (snap-on-idle in WalkPage), not CSS
           snap. Native snap fired mid-scroll and felt like it was
           fighting you; the JS version waits until scrolling settles,
           then eases onto the nearest station — a firm anchor with a
           clean ease-in/out, and no tug-of-war with the walk cycle. */
        html { scroll-behavior: smooth; }
        /* Sections are click-THROUGH so the empty area over the 3D floor
           reaches the canvas (the engraved link tiles are clickable there);
           the copy cards inside re-enable pointer events for their own links. */
        .walk-sec { position:relative; z-index:1; min-height:100svh;
          display:flex; align-items:center; padding:8vh 0; pointer-events:none; }
        .walk-col { position:relative; pointer-events:auto; width:min(520px, calc(100vw - 48px)); margin-left:max(40px, 7vw);
          background:var(--w-panel); backdrop-filter:blur(18px) saturate(150%);
          -webkit-backdrop-filter:blur(18px) saturate(150%);
          border:1px solid var(--w-line); border-radius:18px; padding:30px 32px;
          /* A card taller than the viewport would strand its own tail
             between snap points. Cap it and let the long ones (Gooni)
             scroll inside instead.
             NOT overscroll-behavior:contain — that blocks scroll
             chaining, so the wheel would stop dead at the end of the
             Gooni card and the reader had to move the pointer off it to
             continue the page. Chaining is what we want here. */
          max-height:82svh; overflow-y:auto; }
        .walk-col::-webkit-scrollbar { width:0; }
        .walk-col { scrollbar-width:none; }
        .walk-eyebrow { font-family:${MONO}; font-size:10.5px; letter-spacing:.16em;
          text-transform:uppercase; margin-bottom:12px; }
        .walk-meta { font-family:${MONO}; font-size:11.5px; color:var(--w-dim);
          margin:8px 0 20px; }
        .walk-body p { font-size:15.5px; color:var(--w-ink2); margin:0 0 15px; }
        .walk-body p:last-child { margin-bottom:0; }
        .walk-pull { font-family:${DISPLAY}; font-size:21px; line-height:1.38;
          margin:22px 0 0; padding-left:16px; border-left:2px solid currentColor; }
        .walk-stats { display:flex; flex-wrap:wrap; gap:26px; margin-top:22px; }
        .walk-stats .n { font-family:${DISPLAY}; font-size:26px; line-height:1;
          font-variant-numeric:tabular-nums; }
        .walk-stats .l { font-family:${MONO}; font-size:9.5px; letter-spacing:.1em;
          text-transform:uppercase; color:var(--w-dim); margin-top:6px; }
        .walk-beats { list-style:none; margin:18px 0 0; padding:0; }
        .walk-beats li { position:relative; padding:7px 0 7px 22px; font-size:13.5px;
          color:var(--w-ink2); border-bottom:1px solid var(--w-line); }
        .walk-beats li:last-child { border-bottom:none; }
        .walk-beats li::before { content:""; position:absolute; left:2px; top:17px;
          width:7px; height:7px; border-radius:50%; background:currentColor; opacity:.5; }
        .walk-beats li.cut { color:var(--w-dim); text-decoration:line-through;
          text-decoration-color:var(--w-cut); text-decoration-thickness:1.5px; }
        .walk-beats li.cut::before { background:transparent;
          border:1.5px solid var(--w-cut); opacity:1; }
        .walk-why { display:block; font-family:${MONO}; font-size:11px; color:var(--w-cut);
          margin-top:4px; text-decoration:none; }
        .walk-links { display:flex; flex-wrap:wrap; gap:9px; margin-top:22px; }
        .walk-links a { font-size:12.5px; padding:8px 14px; border-radius:9px;
          border:1px solid var(--w-line); color:inherit; text-decoration:none;
          transition:background .16s ease; }
        .walk-links a:hover { background:rgba(255,255,255,0.07); }
        .walk-cvrow { position:absolute; top:16px; right:18px; margin:0; z-index:2; }
        .walk-cv { display:inline-flex; align-items:center; gap:8px; text-decoration:none;
          font-family:${SANS}; font-size:12.5px; color:var(--w-ink2);
          padding:5px 12px 5px 6px; border-radius:999px; border:1px solid var(--w-line);
          background:rgba(255,255,255,0.03); transition:background .16s ease; }
        .walk-cv:hover { background:rgba(255,255,255,0.09); }
        .walk-cv .ic { display:inline-flex; align-items:center; justify-content:center;
          width:20px; height:20px; border-radius:50%; background:rgba(74,222,128,0.15);
          color:#4ADE80; }
        /* Scroll cue — a row at the bottom of the hero card. Keys float. */
        .walk-scrollcue { display:flex; align-items:center; gap:12px;
          margin-top:26px; padding-top:18px; border-top:1px solid var(--w-line); }
        .wsc-label { font-family:${SANS}; font-size:12.5px; letter-spacing:.03em;
          color:var(--w-dim); }
        .wsc-keys { display:flex; gap:7px; }
        .wsc-key { display:inline-flex; align-items:center; justify-content:center;
          width:28px; height:28px; border-radius:7px;
          border:1px solid rgba(242,239,232,0.30); background:rgba(242,239,232,0.08);
          font-family:${SANS}; font-size:14px; color:var(--w-ink); line-height:1;
          animation:wsc-bob 2s ease-in-out infinite; }
        .wsc-key:nth-child(2) { animation-delay:.18s; }
        @keyframes wsc-bob {
          0%,100% { transform:translateY(0); }
          50%     { transform:translateY(4px); }
        }
        @media (prefers-reduced-motion: reduce) { .wsc-key { animation:none; } }
        .walk-shot { width:100%; border-radius:12px; border:1px solid var(--w-line);
          margin-top:22px; display:block; }
        .walk-shots { margin-top:22px; display:flex; flex-direction:column; gap:8px; }
        .walk-shots .walk-shot { margin-top:0; }
        .walk-figure { margin:0; }
        .walk-caption { font-family:${MONO}; font-size:10px; letter-spacing:.09em;
          text-transform:uppercase; color:var(--w-dim); margin-top:7px; }
        .walk-arrow { font-size:15px; line-height:1; color:var(--w-dim);
          text-align:center; margin:2px 0; }
        .walk-rail { position:fixed; right:26px; top:50%; transform:translateY(-50%);
          z-index:3; display:flex; flex-direction:column-reverse; gap:14px; }
        .walk-rail button { all:unset; cursor:pointer; display:flex; align-items:center;
          gap:10px; justify-content:flex-end; }
        .walk-rail .lbl { font-family:${MONO}; font-size:10px; letter-spacing:.1em;
          text-transform:uppercase; color:var(--w-dim); opacity:0;
          transition:opacity .18s ease; white-space:nowrap; }
        .walk-rail button:hover .lbl, .walk-rail button:focus-visible .lbl { opacity:1; }
        .walk-rail .dot { width:8px; height:8px; border-radius:50%;
          border:1.5px solid var(--w-dim); transition:all .22s ease; }
        .walk-rail .dot.on { transform:scale(1.5); border-color:transparent; }
        .walk-rail button:focus-visible { outline:2px solid var(--w-ink); outline-offset:4px; }
        @media (max-width:760px) { .walk-rail { display:none; }
          .walk-col { margin-left:0; margin-right:0; width:100%; max-height:none; }
          .walk-sec { padding:10vh 20px; min-height:auto;
            /* Phones read; they don't tour. Snapping a document someone
               is skimming with a thumb fights them. */
            scroll-snap-align:none; }
          html { scroll-snap-type:none; } }
        @media (prefers-reduced-motion: reduce) {
          html { scroll-behavior:auto !important; scroll-snap-type:none !important; }
          .walk-sec { scroll-snap-align:none !important; } }
      `}</style>

      {webgl && <WalkScene />}

      <WalkControls />

      {/* Fall-to-plaza veil. Same late, dark wash the plaza uses on the
          jump-in, so the two transitions read as one loop. Always mounted
          so the opacity flip actually animates. */}
      <div
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          background: "#05070A",
          opacity: falling ? 1 : 0,
          transition: "opacity 800ms ease 150ms",
          pointerEvents: falling ? "auto" : "none",
          zIndex: 60,
        }}
      />

      {/* The way to the flat page now lives on the cards themselves (top-
          right of each, scrolling with them), not as a fixed pill. */}

      {/* Station rail — the quick-scan affordance. A reviewer who wants
          the summary jumps straight to a station instead of scrolling
          the whole walk. */}
      <nav className="walk-rail" aria-label="Sections">
        {STATIONS.map((s, i) => (
          <button
            key={s.id}
            onClick={() => sectionRefs.current[i]?.scrollIntoView({ behavior: "smooth" })}
            aria-label={s.title}
            aria-current={active === i ? "true" : undefined}
          >
            <span className="lbl">{s.title}</span>
            <span
              className={`dot${active === i ? " on" : ""}`}
              style={active === i ? { background: s.color } : undefined}
            />
          </button>
        ))}
      </nav>

      <Hero innerRef={heroRef} />

      {STATIONS.map((s, i) => (
        <section
          key={s.id}
          className="walk-sec"
          ref={(el) => {
            sectionRefs.current[i] = el;
          }}
          aria-labelledby={`st-${s.id}`}
        >
          {/* tabIndex on the scroll container: without it a keyboard
              user cannot scroll an overflowing card at all (WCAG 2.1.1),
              and the Gooni card overflows by design. */}
          <div className="walk-col" tabIndex={0} style={{ color: s.color }}>
            <StationBody station={s} />
          </div>
        </section>
      ))}

      <Footer innerRef={footerRef} />
    </div>
  );
}

// Small "view cv" link — lives at the top-right of each card, scrolling with
// it. Notebook icon matches the plaza pill.
function CvLink() {
  return (
    <a className="walk-cv" href="/public/cv">
      <span className="ic">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
          <rect x="3.5" y="2" width="9" height="12" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
          <path d="M3.5 5h9M3.5 8h6M3.5 11h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </span>
      view cv
      <span aria-hidden style={{ marginLeft: 1 }}>↗</span>
    </a>
  );
}

function StationBody({ station: s }: { station: Station }) {
  return (
    <>
      <div className="walk-eyebrow" style={{ color: s.color }}>
        {s.eyebrow}
      </div>
      <h2 id={`st-${s.id}`} style={{ fontSize: 34, color: "var(--w-ink)" }}>
        {s.title}
      </h2>
      {s.meta && <div className="walk-meta">{s.meta}</div>}

      {/* Project links up here (under the title), small — for long cards the
          old bottom placement scrolled out of sight. */}
      {s.links && (
        <div className="walk-links" style={{ marginTop: 12 }}>
          {s.links.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">
              {l.label} ↗
            </a>
          ))}
        </div>
      )}

      <div className="walk-body">
        {s.body.map((p) => (
          <p key={p.slice(0, 32)}>{p}</p>
        ))}
      </div>

      {s.image &&
        (s.imageAfter ? (
          <div className="walk-shots">
            <figure className="walk-figure">
              <img className="walk-shot" src={s.image} alt={s.imageAlt ?? ""} loading="lazy" />
              <figcaption className="walk-caption">the log — sifted by hand</figcaption>
            </figure>
            <div className="walk-arrow" aria-hidden>
              ↓
            </div>
            <figure className="walk-figure">
              <img className="walk-shot" src={s.imageAfter} alt={s.imageAfterAlt ?? ""} loading="lazy" />
              <figcaption className="walk-caption">the script — under a minute</figcaption>
            </figure>
          </div>
        ) : (
          <img className="walk-shot" src={s.image} alt={s.imageAlt ?? ""} loading="lazy" />
        ))}

      {s.beats && (
        <ul className="walk-beats">
          {s.beats.map((b) => (
            <li key={b.text} className={b.cut ? "cut" : undefined}>
              {b.text}
              {b.why && <span className="walk-why">{b.why}</span>}
            </li>
          ))}
        </ul>
      )}

      {s.stats && (
        <div className="walk-stats">
          {s.stats.map((st) => (
            <div key={st.label}>
              <div className="n" style={{ color: s.color }}>
                {st.value}
              </div>
              <div className="l">{st.label}</div>
            </div>
          ))}
        </div>
      )}

      {s.pull && (
        <p className="walk-pull" style={{ color: s.color }}>
          {s.pull}
        </p>
      )}
    </>
  );
}

function Hero({ innerRef }: { innerRef?: Ref<HTMLElement> }) {
  return (
    <section ref={innerRef} className="walk-sec" style={{ minHeight: "100svh" }}>
      <div className="walk-col" style={{ color: "#4ADE80" }}>
        {/* view cv pinned to the corner so it never pushes the name down —
            the name reads tight to the top of the card. */}
        <div className="walk-cvrow">
          <CvLink />
        </div>
        <h1 style={{ fontSize: "clamp(40px,6.5vw,60px)", lineHeight: 1.02, color: "var(--w-ink)" }}>
          Daniel G.
        </h1>
        <div className="walk-meta" style={{ marginTop: 14 }}>
          Builder (SWE) · {PROFILE.location}
        </div>
        <div className="walk-body" style={{ marginTop: 4 }}>
          <p style={{ fontSize: 17 }}>{PROFILE.thesis}</p>
        </div>
        {/* Link buttons removed — the floor tiles (view cv / résumé / linkedin
            / github) carry them now. */}

        {/* Scroll cue lives at the BOTTOM of the card (the floating version was
            cut off below the fold). "scroll or press" + two floating arrow
            keycaps that bob. Keys are light so they read on the dark card. */}
        <div className="walk-scrollcue" aria-hidden>
          <span className="wsc-label">scroll or press</span>
          <span className="wsc-keys">
            <kbd className="wsc-key">↑</kbd>
            <kbd className="wsc-key">↓</kbd>
          </span>
        </div>
      </div>
    </section>
  );
}

function Footer({ innerRef }: { innerRef?: Ref<HTMLElement> }) {
  return (
    <footer
      ref={innerRef}
      style={{
        position: "relative",
        zIndex: 1,
        padding: "60px max(40px,7vw) 90px",
        borderTop: "1px solid var(--w-line)",
        color: "var(--w-dim)",
        fontSize: 13,
      }}
    >
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
        <a href="/public/notes" style={{ color: "inherit" }}>
          Writing
        </a>
        <a href={PROFILE.resumeHref} style={{ color: "inherit" }} target="_blank" rel="noopener noreferrer">
          Résumé
        </a>
        {PROFILE.links.map((l) => (
          <a key={l.href} href={l.href} style={{ color: "inherit" }} target="_blank" rel="noopener noreferrer">
            {l.label}
          </a>
        ))}
      </div>
    </footer>
  );
}

// Fixed top-right cluster: back-to-plaza, view CV, restart-the-walk, and the
// music/SFX mute. The synth music (same bossa loop as the plaza) + the hop
// SFX only start once the reader has interacted (browsers gate AudioContext
// on a user gesture), so `entered` flips on the first wheel/key/pointer.
function WalkControls() {
  const navigate = useNavigate();
  const [muted, setMuted] = useState(false);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (entered) return;
    const wake = () => setEntered(true);
    const opts: AddEventListenerOptions = { once: true, passive: true };
    window.addEventListener("wheel", wake, opts);
    window.addEventListener("keydown", wake, opts);
    window.addEventListener("pointerdown", wake, opts);
    window.addEventListener("touchstart", wake, opts);
    return () => {
      window.removeEventListener("wheel", wake);
      window.removeEventListener("keydown", wake);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("touchstart", wake);
    };
  }, [entered]);

  // One mute governs both the music (AmbientAudio) and the hop SFX.
  useEffect(() => {
    setSfxMuted(muted);
  }, [muted]);

  return (
    <>
      {entered && <AmbientAudio muted={muted} />}
      <div style={{ position: "fixed", top: 18, right: 18, zIndex: 70, display: "flex", gap: 10 }}>
        <CtrlButton label="Back to the plaza" onClick={() => navigate({ to: "/public" })}>
          <Home size={17} strokeWidth={1.8} />
        </CtrlButton>
        <CtrlButton label="View CV" onClick={() => navigate({ to: "/public/cv" })}>
          <FileText size={17} strokeWidth={1.8} />
        </CtrlButton>
        <CtrlButton label="Restart the walk" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
          <Footprints size={17} strokeWidth={1.8} />
        </CtrlButton>
        <CtrlButton label={muted ? "Unmute" : "Mute"} onClick={() => setMuted((m) => !m)}>
          {muted ? <VolumeX size={17} strokeWidth={1.8} /> : <Volume2 size={17} strokeWidth={1.8} />}
        </CtrlButton>
      </div>
    </>
  );
}

