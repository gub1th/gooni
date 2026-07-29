import type { FocusPalette } from "./focusPalette";

// Gooni asleep at the desk — the resting state, and therefore ~90% of what this
// display ever shows.
//
// Deliberately 2D SVG + CSS, not the 3D GLTF character: this paints 24/7 on a
// monitor that never turns off. A WebGL canvas running all night means constant
// GPU draw, audible fans in the room, and a context that has to survive days
// without leaking. A breathing SVG costs approximately nothing and can idle at
// a frame every few seconds.
//
// Burn-in is the other constraint an always-on screen brings: nothing here is a
// static bright shape. The whole figure drifts slowly, the palette is low
// contrast, and `deep` (away from home) dims it further still.

export function GooniAsleep({
  pal,
  deep = false,
  stirring = false,
}: {
  pal: FocusPalette;
  // Away from home — dimmest, slowest, least motion.
  deep?: boolean;
  // Waking: he's lifting his head. A brief in-between beat, not a state.
  stirring?: boolean;
}) {
  const opacity = deep ? 0.26 : 0.62;
  const breath = deep ? "11s" : "7s";

  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <style>{KEYFRAMES}</style>
      <svg
        width="420"
        height="260"
        viewBox="0 0 420 260"
        fill="none"
        style={{
          opacity,
          // Drift is the burn-in mitigation: the same pixels are never lit for
          // more than a few minutes at a time.
          animation: `gooni-drift 190s ease-in-out infinite`,
          transition: "opacity 1200ms ease",
        }}
      >
        <g
          style={{
            transformOrigin: "210px 200px",
            animation: `gooni-breathe ${breath} ease-in-out infinite`,
          }}
        >
          {/* head — resting on the desk, or lifted when stirring */}
          <g
            style={{
              transformOrigin: "210px 175px",
              transform: stirring ? "translateY(-26px) rotate(-4deg)" : "none",
              transition: "transform 900ms cubic-bezier(.2,.7,.3,1)",
            }}
          >
            <circle cx="210" cy="163" r="34" stroke={pal.ink2} strokeWidth="2.5" fill="none" />
            {/* closed eyes — two soft arcs. Open a slit when stirring. */}
            {stirring ? (
              <>
                <circle cx="198" cy="160" r="2.6" fill={pal.ink2} />
                <circle cx="222" cy="160" r="2.6" fill={pal.ink2} />
              </>
            ) : (
              <>
                <path d="M191 162 q7 5 14 0" stroke={pal.ink2} strokeWidth="2.2" strokeLinecap="round" />
                <path d="M215 162 q7 5 14 0" stroke={pal.ink2} strokeWidth="2.2" strokeLinecap="round" />
              </>
            )}
          </g>

          {/* arm folded under the head */}
          <path
            d="M150 196 q60 -18 120 0"
            stroke={pal.ink2}
            strokeWidth="2.5"
            strokeLinecap="round"
            fill="none"
          />
          {/* the desk */}
          <path d="M60 199 H360" stroke={pal.ink3} strokeWidth="2" strokeLinecap="round" />
        </g>

        {/* sleep marks — the only literal "he's asleep" signal. Gone the moment
            he stirs, so waking reads instantly from across the room. */}
        {!stirring && !deep && (
          <g fill="none" stroke={pal.ink3} strokeWidth="2" strokeLinecap="round">
            <path d="M262 120 h13 l-13 15 h13" style={{ animation: "gooni-z 7s ease-in-out infinite" }} />
            <path
              d="M284 98 h10 l-10 12 h10"
              style={{ animation: "gooni-z 7s ease-in-out infinite", animationDelay: "1.1s" }}
            />
          </g>
        )}
      </svg>
    </div>
  );
}

// prefers-reduced-motion kills every loop — the figure still renders, it just
// holds still. An always-on ambient display is exactly the surface where
// respecting that setting matters.
const KEYFRAMES = `
@keyframes gooni-breathe {
  0%, 100% { transform: translateY(0) scaleY(1); }
  50%      { transform: translateY(2.5px) scaleY(0.992); }
}
@keyframes gooni-drift {
  0%, 100% { transform: translate(-14px, -8px); }
  33%      { transform: translate(12px, 6px); }
  66%      { transform: translate(6px, -11px); }
}
@keyframes gooni-z {
  0%, 100% { opacity: 0; transform: translateY(6px); }
  40%      { opacity: 0.75; transform: translateY(-4px); }
  70%      { opacity: 0; transform: translateY(-12px); }
}
@media (prefers-reduced-motion: reduce) {
  [style*="gooni-breathe"], [style*="gooni-drift"], [style*="gooni-z"] {
    animation: none !important;
  }
}
`;
