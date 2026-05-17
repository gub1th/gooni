import { useEffect, useState } from "react";
import { NotePeekCard } from "./NotePeekCard";
import { subscribePeek, type PeekState } from "./peekBus";

// Renders the bottom peek bar in real DOM, outside the R3F Canvas.
// Subscribes to the peek bus so NoteCoins (inside Canvas) can drive
// it without ever calling createPortal from within an R3F subtree —
// which is what triggered the
//   "R3F: Span is not part of the THREE namespace"
// crash on landing.
export function NotePeekHost() {
  const [state, setState] = useState<PeekState | null>(null);
  useEffect(() => subscribePeek(setState), []);
  if (!state) return null;
  return (
    <NotePeekCard
      note={state.note}
      onExpand={state.onExpand}
      onDismiss={state.onDismiss}
    />
  );
}
