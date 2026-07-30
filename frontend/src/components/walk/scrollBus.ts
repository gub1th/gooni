// Scroll progress, module-level.
//
// The 3D scene reads this every frame inside useFrame. Putting it in
// React state instead would re-render the whole Canvas subtree on every
// scroll event, which is exactly the wrong trade for a 60fps camera
// rig — so progress lives here and the scene samples it.

export type ScrollState = {
  /** 0 at the top of the document, 1 at the bottom. */
  progress: number;
  /** Index of the station currently nearest the viewport centre. */
  station: number;
  /** Pixels/frame, smoothed — drives walk-vs-idle animation. */
  velocity: number;
  /** Continuous station-space position of the reader: exactly `i` when
   *  station `i`'s section is centred, interpolating between. Negative in
   *  the hero, > last-index at the footer. This — not `progress` — is
   *  what places the walker + camera, so a poster fixed at station `i`'s
   *  Z is framed precisely when its card is the one being read. `progress`
   *  (whole-document) never lined up with the per-section anchors, which
   *  is why the framed poster used to lag the active card by a station. */
  walkPos: number;
  /** Set once the reader over-scrolls past the end: the walker drops off
   *  the edge of the world and the page loops back to the plaza, mirroring
   *  the plaza's jump-in. The 3D Walker reads this to play the fall. */
  falling: boolean;
};

const state: ScrollState = { progress: 0, station: 0, velocity: 0, walkPos: 0, falling: false };

export function setScroll(next: Partial<ScrollState>) {
  if (next.progress !== undefined) state.progress = next.progress;
  if (next.station !== undefined) state.station = next.station;
  if (next.velocity !== undefined) state.velocity = next.velocity;
  if (next.walkPos !== undefined) state.walkPos = next.walkPos;
  if (next.falling !== undefined) state.falling = next.falling;
}

export function getScroll(): ScrollState {
  return state;
}
