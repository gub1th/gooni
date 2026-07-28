import type { Landmark } from "./landmarkPlacement";

// Same trick as peekBus: <Landmarks> lives inside the R3F Canvas tree,
// so it can't render DOM (R3F's reconciler treats portal children as
// THREE intrinsics and throws on <div>). Landmark peek state lives here;
// <LandmarkPeekHost>, a sibling of <Canvas>, renders the real card.
//
// Kept separate from peekBus rather than generalised: a note peek and a
// landmark peek can both be live at once (you can stand on a coin tile
// next to a monument), and collapsing them into one slot would make
// them fight over it.

export type LandmarkPeekState = {
  /** Landmark the player is standing on — drives the bottom peek bar. */
  active: Landmark | null;
  /** Landmark opened into the full card. */
  expanded: Landmark | null;
  onExpand: (l: Landmark) => void;
  onDismiss: () => void;
  onClose: () => void;
};

const NOOP = () => {};

let state: LandmarkPeekState = {
  active: null,
  expanded: null,
  onExpand: NOOP,
  onDismiss: NOOP,
  onClose: NOOP,
};

type Listener = (s: LandmarkPeekState) => void;
const listeners = new Set<Listener>();

export function setLandmarkState(next: Partial<LandmarkPeekState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l(state));
}

export function getLandmarkState(): LandmarkPeekState {
  return state;
}

export function subscribeLandmark(fn: Listener): () => void {
  listeners.add(fn);
  fn(state);
  return () => {
    listeners.delete(fn);
  };
}
