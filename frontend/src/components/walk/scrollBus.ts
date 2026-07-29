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
};

const state: ScrollState = { progress: 0, station: 0, velocity: 0 };

export function setScroll(next: Partial<ScrollState>) {
  if (next.progress !== undefined) state.progress = next.progress;
  if (next.station !== undefined) state.station = next.station;
  if (next.velocity !== undefined) state.velocity = next.velocity;
}

export function getScroll(): ScrollState {
  return state;
}
