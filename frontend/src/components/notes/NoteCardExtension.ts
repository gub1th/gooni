import { Mark, getMarkRange, mergeAttributes } from "@tiptap/core";

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
 * Inline mark that wraps a selection in a pastel rounded "card." Used as a
 * retroactive "I did this" visual marker inside notes — distinct from a Todo.
 *
 * State carried as attrs:
 *   - color: "blue" | "pink"
 *   - checked: boolean (when true, card renders dimmed + struck through)
 *
 * Rendering: <span data-note-card> wraps a content hole + a clickable check
 * affordance. The check is rendered as a real DOM sibling (not a CSS pseudo)
 * so clicking it can toggle `checked` without keyboard/mouse-target gymnastics.
 * It's `contenteditable="false"` so the editor cursor skips over it. Click
 * delegation in NoteEditor catches the click and routes via posAtDOM.
 *
 * IMPORTANT: kept as <span role="button">, NOT <button>, because the
 * sanitizer (utils/sanitize.ts) strips <button> tags on the public view.
 * Span + role keeps the affordance accessible while surviving sanitization.
 */
export const NoteCard = Mark.create({
  name: "noteCard",
  inclusive: false,
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
      // Content hole — selected text renders here. Wrapped so the check
      // affordance can sit as a sibling without breaking inline flow.
      ["span", { class: "gooni-note-card-content" }, 0],
      // Clickable check affordance. contenteditable=false so the cursor
      // never lands inside it. Click delegation in NoteEditor handles
      // toggling `checked` via toggleNoteCardCheckedAtPos.
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

      // Toggle checked at a specific doc position. Used by the click
      // delegate for the inline check button + cmd+click anywhere on card.
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

      // Cycle blue → pink → blue. Toolbar button calls this when cursor
      // is inside an existing card.
      cycleNoteCardColor:
        () =>
        ({ chain, editor }) => {
          const cur = (editor.getAttributes(this.name).color ?? "blue") as
            | NoteCardColor
            | undefined;
          const next: NoteCardColor = cur === "blue" ? "pink" : "blue";
          return chain()
            .extendMarkRange(this.name)
            .updateAttributes(this.name, { color: next })
            .run();
        },
    };
  },
});
