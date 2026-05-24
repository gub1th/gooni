import { Extension } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import tippy, { type Instance as TippyInstance } from "tippy.js";

import { searchNoteTitles, type ApiNote } from "../../services/api";
import { NoteMentionMenu, type NoteMentionMenuRef } from "./NoteMentionMenu";

// Distinct plugin key. @tiptap/suggestion registers its ProseMirror plugin
// under a default key ("suggestion$"); SlashCommand already uses that default,
// so a second Suggestion without its own key collides ("Adding different
// instances of a keyed plugin") and crashes the editor on mount. Give the
// @-mention suggestion its own key so both can coexist in one editor.
const noteMentionPluginKey = new PluginKey("noteMention");

const LABEL_MAX = 60;

function labelFor(note: ApiNote): string {
  const t = (note.title || "Untitled").trim();
  return t.length > LABEL_MAX ? t.slice(0, LABEL_MAX - 1) + "…" : t;
}

/**
 * `@`-mention an existing note. Triggered by typing `@` (after whitespace —
 * the default allowedPrefixes blocks mid-word so emails like foo@bar don't
 * fire). Drops a NoteLink inline chip whose click is already wired in
 * NoteEditor to route via Zustand selectNote.
 *
 * Async note search is driven through `component.updateProps` rather than
 * Suggestion's sync `items` pipeline: that lets us debounce the title search,
 * show a loading state, and discard stale responses (seq guard) without
 * fighting Suggestion's assumption that items resolve synchronously.
 */
export const NoteMention = Extension.create({
  name: "note-mention",

  addOptions() {
    return {
      suggestion: {
        char: "@",
        pluginKey: noteMentionPluginKey,
        startOfLine: false,
        // props = the ApiNote chosen in the menu (forwarded via props.command).
        command: ({ editor, range, props }: { editor: any; range: any; props: ApiNote }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent([
              { type: "noteLink", attrs: { noteId: props.id, label: labelFor(props) } },
              { type: "text", text: " " },
            ])
            .run();
        },
        // Real search happens in render() via updateProps — keep this a no-op
        // so Suggestion doesn't try to drive the (async) result set itself.
        items: () => [],
        render: () => {
          let component: ReactRenderer<NoteMentionMenuRef> | null = null;
          let popup: TippyInstance[] = [];
          let timer: ReturnType<typeof setTimeout> | null = null;
          let seq = 0;

          const runSearch = (query: string) => {
            const mySeq = ++seq;
            // Keep prior items visible; just flip loading so the menu can show
            // "Searching…" only when there's nothing to show yet.
            component?.updateProps({ loading: true, query });
            if (timer) clearTimeout(timer);
            timer = setTimeout(async () => {
              try {
                const notes = await searchNoteTitles(query ?? "", 8);
                if (mySeq !== seq) return; // a newer keystroke won
                component?.updateProps({ items: notes, loading: false, query });
              } catch {
                if (mySeq !== seq) return;
                component?.updateProps({ items: [], loading: false, query });
              }
            }, 160);
          };

          return {
            onStart: (props: any) => {
              component = new ReactRenderer(NoteMentionMenu, {
                props: {
                  items: [],
                  loading: true,
                  query: props.query,
                  command: (note: ApiNote) => props.command(note),
                },
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
                theme: "transparent",
                popperOptions: {
                  modifiers: [{ name: "flip", options: { fallbackPlacements: ["top-start"] } }],
                },
              });
              runSearch(props.query ?? "");
            },
            onUpdate(props: any) {
              // Rebind command to the latest range, then re-search.
              component?.updateProps({ command: (note: ApiNote) => props.command(note) });
              if (props.clientRect) {
                popup[0]?.setProps({
                  getReferenceClientRect: () => props.clientRect?.() ?? new DOMRect(),
                });
              }
              runSearch(props.query ?? "");
            },
            onKeyDown(props: any) {
              if (props.event.key === "Escape") {
                popup[0]?.hide();
                return true;
              }
              return component?.ref?.onKeyDown(props) ?? false;
            },
            onExit() {
              if (timer) clearTimeout(timer);
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
