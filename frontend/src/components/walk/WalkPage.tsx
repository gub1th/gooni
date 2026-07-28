import { useEffect, useRef, useState } from "react";
import { STATIONS, type Station } from "../../content/walk";
import { PROFILE } from "../../content/portfolio";
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
  const [active, setActive] = useState(0);
  const sectionRefs = useRef<(HTMLElement | null)[]>([]);
  const lastY = useRef(0);
  const vel = useRef(0);

  // One rAF-throttled listener drives both the 3D rig and the active
  // station. Scroll fires far faster than paint; doing this work per
  // event would starve the render loop the scene depends on.
  useEffect(() => {
    let raf = 0;
    let queued = false;

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

      setScroll({ progress, station: nearest, velocity: vel.current });
      setActive((cur) => (cur === nearest ? cur : nearest));
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
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <div className="walk-root">
      <style>{`
        .walk-root {
          --w-ink: #F2EFE8;
          --w-ink2: rgba(242,239,232,0.70);
          --w-dim: rgba(242,239,232,0.44);
          --w-panel: rgba(14,17,20,0.62);
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
        .walk-sec { position:relative; z-index:1; min-height:100svh;
          display:flex; align-items:center; padding:14vh 0; }
        .walk-col { width:min(520px, calc(100vw - 48px)); margin-left:max(40px, 7vw);
          background:var(--w-panel); backdrop-filter:blur(18px) saturate(150%);
          -webkit-backdrop-filter:blur(18px) saturate(150%);
          border:1px solid var(--w-line); border-radius:18px; padding:32px 34px; }
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
        .walk-beats { list-style:none; margin:22px 0 0; padding:0; }
        .walk-beats li { position:relative; padding:9px 0 9px 24px; font-size:14.5px;
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
        .walk-shot { width:100%; border-radius:12px; border:1px solid var(--w-line);
          margin-top:22px; display:block; }
        .walk-rail { position:fixed; right:26px; top:50%; transform:translateY(-50%);
          z-index:3; display:flex; flex-direction:column; gap:14px; }
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
          .walk-col { margin-left:0; margin-right:0; width:100%; }
          .walk-sec { padding:10vh 20px; min-height:auto; } }
        @media (prefers-reduced-motion: reduce) { * { scroll-behavior:auto !important; } }
      `}</style>

      {webgl && <WalkScene />}

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

      <Hero />

      {STATIONS.map((s, i) => (
        <section
          key={s.id}
          className="walk-sec"
          ref={(el) => {
            sectionRefs.current[i] = el;
          }}
          aria-labelledby={`st-${s.id}`}
        >
          <div className="walk-col" style={{ color: s.color }}>
            <StationBody station={s} />
          </div>
        </section>
      ))}

      <Footer />
    </div>
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

      <div className="walk-body">
        {s.body.map((p) => (
          <p key={p.slice(0, 32)}>{p}</p>
        ))}
      </div>

      {s.image && (
        <img className="walk-shot" src={s.image} alt={s.imageAlt ?? ""} loading="lazy" />
      )}

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

      {s.links && (
        <div className="walk-links">
          {s.links.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">
              {l.label} ↗
            </a>
          ))}
        </div>
      )}
    </>
  );
}

function Hero() {
  return (
    <section className="walk-sec" style={{ minHeight: "100svh" }}>
      <div className="walk-col" style={{ color: "#4ADE80" }}>
        <h1 style={{ fontSize: "clamp(40px,6.5vw,60px)", lineHeight: 1.02, color: "var(--w-ink)" }}>
          {PROFILE.name}
        </h1>
        <div className="walk-meta" style={{ marginTop: 14 }}>
          {PROFILE.role} · {PROFILE.location}
        </div>
        <div className="walk-body" style={{ marginTop: 4 }}>
          <p style={{ fontSize: 17 }}>{PROFILE.thesis}</p>
        </div>
        <div className="walk-links">
          <a href={PROFILE.resumeHref} target="_blank" rel="noopener noreferrer">
            Résumé ↗
          </a>
          {PROFILE.links.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">
              {l.label} ↗
            </a>
          ))}
        </div>
        <p
          style={{
            fontFamily: MONO,
            fontSize: 11,
            letterSpacing: ".1em",
            color: "var(--w-dim)",
            marginTop: 30,
            marginBottom: 0,
          }}
        >
          SCROLL — THE ONLY DIRECTION IS FORWARD
        </p>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer
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
        <a href="/public" style={{ color: "inherit" }}>
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
