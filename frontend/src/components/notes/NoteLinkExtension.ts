import { Node, mergeAttributes } from "@tiptap/core";

/**
 * Inline atom node that renders as a clickable chip pointing at another note.
 * Inserted by the BubbleMenu "↗ Extract" action: selection is replaced with
 * a NoteLink whose `noteId` is the freshly-created child note.
 *
 * Click is wired via a vanilla `gooni-note-link-click` CustomEvent so the
 * surrounding React component (NoteEditor) can route through Zustand's
 * selectNote without TipTap needing access to React Router context.
 */
export const NoteLink = Node.create({
  name: "noteLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      noteId: {
        default: null,
        parseHTML: (el) => {
          const v = (el as HTMLElement).getAttribute("data-note-id");
          return v ? Number(v) : null;
        },
        renderHTML: (attrs) =>
          attrs.noteId == null ? {} : { "data-note-id": String(attrs.noteId) },
      },
      label: {
        default: "",
        parseHTML: (el) => (el as HTMLElement).getAttribute("data-label") ?? "",
        renderHTML: (attrs) => ({ "data-label": attrs.label || "" }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "a[data-note-link]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const label =
      (HTMLAttributes as Record<string, string>)["data-label"] || "note";
    return [
      "a",
      mergeAttributes(HTMLAttributes, {
        "data-note-link": "true",
        class: "gooni-note-link",
        href: "#",
      }),
      `↗ ${label}`,
    ];
  },
});
