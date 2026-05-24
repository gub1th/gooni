import { Node, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    noteCard: {
      toggleNoteCard: (attrs?: { color?: NoteCardColor }) => ReturnType;
      setNoteCardChecked: (checked: boolean) => ReturnType;
      toggleNoteCardCheckedAtPos: (pos: number) => ReturnType;
      cycleNoteCardColor: () => ReturnType;
    };
  }
}

export type NoteCardColor = "blue" | "pink";
export const NOTE_CARD_COLORS: NoteCardColor[] = ["blue", "pink"];

/**
 * Block-level "card" / callout panel (Confluence-style). Wraps one or more
 * block children (paragraphs, headings, lists) into a single full-width
 * pastel panel with a check affordance on the LEFT, vertically centered.
 *
 * Was previously an inline Mark — that rendered multi-paragraph selections as
 * N separate pills (one per block, each with its own check) because a mark
 * can't span block boundaries. A block node wraps the whole selection range
 * into ONE container, which is what the Confluence panel vibe needs.
 *
 * State carried as node attrs:
 *   - color: "blue" | "pink"
 *   - checked: boolean (true → content dimmed + struck through, check filled)
 *
 * Rendering: <div data-note-card> → [check span][content div]. The check is a
 * real DOM child (not a CSS pseudo) so a click delegate in NoteEditor can
 * target it and toggle `checked` via toggleNoteCardCheckedAtPos. It's
 * contenteditable="false" so the editor cursor skips it.
 *
 * IMPORTANT: check is <span role="button">, NOT <button>, because the public
 * sanitizer (utils/sanitize.ts) strips <button> tags. Span + role survives.
 */
export const NoteCard = Node.create({
  name: "noteCard",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      color: {
        default: "blue" as NoteCardColor,
        parseHTML: (el) => {
          const v = (el as HTMLElement).getAttribute("data-color");
          return v === "pink" ? "pink" : "blue";
        },
        renderHTML: (attrs) => ({ "data-color": attrs.color ?? "blue" }),
      },
      checked: {
        default: false,
        parseHTML: (el) =>
          (el as HTMLElement).getAttribute("data-checked") === "true",
        renderHTML: (attrs) => ({
          "data-checked": attrs.checked ? "true" : "false",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-note-card]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const attrs = HTMLAttributes as Record<string, string>;
    const color = attrs["data-color"] === "pink" ? "pink" : "blue";
    const checked = attrs["data-checked"] === "true";
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-note-card": "true",
        class: [
          "gooni-note-card",
          `gooni-note-card-${color}`,
          checked ? "gooni-note-card-checked" : "",
        ]
          .filter(Boolean)
          .join(" "),
      }),
      // Check affordance — left, vertically centered via flex. contenteditable
      // false so the cursor never lands inside. Click delegation in NoteEditor
      // toggles `checked` via toggleNoteCardCheckedAtPos.
      [
        "span",
        {
          class: "gooni-note-card-check",
          contenteditable: "false",
          "data-card-check": "true",
          role: "button",
          "aria-label": "Toggle done",
        },
        "✓",
      ],
      // Block content hole — the wrapped paragraphs render here.
      ["div", { class: "gooni-note-card-content" }, 0],
    ];
  },

  addCommands() {
    return {
      // Wrap the selected block range in a card, or lift it back out if the
      // selection is already inside one. toggleWrap handles both directions.
      toggleNoteCard:
        (attrs) =>
        ({ commands }) =>
          commands.toggleWrap(this.name, {
            color: attrs?.color ?? "blue",
            checked: false,
          }),

      // Set checked on the card containing the current selection.
      setNoteCardChecked:
        (checked) =>
        ({ state, dispatch, tr }) => {
          const found = findCardAt(state, state.selection.from);
          if (!found) return false;
          if (dispatch) {
            tr.setNodeMarkup(found.pos, undefined, {
              ...found.node.attrs,
              checked,
            });
            dispatch(tr);
          }
          return true;
        },

      // Toggle checked on the card whose body contains `pos`. Used by the
      // click delegate (check pill + cmd+click anywhere on the card body).
      toggleNoteCardCheckedAtPos:
        (pos) =>
        ({ state, dispatch, tr }) => {
          const found = findCardAt(state, pos);
          if (!found) return false;
          if (dispatch) {
            tr.setNodeMarkup(found.pos, undefined, {
              ...found.node.attrs,
              checked: !found.node.attrs.checked,
            });
            dispatch(tr);
          }
          return true;
        },

      // Cycle blue → pink → blue on the card at the current selection.
      cycleNoteCardColor:
        () =>
        ({ state, dispatch, tr }) => {
          const found = findCardAt(state, state.selection.from);
          if (!found) return false;
          const cur = (found.node.attrs.color ?? "blue") as NoteCardColor;
          const next: NoteCardColor = cur === "blue" ? "pink" : "blue";
          if (dispatch) {
            tr.setNodeMarkup(found.pos, undefined, {
              ...found.node.attrs,
              color: next,
            });
            dispatch(tr);
          }
          return true;
        },
    };
  },
});

/**
 * Walk up from a doc position to the nearest enclosing noteCard node.
 * Returns the node plus its `before` position (where setNodeMarkup expects it).
 */
function findCardAt(
  state: import("@tiptap/pm/state").EditorState,
  pos: number
): { node: import("@tiptap/pm/model").Node; pos: number } | null {
  const $pos = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)));
  for (let d = $pos.depth; d >= 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === "noteCard") {
      return { node, pos: $pos.before(d) };
    }
  }
  return null;
}
