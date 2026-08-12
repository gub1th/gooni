import { useEffect, useState } from "react";
import { z } from "../../ui";
import { ink } from "../ambient/ambientInk";

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

export function SurfacePanel({
  open,
  onDismiss,
  children,
}: {
  open: boolean;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  // Kept mounted for the length of the slide-out so the exit has an origin
  // too — unmounting on `open=false` would make dismissal a disappearance.
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) { setPresent(true); return; }
    const t = window.setTimeout(() => setPresent(false), SLIDE_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!present && !open) return null;

  return (
    <div
      data-surface-panel
      style={{
        position: "fixed",
        // clears the rail lane and the session band, both of which stay put
        left: 68,
        top: "var(--gooni-bar-h, 0px)",
        right: 0,
        bottom: 0,
        zIndex: z.overlay - 20,
        display: "flex",
        minWidth: 0,
        overflow: "hidden",
        background: "var(--gooni-void, #000000)",
        borderLeft: `1px solid ${ink(0.08)}`,
        transform: open ? "translateX(0)" : "translateX(100%)",
        transition: `transform ${SLIDE_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
        willChange: "transform",
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onDismiss();
        }
      }}
    >
      {children}
    </div>
  );
}
