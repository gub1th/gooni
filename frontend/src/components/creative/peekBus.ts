import type { PublicNote } from "../../services/api";

// Tiny pub/sub for the bottom note-peek card. NoteCoins lives inside
// the R3F Canvas tree, so it can't safely render DOM via
// react-dom.createPortal — R3F's reconciler processes portal children
// as JSX intrinsics and trips on <span>/<div> ("not part of THREE
// namespace"). Solution: peek state lives here, NoteCoins publishes,
// and a <NotePeekHost> sibling of <Canvas> renders the actual card in
// real DOM land.

export type PeekState = {
  note: PublicNote | null;
  onExpand: (note: PublicNote) => void;
  onDismiss: () => void;
};

const NOOP = () => {};

let state: PeekState = {
  note: null,
  onExpand: NOOP,
  onDismiss: NOOP,
};

type Listener = (s: PeekState) => void;
const listeners = new Set<Listener>();

export function setPeekState(next: Partial<PeekState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l(state));
}

export function getPeekState(): PeekState {
  return state;
}

export function subscribePeek(fn: Listener): () => void {
  listeners.add(fn);
  fn(state);
  return () => {
    listeners.delete(fn);
  };
}
