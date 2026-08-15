import { useEffect, useState } from "react";
import { z } from "../../ui";
import { ink } from "../ambient/ambientInk";
import { RAIL_LANE } from "../ambient/IconRail";

// A non-home surface is a PANEL THAT SLIDES IN over a home that stays put —
// not a window dropped on a void.
//
// Every non-home surface used to render inside `sheetFrame`: its own margin,
// radius, border and drop shadow. That is one root cause behind four
// complaints — surfaces reading as "a page on a page", the app reading as a
// mix of light and dark, the notes sidebar looking unaffected by anything
// around it, and chrome behaving differently per surface.
//
// MOTION IS DOING REAL WORK. A panel that arrives from an edge has an origin,
// so it reads as a layer belonging to the app; a framed sheet that fades in has
// no origin, so it reads as pasted on top. Short and physical, not decorative.
//
// It deliberately has no margin, no radius and no shadow: it is anchored to the
// right and bottom edges of the viewport, which is what makes it a layer rather
// than a floating window. The left edge stops clear of the rail lane so the
// rail is never covered and behaves identically on every surface.

const SLIDE_MS = 260;

// THE PANEL IS MOUNTED FOR THE WHOLE SESSION, open or shut. That is what makes
// the motion real: a node that mounts already at `translateX(0)` has no
// starting frame to animate FROM, so the first version of this — mounted by the
// route switch, on demand — snapped into place and snapped out, which is the
// same no-origin arrival `sheetFrame` gave us. Living permanently in AppShell,
// it sits parked off the right edge and every open is a transition from a
// position it is already in.
//
// The one deliberate exception is a COLD LOAD straight onto a surface URL:
// there the first paint has `open` already true, so nothing slides. Arriving at
// a URL is not a navigation within the app, and animating it would be a lie
// about where you came from.
export function SurfacePanel({
  open,
  onDismiss,
  children,
}: {
  open: boolean;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  // Trails `open` by the length of the slide so the exit gets to play. It
  // drives VISIBILITY only — a parked panel must be out of the a11y tree and
  // untabbable, which `translateX(100%)` alone does not do.
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) { setPresent(true); return; }
    const t = window.setTimeout(() => setPresent(false), SLIDE_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  return (
    // THE CLIP BOX. It occupies exactly the panel's slot and never moves, so
    // nothing this component owns is ever geometry outside the viewport.
    //
    // The panel used to BE this element and park itself at `translateX(100%)`
    // when closed — a fixed box the width of the viewport, translated a full
    // viewport to the right. That is the classic phantom-horizontal-scrollbar
    // shape: whether it produces a real scrollbar depends on the engine, so it
    // was a latent bug on every surface rather than a Chrome-only one, and
    // `overflow-x: hidden` on the document would have hidden the symptom while
    // leaving a full-width box sitting off-screen. Clipping at the source is
    // the fix: the child may translate as far as it likes inside this.
    <div
      data-surface-clip
      style={{
        position: "fixed",
        left: RAIL_LANE,
        top: "calc(var(--gooni-bar-h, 0px) + var(--gooni-header-h, 0px))",
        right: 0,
        bottom: 0,
        zIndex: z.overlay - 20,
        overflow: "hidden",
        // a closed clip box must not swallow clicks meant for the home
        pointerEvents: open ? "auto" : "none",
        visibility: present || open ? "visible" : "hidden",
      }}
    >
    <div
      data-surface-panel
      data-open={open ? "" : undefined}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        minWidth: 0,
        overflow: "hidden",
        background: "var(--gooni-void, #000000)",
        transform: open ? "translateX(0)" : "translateX(100%)",
        transition: `transform ${SLIDE_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
        willChange: "transform",
        pointerEvents: open ? "auto" : "none",
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onDismiss();
        }
      }}
    >
      {/* THE LEFT EDGE READS AS A LAYER, NOT A SEAM.
          It used to be a 1px hairline between two surfaces painting the SAME
          void colour, and a line with identical ground either side reads as a
          crack in one surface rather than the boundary of two. A short
          gradient falloff gives the edge depth instead — not a drop shadow,
          which the 2026-08-02 pass ruled out, but light catching a lifted
          edge. Non-interactive so it cannot intercept the content beneath. */}
      <div
        aria-hidden
        style={{
          position: "absolute", left: 0, top: 0, bottom: 0, width: 20,
          pointerEvents: "none", zIndex: 1,
          background: `linear-gradient(to right, ${ink(0.09)}, ${ink(0.02)} 45%, transparent)`,
        }}
      />
      {children}
    </div>
    </div>
  );
}
