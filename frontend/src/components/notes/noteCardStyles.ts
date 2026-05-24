/**
 * Shared CSS for the NoteCard block node + TextColor mark. Imported by BOTH
 * the editor (NoteEditor.tsx) and the public read view (routes/public.$noteId.tsx)
 * so the rendered HTML looks identical regardless of surface.
 *
 * One injection point — dedup via data-attr on the style tag so calling
 * useNoteCardStyles() in multiple components only mounts ONE <style>.
 *
 * On the public view the check stays VISIBLE (it conveys checked state) but
 * non-interactive — viewers can't toggle, so we kill the pointer cursor.
 */
import { useEffect } from "react";

const STYLE_ATTR = "data-gooni-note-card-styles";

const SHARED_CSS = `
  /* === NoteCard block panel =============================================
     Full-width Confluence-style callout. Wraps 1+ block children. Flex row:
     check column (left, vertically centered) + content column. */
  .gooni-note-card {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    box-sizing: border-box;
    padding: 14px 16px;
    margin: 12px 0;
    border-radius: 9px;
    position: relative;
    transition: background 0.15s, opacity 0.15s;
  }
  .gooni-note-card-blue {
    background: rgba(186, 230, 253, 0.45);
    box-shadow: inset 0 0 0 1px rgba(56, 189, 248, 0.28);
  }
  .gooni-note-card-pink {
    background: rgba(251, 207, 232, 0.45);
    box-shadow: inset 0 0 0 1px rgba(244, 114, 182, 0.28);
  }

  .gooni-note-card-content {
    flex: 1 1 auto;
    min-width: 0;
  }
  /* Collapse outer margins of wrapped blocks so the panel padding owns the
     spacing — otherwise a leading <p> margin pushes text off-center. */
  .gooni-note-card-content > :first-child { margin-top: 0; }
  .gooni-note-card-content > :last-child { margin-bottom: 0; }

  .gooni-note-card-checked .gooni-note-card-content {
    opacity: 0.5;
    text-decoration: line-through;
  }

  /* Check affordance — real DOM child (not a CSS pseudo) so the click
     delegate can target it. Always visible (it's the primary affordance now),
     left column, vertically centered by the parent flex align-items. */
  .gooni-note-card-check {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 700;
    line-height: 1;
    background: #fff;
    color: #cbd5e1;
    box-shadow: inset 0 0 0 1.5px #cbd5e1;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    transition: background 0.12s ease, color 0.12s ease, box-shadow 0.12s ease, transform 0.12s ease;
  }
  .gooni-note-card-check:hover {
    color: #16A34A;
    box-shadow: inset 0 0 0 1.5px #16A34A;
    transform: scale(1.08);
  }
  .gooni-note-card-checked .gooni-note-card-check {
    background: #16A34A;
    color: #fff;
    box-shadow: none;
  }

  /* === Public-view override =============================================
     Keep the check visible (conveys checked state) but non-interactive. */
  [data-public-view] .gooni-note-card-check {
    cursor: default;
    pointer-events: none;
  }
  [data-public-view] .gooni-note-card-check:hover {
    transform: none;
  }
`;

export function useNoteCardStyles() {
  useEffect(() => {
    let style = document.querySelector<HTMLStyleElement>(`style[${STYLE_ATTR}]`);
    if (style) return;
    style = document.createElement("style");
    style.setAttribute(STYLE_ATTR, "true");
    style.textContent = SHARED_CSS;
    document.head.appendChild(style);
    // Don't unmount on cleanup — shared across surfaces; dedup via data-attr.
  }, []);
}
