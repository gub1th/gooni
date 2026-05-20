import { Mark, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    textColor: {
      setTextColor: (color: string | null) => ReturnType;
    };
  }
}

/**
 * Minimal text-color palette. Saturations chosen to read clearly against
 * the pastel NoteCard backgrounds AND on plain white. `value: null` means
 * "remove color" → fall back to the editor's default text color.
 */
export const TEXT_COLOR_PALETTE: Array<{
  name: string;
  value: string | null;
  label: string;
}> = [
  { name: "default", value: null,      label: "Default" },
  { name: "slate",   value: "#475569", label: "Slate"   },
  { name: "rose",    value: "#E11D48", label: "Rose"    },
  { name: "amber",   value: "#D97706", label: "Amber"   },
  { name: "emerald", value: "#059669", label: "Emerald" },
  { name: "sky",     value: "#0284C7", label: "Sky"     },
  { name: "violet",  value: "#7C3AED", label: "Violet"  },
];

/**
 * Inline text-color mark. Rolled own instead of pulling
 * @tiptap/extension-color + @tiptap/extension-text-style — keeps the no-
 * new-deps rule and the surface stays minimal. Persists as inline
 * `style="color: …"` on a <span data-text-color> wrapper, which survives
 * the public-view sanitizer (utils/sanitize.ts only strips on* attrs and
 * tags, not arbitrary inline style).
 */
export const TextColor = Mark.create({
  name: "textColor",
  inclusive: true,

  addAttributes() {
    return {
      color: {
        default: null as string | null,
        parseHTML: (el) => {
          const style = (el as HTMLElement).getAttribute("style") ?? "";
          const m = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
          return m ? m[1].trim() : null;
        },
        renderHTML: (attrs) =>
          attrs.color ? { style: `color: ${attrs.color}` } : {},
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-text-color]",
        getAttrs: (node) => {
          const el = node as HTMLElement;
          const style = el.getAttribute("style") ?? "";
          const m = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
          return m ? { color: m[1].trim() } : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-text-color": "true" }),
      0,
    ];
  },

  addCommands() {
    return {
      setTextColor:
        (color) =>
        ({ commands }) => {
          if (color == null) {
            return commands.unsetMark(this.name);
          }
          return commands.setMark(this.name, { color });
        },
    };
  },
});
