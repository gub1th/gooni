import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { LinkCardNodeView } from "./LinkCardNodeView";

export interface LinkCardAttrs {
  url: string;
  title: string;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    linkCard: {
      setLinkCard: (attrs: LinkCardAttrs) => ReturnType;
    };
  }
}

// Confluence-style short-wide preview card for an external URL. Block
// atom — same shape as the Attachment node so behavior is predictable
// (cursor doesn't trap inside the card; selectable as a unit).
//
// Persists to HTML as:
//   <a data-link-card href="..." data-title data-description data-image data-site>
//     <span class="gooni-link-card-...">…inner mock…</span>
//   </a>
//
// The `<a>` carries a real href so the sanitized public-page render
// stays clickable (new tab) even without React.
export const LinkCard = Node.create({
  name: "linkCard",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      url: {
        default: "",
        parseHTML: (el) => el.getAttribute("href") || el.getAttribute("data-url") || "",
        renderHTML: (attrs) => ({ "data-url": attrs.url || "" }),
      },
      title: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-title") || "",
        renderHTML: (attrs) => ({ "data-title": attrs.title || "" }),
      },
      description: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-description") || null,
        renderHTML: (attrs) =>
          attrs.description ? { "data-description": attrs.description } : {},
      },
      image: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-image") || null,
        renderHTML: (attrs) =>
          attrs.image ? { "data-image": attrs.image } : {},
      },
      siteName: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-site") || null,
        renderHTML: (attrs) =>
          attrs.siteName ? { "data-site": attrs.siteName } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "a[data-link-card]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    // The SMARTLINK shape — one row, title + host, no thumbnail and no
    // description. Must mirror LinkCardNodeView: this output is what gets
    // stored in the note body and what the public page renders, so a
    // divergence means a note looks different once published.
    //
    // `description` and `image` are still carried as data-attributes even
    // though nothing renders them. The OG fetch writes them, and stripping
    // them here would quietly destroy metadata on every note that has it the
    // next time its body was saved.
    const url = (node.attrs.url as string) || "";
    const title = (node.attrs.title as string) || url;
    const siteName = (node.attrs.siteName as string) || hostnameFromUrl(url);
    return [
      "a",
      mergeAttributes(HTMLAttributes, {
        "data-link-card": "",
        href: url,
        target: "_blank",
        rel: "noopener noreferrer",
        class: "gooni-link-card",
      }),
      ["span", { class: "gooni-link-card-title" }, title],
      ["span", { class: "gooni-link-card-site" }, siteName],
    ];
  },

  addCommands() {
    return {
      setLinkCard:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent([
            { type: this.name, attrs },
            { type: "paragraph" },
          ]),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(LinkCardNodeView);
  },
});

export function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
