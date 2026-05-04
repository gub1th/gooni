import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { FigureNodeView } from "./FigureNodeView";

export type FigureAlign = "left" | "center" | "right";

export interface FigureAttrs {
  src: string;
  alt: string | null;
  width: number; // percentage 10-100
  align: FigureAlign;
  caption: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    figure: {
      setFigure: (attrs: { src: string; alt?: string }) => ReturnType;
      updateFigureAttrs: (attrs: Partial<FigureAttrs>) => ReturnType;
    };
  }
}

// Node represents <figure data-figure data-align data-width>
//   <img src=... alt=...>
//   <figcaption>...</figcaption>
// </figure>
//
// Caption + alignment + width all live as DOM attrs so the public read-only
// page can render them with plain CSS — no JS-side rehydration. Caption is
// a string attr (not a child node) because we don't need rich text inside
// it; click → contenteditable → blur → setNodeAttribute keeps it dead simple.
//
// Back-compat: any plain <img> in saved HTML is upgraded to a Figure with
// default attrs (width 100, align center, no caption) on parse. Old notes
// keep rendering; new attrs only stick once the user touches them.
export const Figure = Node.create({
  name: "figure",
  group: "block",
  atom: false,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: "" },
      alt: { default: null },
      width: {
        default: 100,
        parseHTML: (el) => {
          const w = el.getAttribute("data-width");
          if (w) return Math.max(10, Math.min(100, parseInt(w, 10) || 100));
          return 100;
        },
        renderHTML: (attrs) => ({ "data-width": String(attrs.width ?? 100) }),
      },
      align: {
        default: "center" as FigureAlign,
        parseHTML: (el) => {
          const a = el.getAttribute("data-align");
          if (a === "left" || a === "right" || a === "center") return a;
          return "center";
        },
        renderHTML: (attrs) => ({ "data-align": attrs.align ?? "center" }),
      },
      caption: {
        default: "",
        parseHTML: (el) => {
          const cap = el.querySelector("figcaption");
          return cap?.textContent?.trim() || "";
        },
      },
    };
  },

  parseHTML() {
    return [
      // Primary parse rule — matches our own output
      {
        tag: "figure[data-figure]",
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const img = el.querySelector("img");
          if (!img) return false;
          return {
            src: img.getAttribute("src") || "",
            alt: img.getAttribute("alt") || null,
          };
        },
      },
      // Back-compat: any bare <img> from the old Image extension
      // gets upgraded to a Figure. Default attrs apply.
      // The closest("figure[data-figure]") guard prevents double-wrapping
      // of imgs that were already rendered inside a Figure on a re-parse.
      {
        tag: "img[src]",
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          if (el.closest("figure[data-figure]")) return false;
          return {
            src: el.getAttribute("src") || "",
            alt: el.getAttribute("alt") || null,
            width: 100,
            align: "center",
            caption: "",
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    const caption = (node.attrs.caption || "").trim();
    return [
      "figure",
      mergeAttributes(HTMLAttributes, {
        "data-figure": "",
        // class lets the public-page prose CSS target alignment without
        // having to read data-align (faster + more familiar to CSS authors)
        class: `gooni-figure gooni-figure-${node.attrs.align ?? "center"}`,
        style: `--figure-width: ${node.attrs.width ?? 100}%`,
      }),
      ["img", { src: node.attrs.src, alt: node.attrs.alt ?? "" }],
      // Always emit figcaption when there's text. Skipping it when empty
      // keeps the public-page render clean for un-captioned images.
      ...(caption ? [["figcaption", {}, caption] as const] : []),
    ];
  },

  addCommands() {
    return {
      setFigure:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              src: attrs.src,
              alt: attrs.alt ?? null,
              width: 100,
              align: "center",
              caption: "",
            },
          }),
      updateFigureAttrs:
        (attrs) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, attrs),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(FigureNodeView);
  },
});
