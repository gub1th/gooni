import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ToggleBlockNodeView } from "./ToggleBlockNodeView";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    toggleBlock: {
      insertToggleBlock: () => ReturnType;
    };
  }
}

/**
 * Notion-style collapsible block. Top row holds a chevron button + a
 * single-line summary; child block content (paragraphs, lists, etc.)
 * hides when collapsed.
 *
 * Persists to HTML as:
 *   <div data-toggle-block data-open="true">
 *     <div data-toggle-summary>{summary text}</div>
 *     <div data-toggle-children>
 *       …block content…
 *     </div>
 *   </div>
 *
 * The summary lives in the node's attrs (plain text). The children are
 * full block content edited inline.
 */
export const ToggleBlock = Node.create({
  name: "toggleBlock",
  group: "block",
  content: "block+",
  defining: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (el) => (el as HTMLElement).getAttribute("data-open") !== "false",
        renderHTML: (attrs) => ({ "data-open": attrs.open ? "true" : "false" }),
      },
      summary: {
        default: "Toggle",
        parseHTML: (el) => (el as HTMLElement).getAttribute("data-summary") || "Toggle",
        renderHTML: (attrs) => ({ "data-summary": attrs.summary || "Toggle" }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-toggle-block]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-toggle-block": "true",
        class: "gooni-toggle-block",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      insertToggleBlock:
        () =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { open: true, summary: "Toggle" },
            content: [{ type: "paragraph" }],
          }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ToggleBlockNodeView);
  },
});
