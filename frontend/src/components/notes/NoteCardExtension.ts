import { Mark, getMarkRange, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    noteCard: {
      toggleNoteCard: (attrs?: { color?: NoteCardColor }) => ReturnType;
      setNoteCardChecked: (checked: boolean) => ReturnType;
      toggleNoteCardCheckedAtPos: (pos: number) => ReturnType;
    };
  }
}

export type NoteCardColor = "blue" | "pink";

export const NOTE_CARD_COLORS: NoteCardColor[] = ["blue", "pink"];

/**
 * Inline mark that wraps a selection in a pastel rounded "card." Used as a
 * retroactive "I did this" visual marker inside notes — distinct from a Todo
 * (no list semantics, no backend, no due date).
 *
 * State carried as attrs:
 *   - color: "blue" | "pink" (default "blue") — pastel palette
 *   - checked: boolean (default false) — when true, card renders dimmed + struck through
 *
 * Editing affordance:
 *   - BubbleMenu "Card" button — toggle the mark on the current selection
 *   - Cmd/Ctrl+click anywhere on a card → toggle `checked` (the v1 stand-in
 *     for the hover-only check button Daniel asked for; the proper
 *     decoration-based hover button is a v2)
 *
 * Persistence: TipTap serializes the mark into the note HTML, so checked
 * state survives saves + reloads without any backend changes.
 */
export const NoteCard = Mark.create({
  name: "noteCard",
  inclusive: false,
  // Marks of the same name with different `color` attrs shouldn't auto-merge
  // — keeping the user's color choice stable across edits.
  excludes: "",

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
    return [{ tag: "span[data-note-card]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const attrs = HTMLAttributes as Record<string, string>;
    const color = attrs["data-color"] === "pink" ? "pink" : "blue";
    const checked = attrs["data-checked"] === "true";
    return [
      "span",
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
      0,
    ];
  },

  addCommands() {
    return {
      toggleNoteCard:
        (attrs) =>
        ({ commands }) =>
          commands.toggleMark(this.name, {
            color: attrs?.color ?? "blue",
            checked: false,
          }),

      setNoteCardChecked:
        (checked) =>
        ({ chain }) =>
          chain()
            .extendMarkRange(this.name)
            .updateAttributes(this.name, { checked })
            .run(),

      // Toggle the checked state of the noteCard mark at a specific doc pos.
      // Used by the cmd+click delegate in NoteEditor — the click event
      // resolves to a DOM position which we convert to a ProseMirror pos.
      toggleNoteCardCheckedAtPos:
        (pos) =>
        ({ state, chain }) => {
          const $pos = state.doc.resolve(pos);
          const markType = state.schema.marks[this.name];
          if (!markType) return false;
          const range = getMarkRange($pos, markType);
          if (!range) return false;
          const existing = $pos
            .marks()
            .find((m) => m.type.name === this.name);
          const current = existing?.attrs.checked === true;
          return chain()
            .setTextSelection(range)
            .updateAttributes(this.name, { checked: !current })
            .setTextSelection(state.selection.from)
            .run();
        },
    };
  },
});
