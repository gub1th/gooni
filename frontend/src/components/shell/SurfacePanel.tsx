import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { z } from "../../ui";
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
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
/** Parked off the right edge of the clip box. */
const PARKED = "translateX(100%)";
/** Filling the clip box. */
const SHOWN = "translateX(0)";

// WHY NOTES NEVER SLID, AND WHY FIVE FIXES MISSED IT (#488, #493, #498, #500,
// #507).
//
// The slide was never mis-specified. On the real navigation the animation ran to
// completion — `transitionrun` fired, `currentTime` advanced, and the computed
// matrix interpolated the full 1132px — while the panel's border box AND its
// painted pixels both sat at the settled position from the second frame onward.
// Freezing a live animation at a computed `translateX(934px)` and screenshotting
// showed a surface that had not moved by a pixel. So every previous pass looked
// at the CSS, found it correct, and shipped.
//
// The trigger is the notes Sidebar mounting as a new flex child in THE SAME
// COMMIT that starts the slide. Isolated afterwards, on the settled notes
// surface, the exact same call renders perfectly — a plain inline
// `translateX(300px)` moves it, and this `slide()` animates it smoothly. Only
// the first frame of a freshly-mounted subtree is affected, which is why
// memories/calendar/trackables (nothing new mounting beside them) always looked
// fine and notes never did.
//
// THE FIX IS THE ONE-FRAME DEFERRAL in `startSlide` below: paint the parked
// frame WITH the children already mounted, then begin the animation on the next
// frame. Nothing about the keyframes changed; only when they start.
//
// Two supporting changes keep it honest. The animation is WAAPI rather than a
// CSS transition, so it needs no inferred before-change style and cannot be
// silently skipped: it is handed both keyframes outright. And nothing writes
// `transform`/`transition` through the React style prop any more — React only
// writes a style property when its own previous prop differs, so an imperatively
// written transform can desync from what React believes is on the node. The
// layout effect below is the ONE owner.
function keyframesFor(from: string, to: string): Keyframe[] {
  return [{ transform: from }, { transform: to }];
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

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
  viewKey,
  onDismiss,
  children,
  fullBleed = false,
}: {
  open: boolean;
  // Identifies WHICH non-home surface is showing (e.g. "notes"/"memories").
  // `open` alone only tells us the panel is up — going from notes straight to
  // memories never flips `open` false→true, so the transform-driven slide
  // never replays and the two surfaces just swap content instantly. Watching
  // this key too is what makes a non-home→non-home nav slide in as well.
  viewKey: string;
  onDismiss: () => void;
  children: React.ReactNode;
  /** `/focus` renders its own IconRail and owns the whole viewport — the
   * ordinary clip box reserves the rail lane + header for the SHARED chrome,
   * which this surface doesn't render. */
  fullBleed?: boolean;
}) {
  // Trails `open` by the length of the slide so the exit gets to play. It
  // drives VISIBILITY only — a parked panel must be out of the a11y tree and
  // untabbable, which `translateX(100%)` alone does not do.
  // A CLOSING panel has to stay rendered for the whole slide OUT, plus a frame
  // of slack so the last one is not clipped by `visibility: hidden`.
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) { setPresent(true); return; }
    const t = window.setTimeout(() => setPresent(false), SLIDE_MS + 40);
    return () => window.clearTimeout(t);
  }, [open]);

  // THE ONE OWNER of the surface's transform — entrance, exit and the replay
  // when one surface is swapped for another while the panel stays open.
  //
  // THE TRANSFORM GOES ON THE CLIP BOX, NOT ON THE PANEL, and that is the fix
  // for the notes bug. On the panel — `position: absolute; inset: 0` inside the
  // clip — the transform stopped taking effect in the exact commit the surface's
  // own subtree mounted: measured on the real navigation, the computed matrix
  // held `translateX(609px)` while both the element's border box AND a
  // screenshot showed it settled at its final position, i.e. an animation that
  // existed only in the style system. It is reproducible for notes and never
  // happens for memories/calendar/trackables, which is why this read as "notes
  // is special" through #488, #493, #498, #500 and #507; and it is not the child
  // count (making the panel's children invariant changed nothing) nor
  // `will-change` (removing it changed nothing).
  //
  // The clip box — `position: fixed` — transforms correctly under the same
  // conditions, and moving it carries the panel and the whole surface with it.
  // Nothing is lost by translating the clipper itself: the panel exactly fills
  // it, so there is never any content to clip, and the box only ever travels
  // RIGHT of its resting position, so it cannot ride over the rail lane or the
  // header. The phantom-scrollbar shape the clip was introduced to avoid does
  // not come back either — a `position: fixed` box contributes nothing to the
  // document's scrollable overflow, which is exactly what the old parked panel
  // (an ABSOLUTE box) could not promise.
  const clipRef = useRef<HTMLDivElement>(null);
  const prevViewKey = useRef(viewKey);
  const prevOpen = useRef(open);
  const firstRun = useRef(true);
  const animRef = useRef<Animation | null>(null);
  const rafRef = useRef(0);

  useLayoutEffect(() => {
    const el = clipRef.current;
    if (!el) return;
    const wasOpen = prevOpen.current;
    const viewChanged = viewKey !== prevViewKey.current;
    const first = firstRun.current;
    prevViewKey.current = viewKey;
    prevOpen.current = open;
    firstRun.current = false;

    // Whatever was in flight loses; a slide that has been superseded must not
    // keep compositing over the one that replaced it.
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    animRef.current?.cancel();
    animRef.current = null;

    // A COLD LOAD straight onto a surface URL does not slide: arriving at a URL
    // is not a navigation within the app, and animating it would be a lie about
    // where you came from. The same goes for the home's own first paint.
    if (first) {
      el.style.transform = open ? SHOWN : PARKED;
      return;
    }

    // ENTRANCE from the right on every open AND on every surface swap; EXIT back
    // out to the right, UNCOVERING the home beneath (which is always mounted, so
    // this is a real reveal — see routes/index.tsx for the transform that must
    // never go back onto its wrapper).
    if (open && !wasOpen) startSlide(el, PARKED, SHOWN);
    else if (open && viewChanged) startSlide(el, PARKED, SHOWN);
    else if (!open) startSlide(el, SHOWN, PARKED);

    function startSlide(node: HTMLElement, from: string, to: string) {
      // Reduced motion, and jsdom (no `Element.animate`): land on the end state
      // with no animation at all.
      if (prefersReducedMotion() || typeof node.animate !== "function") {
        node.style.transform = to;
        return;
      }
      // THE ONE-FRAME DEFERRAL. `from` is already the element's current
      // transform, so writing it here is a no-op that simply guarantees the
      // parked frame is what paints in THIS commit — the commit that also mounts
      // the surface's own subtree. Starting the animation in that same frame is
      // what silently cost notes its slide.
      node.style.transform = from;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        // Resting state, so the element is correct once `fill: "none"` stops the
        // animation contributing. Set before `animate` so there is never a frame
        // where neither is driving the transform.
        node.style.transform = to;
        animRef.current = node.animate(
          keyframesFor(from, to),
          { duration: SLIDE_MS, easing: EASE, fill: "none" },
        );
      });
      // A backgrounded tab never runs rAF, so the slide simply waits and plays
      // when the tab comes back — deferred, never dropped, and nobody is looking
      // in the meantime.
    }
  }, [viewKey, open]);

  // A panel torn down mid-slide must not leave an animation running on a
  // detached node, nor a queued frame holding a reference to it.
  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    animRef.current?.cancel();
  }, []);

  return (
    // THE CLIP BOX, AND THE THING THAT SLIDES. It occupies exactly the panel's
    // slot at rest and travels right of it — never left — so it can never ride
    // over the rail lane or the header.
    //
    // It is `position: fixed`, which is what keeps the old phantom-scrollbar
    // shape away while it is parked a full width off-screen: a fixed box adds
    // nothing to the document's scrollable overflow. (The pre-clip version of
    // this component parked an ABSOLUTE box out there, which does, and which
    // `overflow-x: hidden` on the document would only have hidden.) `overflow:
    // hidden` stays on it as a belt: the panel exactly fills it, so there is
    // nothing to clip in the ordinary case, and it keeps a surface that
    // over-runs its box from painting outside it.
    <div
      ref={clipRef}
      data-surface-clip
      style={{
        position: "fixed",
        left: fullBleed ? 0 : RAIL_LANE,
        top: fullBleed ? 0 : "calc(var(--gooni-bar-h, 0px) + var(--gooni-header-h, 0px))",
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
        // NO `transform` and NO `transition` here on purpose — the layout
        // effect above owns both. React writes a style property only when its
        // own previous prop differs, so a value React thinks it set and a value
        // the effect actually wrote can drift apart silently; keeping the two
        // writers off the same property is what makes the slide deterministic.
        // The parked frame is written by the effect's `first` branch, which runs
        // before the first paint.
        //
        // No `will-change: transform` either. It was here as the usual "promote
        // the layer" reflex; it was tested as a suspect for the notes bug and is
        // NOT the cause (removing it changed nothing — the one-frame deferral is
        // the fix). It is left off because Chrome promotes an actively-animating
        // transform on its own, so the only thing a permanent hint buys on a
        // full-viewport panel is a compositor layer kept alive for the whole
        // session, on every surface, for 260ms of motion.
        pointerEvents: open ? "auto" : "none",
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onDismiss();
        }
      }}
    >
      {/* THE LEFT EDGE IS BARE. It carried a 20px ink gradient meant to read as
          light catching a lifted edge; on screen it read as a vertical shadow
          line hanging beside the icon rail — an artifact, not depth (captain
          review, 2026-08-15). Nothing replaces it: the rail is a floating
          frosted pill and the panel is a full-bleed surface, so the two are
          already distinct, and the seam the gradient was patching was the
          earlier 1px hairline, which is also gone. Do not put a border, shadow
          or gradient back here — the 2026-08-02 no-bloom rule covers this edge
          too. */}
      {children}
    </div>
    </div>
  );
}
