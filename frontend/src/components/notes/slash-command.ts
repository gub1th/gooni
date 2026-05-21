import { Extension } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import {
  Heading1, Heading2,
  List, ListOrdered, ListChecks,
  Quote, Code2, Minus, Table as TableIcon,
  Link as LinkIcon, ChevronRight as ChevronRightIcon,
} from "lucide-react";
import { fetchOgMetadata } from "../../services/api";

import { SlashMenu, type SlashItem, type SlashMenuRef } from "./SlashMenu";

// The block-insert library. Each item nukes the typed `/<query>` and replaces
// it with the chosen block. Keywords drive the fuzzy filter so users can type
// `/h1`, `/heading`, `/title` for the same heading item.
const ITEMS: SlashItem[] = [
  {
    title: "Heading 1",
    description: "Big section title",
    Icon: Heading1,
    keywords: ["h1", "title", "heading"],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run(),
  },
  {
    title: "Heading 2",
    description: "Medium section title",
    Icon: Heading2,
    keywords: ["h2", "subtitle", "heading"],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run(),
  },
  {
    title: "Bullet list",
    description: "Simple unordered list",
    Icon: List,
    keywords: ["bullet", "ul", "unordered", "list"],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: "Numbered list",
    description: "Ordered list",
    Icon: ListOrdered,
    keywords: ["ordered", "ol", "number", "list"],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: "Task list",
    description: "Checkboxes you can tick",
    Icon: ListChecks,
    keywords: ["task", "todo", "checkbox", "check"],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    title: "Quote",
    description: "Pull-quote / callout",
    Icon: Quote,
    keywords: ["quote", "blockquote", "callout"],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: "Code block",
    description: "Monospaced fenced block",
    Icon: Code2,
    keywords: ["code", "monospace", "snippet", "fence"],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    title: "Divider",
    description: "Horizontal rule",
    Icon: Minus,
    keywords: ["divider", "hr", "horizontal", "rule", "line"],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    title: "Toggle",
    description: "Collapsible block — Notion-style",
    Icon: ChevronRightIcon,
    keywords: ["toggle", "collapse", "details", "expand", "hide"],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertToggleBlock().run(),
  },
  {
    title: "Table",
    description: "3×3 with header row",
    Icon: TableIcon,
    keywords: ["table", "grid"],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    title: "Link card",
    description: "Paste a URL → Confluence-style preview",
    Icon: LinkIcon,
    keywords: ["link", "url", "card", "embed", "preview", "confluence"],
    command: ({ editor, range }) => {
      const url = window.prompt("Paste a URL:");
      if (!url || !url.trim()) return;
      const trimmed = url.trim();
      // Optimistic insert with a placeholder, then patch the node attrs
      // when the OG fetch resolves. Keeps the editor responsive — the
      // user sees the card immediately and the meta hydrates in place.
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent([
          {
            type: "linkCard",
            attrs: {
              url: trimmed,
              title: trimmed,
              description: null,
              image: null,
              siteName: null,
            },
          },
          { type: "paragraph" },
        ])
        .run();
      fetchOgMetadata(trimmed)
        .then((meta) => {
          // Walk the doc to find the inserted node by url and patch.
          // `descendants` gives us nodes + positions; setNodeAttribute
          // expects a position so we can target the right one even if
          // there are multiple cards in the doc.
          const { state } = editor;
          let targetPos: number | null = null;
          state.doc.descendants((node, pos) => {
            if (
              node.type.name === "linkCard" &&
              node.attrs.url === trimmed &&
              !node.attrs.siteName
            ) {
              targetPos = pos;
              return false;
            }
            return true;
          });
          if (targetPos != null) {
            editor
              .chain()
              .command(({ tr }) => {
                tr.setNodeMarkup(targetPos as number, undefined, {
                  url: meta.url,
                  title: meta.title,
                  description: meta.description,
                  image: meta.image,
                  siteName: meta.site_name,
                });
                return true;
              })
              .run();
          }
        })
        .catch((e) => console.warn("[link-card] OG fetch failed:", e));
    },
  },
];

// Case-insensitive substring match across title and keywords. Empty query
// shows everything so `/` alone surfaces the full menu — same UX as Confluence.
function filterItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return ITEMS;
  return ITEMS.filter((item) => {
    if (item.title.toLowerCase().includes(q)) return true;
    if (item.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
    return false;
  });
}

export const SlashCommand = Extension.create({
  name: "slash-command",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        // Trigger the menu only when the slash starts a new line/block — avoids
        // interfering with paths and inline `/` inside running prose.
        startOfLine: false,
        command: ({ editor, range, props }: { editor: any; range: any; props: SlashItem }) => {
          props.command({ editor, range });
        },
        items: ({ query }: { query: string }) => filterItems(query),
        render: () => {
          let component: ReactRenderer<SlashMenuRef> | null = null;
          let popup: TippyInstance[] = [];

          return {
            onStart: (props: any) => {
              component = new ReactRenderer(SlashMenu, {
                props,
                editor: props.editor,
              });
              if (!props.clientRect) return;
              popup = tippy("body", {
                getReferenceClientRect: () => props.clientRect?.() ?? new DOMRect(),
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: "manual",
                placement: "bottom-start",
                arrow: false,
                offset: [0, 8],
                // Match the shadow on SlashMenu — tippy's default theme background
                // would double up. Strip it.
                theme: "transparent",
                popperOptions: {
                  modifiers: [{ name: "flip", options: { fallbackPlacements: ["top-start"] } }],
                },
              });
            },
            onUpdate(props: any) {
              component?.updateProps(props);
              if (!props.clientRect) return;
              popup[0]?.setProps({
                getReferenceClientRect: () => props.clientRect?.() ?? new DOMRect(),
              });
            },
            onKeyDown(props: any) {
              if (props.event.key === "Escape") {
                popup[0]?.hide();
                return true;
              }
              return component?.ref?.onKeyDown(props) ?? false;
            },
            onExit() {
              popup[0]?.destroy();
              component?.destroy();
            },
          };
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
