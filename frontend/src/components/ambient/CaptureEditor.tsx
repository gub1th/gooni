import type { Editor } from "@tiptap/react";
import { FONT } from "../../ui";
import { NoteEditor } from "../notes/NoteEditor";
import { ink, surf } from "./ambientInk";
import type { ApiNote } from "../../services/api";

// THE capture box, grown into a note editor.
//
// It is deliberately the SAME object as the box, not a second surface summoned
// over it: same centre, same frost, same stroke around it (the wave's line eases
// out to this rect — see MorphLine). Expanding is the box getting bigger, which
// is why there is no card, no shadow and no header bar. A panel that faded in
// somewhere else would read as leaving the home, and leaving the home is the
// thing this whole pass exists to stop.
//
// What it holds is the app's REAL note editor (`NoteEditor variant="ambient"`),
// not a lookalike: slash menu, markdown shortcuts, task lists, paste-a-URL
// cards, image drop. A second editor built to "match the style" would drift from
// the first one within a release.
//
// MOUNTED ONCE, then kept — collapsing hides it rather than unmounting it, so an
// unfinished draft survives a stray Escape and is still there when you reopen.

const COLLAPSE_MS = 260;

export function CaptureEditor({
  open,
  mounted,
  left,
  top,
  width,
  height,
  radius,
  initialContent,
  onReady,
  onEscape,
  onSubmitted,
}: {
  open: boolean;
  /** false until the editor has been opened once — TipTap costs too much to mount on the home's first paint */
  mounted: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
  /** the capture box's text at first open; later openings are re-seeded through the handle */
  initialContent: string;
  onReady: (editor: Editor | null) => void;
  onEscape: () => void;
  onSubmitted: (note: ApiNote | null) => void;
}) {
  if (!mounted) return null;

  return (
    <div
      data-capture-editor
      aria-hidden={!open}
      style={{
        position: "absolute",
        left, top, width, height,
        zIndex: 2,
        boxSizing: "border-box",
        borderRadius: radius,
        overflow: "hidden",
        // Denser frost than the box's, because this one covers the list rather
        // than floating above it: at the box's 52% the dimmed TODAY read
        // straight through the writing surface. The two crossfade during the
        // morph, so the step up never reads as a change of material.
        background: surf(0.95),
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        // No border, no shadow: the wave's stroke IS this panel's outline, and
        // the no-bloom rule covers everything on this surface.
        opacity: open ? 1 : 0,
        pointerEvents: open ? "auto" : "none",
        // Held out of the tab order and off the compositor while collapsed —
        // `opacity: 0` alone leaves a full note editor focusable behind the home.
        visibility: open ? "visible" : "hidden",
        transition: [
          `opacity ${open ? 200 : COLLAPSE_MS}ms ease`,
          // The geometry eases on the same curve the stroke does, so the panel
          // edge and the line arrive together.
          "left 300ms cubic-bezier(0.22, 0.61, 0.36, 1)",
          "top 300ms cubic-bezier(0.22, 0.61, 0.36, 1)",
          "width 300ms cubic-bezier(0.22, 0.61, 0.36, 1)",
          "height 300ms cubic-bezier(0.22, 0.61, 0.36, 1)",
          `visibility 0s linear ${open ? 0 : COLLAPSE_MS}ms`,
        ].join(", "),
      }}
    >
      <NoteEditor
        variant="ambient"
        initialContent={initialContent}
        onReady={onReady}
        onEscape={onEscape}
        onSubmitted={(note) => onSubmitted(note)}
      />

      {/* The two exits, stated once. Quiet enough to ignore, present enough to
          learn — the box's own `⌘↵ note` hint was the same bargain. */}
      <div
        style={{
          position: "absolute", left: 26, bottom: 18, pointerEvents: "none",
          fontFamily: FONT, fontSize: 10.5, letterSpacing: 0.3, color: ink(0.3),
        }}
      >
        ⌘↵ save · esc collapse
      </div>
    </div>
  );
}
