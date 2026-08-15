/**
 * The invariant this whole pass exists for: capturing DIMS the home, it never
 * deletes it.
 *
 * Before, the capture box set the stage's opacity to 0 — click to type and
 * TODAY, the activity line and the proactive remark were gone, so the ambient
 * context vanished at exactly the moment you were trying to capture something
 * into it. A regression here is invisible in a screenshot diff (the box looks
 * the same either way) and only shows up as "the home went black again", so the
 * ladder is asserted rather than eyeballed.
 */
import { describe, expect, test } from "vitest";
import { captureState, homeInteractive, homeOpacity, HOME_OPACITY } from "./captureStates";

describe("captureState", () => {
  test("the editor outranks the box, which outranks the resting home", () => {
    expect(captureState({ boxOpen: false, editorOpen: false })).toBe("ambient");
    expect(captureState({ boxOpen: true, editorOpen: false })).toBe("input");
    expect(captureState({ boxOpen: true, editorOpen: true })).toBe("editor");
    // The editor opens the box with it, but must not depend on that to win.
    expect(captureState({ boxOpen: false, editorOpen: true })).toBe("editor");
  });
});

describe("homeOpacity", () => {
  test("NOTHING about capturing takes the home to zero", () => {
    for (const state of ["ambient", "input", "editor"] as const) {
      expect(homeOpacity(state, false)).toBeGreaterThan(0);
    }
  });

  test("each step back is a real one — the two states never look alike", () => {
    expect(homeOpacity("ambient", false)).toBe(1);
    expect(homeOpacity("input", false)).toBeLessThan(homeOpacity("ambient", false));
    expect(homeOpacity("editor", false)).toBeLessThan(homeOpacity("input", false));
    // ~30% then ~60% dimmed, per the brief. Pinned as values because "dimmer"
    // alone would pass at 0.99 / 0.98, which reads as no step at all.
    expect(HOME_OPACITY.input).toBeCloseTo(0.7);
    expect(HOME_OPACITY.editor).toBeCloseTo(0.4);
  });

  test("a covering surface is the ONE zero", () => {
    // A panel, the log matrix, a note peek or the wake veil owns the screen —
    // the home standing down under it is a different rule with a different
    // reason, and painting it at 0.4 under an opaque sheet is just cost.
    for (const state of ["ambient", "input", "editor"] as const) {
      expect(homeOpacity(state, true)).toBe(0);
    }
  });
});

describe("homeInteractive", () => {
  test("a dimmed home is a backdrop, not a control surface", () => {
    // Reaching past the composer to tick a task would blur the box mid-thought,
    // and on a task row would silently start a focus session.
    expect(homeInteractive("ambient", false)).toBe(true);
    expect(homeInteractive("input", false)).toBe(false);
    expect(homeInteractive("editor", false)).toBe(false);
    expect(homeInteractive("ambient", true)).toBe(false);
  });
});
