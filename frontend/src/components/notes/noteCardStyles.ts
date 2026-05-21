/**
 * Shared CSS for the NoteCard mark + TextColor mark. Imported by BOTH the
 * editor (NoteEditor.tsx) and the public read view (routes/public.$noteId.tsx)
 * so the rendered HTML looks identical regardless of surface.
 *
 * One injection point — dedup via data-attr on the style tag so calling
 * useNoteCardStyles() in multiple components only mounts ONE <style>.
 *
 * `interactive: true` (editor) wires the hover-show + click cursor.
 * `interactive: false` (public) hides the check affordance entirely so
 * read-only viewers don't see a clickable-looking icon they can't actually
 * toggle. Visual state (checked vs not) renders the same either way.
 */
import { useEffect } from "react";

const STYLE_ATTR = "data-gooni-note-card-styles";

const SHARED_CSS = `
  /* === NoteCard mark ====================================================
     Pastel inline highlight. Intentionally NOT box-decoration-break:clone
     — Daniel flagged that cloning rendered multi-line selections as N
     separate rounded pills (each looking like a distinct card with its
     own check). Default behavior extends the background continuously
     across line breaks: first line rounded-left + padding-left, last
     line rounded-right + padding-right, middle lines bleed edge-to-edge.
     Reads as ONE continuous card (Notion / Confluence behavior). */
  .gooni-note-card {
    padding: 1px 7px;
    border-radius: 7px;
    position: relative;
    transition: background 0.15s, color 0.15s, opacity 0.15s;
  }
  .gooni-note-card-blue {
    background: rgba(186, 230, 253, 0.55);
    color: #0C4A6E;
    box-shadow: inset 0 0 0 0.5px rgba(56, 189, 248, 0.30);
  }
  .gooni-note-card-pink {
    background: rgba(251, 207, 232, 0.55);
    color: #831843;
    box-shadow: inset 0 0 0 0.5px rgba(244, 114, 182, 0.30);
  }
  .gooni-note-card-checked {
    text-decoration: line-through;
    opacity: 0.5;
  }
  .gooni-note-card-content {
    /* Inline-flow content holder. Nothing here intentionally — keeps text
       behaving like any other inline span. */
  }

  /* Check affordance — real DOM child (not a CSS pseudo) so click handlers
     can target it. Hidden by default, shown on hover of the card. Sits
     absolutely positioned in the top-right corner. */
  .gooni-note-card-check {
    position: absolute;
    top: -8px;
    right: -8px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #fff;
    color: #16A34A;
    font-size: 11px;
    line-height: 18px;
    text-align: center;
    font-weight: 700;
    box-shadow: 0 1px 3px rgba(15,23,42,0.18),
                inset 0 0 0 0.5px rgba(15,23,42,0.10);
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    opacity: 0;
    pointer-events: none;
    transform: scale(0.7);
    transition: opacity 0.12s ease, transform 0.12s ease;
  }
  .gooni-note-card:hover .gooni-note-card-check {
    opacity: 1;
    pointer-events: auto;
    transform: scale(1);
  }
  .gooni-note-card-checked .gooni-note-card-check {
    background: #DCFCE7;
    color: #16A34A;
  }
  .gooni-note-card-check:hover {
    transform: scale(1.12);
  }

  /* === Public-view overrides ============================================
     When the public route mounts this CSS with [data-public-view] on the
     surrounding container, hide the check affordance entirely — public
     viewers can't toggle, so an interactive-looking icon would be a lie. */
  [data-public-view] .gooni-note-card-check {
    display: none;
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
    // Don't unmount on cleanup — the style is shared across surfaces;
    // dedup happens via the data-attr check above.
  }, []);
}
