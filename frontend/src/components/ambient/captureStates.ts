// The capture surface has three states, and the ONE thing they disagree about
// is how much of the home you can still see behind them.
//
// It used to be two states and the second one was `opacity: 0`: clicking to
// type took TODAY, the activity line and the proactive remark off the screen
// entirely, so the ambient context vanished at exactly the moment you were
// trying to capture something into it — a box floating alone on the void. The
// home is the reason the thought is worth having; it stays.
//
// Dimming instead of hiding is also what makes the two steps legible. Ambient →
// input is a small step back (you can still read the day); input → editor is a
// bigger one (the editor is now the subject). A single "hidden" state can't say
// which of the two you are in.
//
// Pure + separate so the ladder is assertable — the invariant that matters is
// that NOTHING but a covering surface ever takes the home to zero.

export type CaptureState = "ambient" | "input" | "editor";

/** Home visibility per state. Not the dim AMOUNT — the opacity that remains. */
export const HOME_OPACITY: Record<CaptureState, number> = {
  ambient: 1,
  /** ~30% dimmed — the day is still readable while you type at it. */
  input: 0.7,
  /** ~60% dimmed — present, but plainly behind the thing you are writing. */
  editor: 0.4,
};

export function captureState(opts: { boxOpen: boolean; editorOpen: boolean }): CaptureState {
  if (opts.editorOpen) return "editor";
  if (opts.boxOpen) return "input";
  return "ambient";
}

/**
 * What the home's own layers (the stage, the stickies, the limbo lane) render at.
 *
 * `covered` is the only zero: a surface panel, the log matrix, a note peek or
 * the tap-to-wake veil OWNS the screen, and the home standing down under it is
 * a different rule with a different reason (it is not visible in any sense, so
 * leaving it at 0.4 would just be paint under an opaque sheet).
 */
export function homeOpacity(state: CaptureState, covered: boolean): number {
  return covered ? 0 : HOME_OPACITY[state];
}

/**
 * Is the home still INTERACTIVE? Only when nothing is being captured.
 *
 * A dimmed home reads as backdrop, and a backdrop that answers clicks is a trap:
 * reaching past the composer to tick a task would blur the box mid-thought, and
 * with a task row it would silently start a focus session. Clicks land on the
 * void instead, which is what already dismisses an empty box.
 */
export function homeInteractive(state: CaptureState, covered: boolean): boolean {
  return !covered && state === "ambient";
}
