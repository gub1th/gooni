import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    focusLineDecoration: {
      /** Anchor the running-focus decoration to the textblock containing `pos`. */
      setFocusLineAt: (pos: number, startedAt: number) => ReturnType;
      /** Drop the decoration — the session it was tracking ended (or moved). */
      clearFocusLine: () => ReturnType;
    };
  }
}

interface FocusLineState {
  pos: number | null;
  startedAt: number | null;
}

const EMPTY_STATE: FocusLineState = { pos: null, startedAt: null };

export const focusLineKey = new PluginKey<FocusLineState>("focusLine");

/** `3:07` under an hour, `1:03:07` past one. Ticks up, never down. */
export function formatFocusElapsed(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// Matches lucide-react's AlarmClock glyph exactly (same viewBox/paths) so the
// inline decoration reads as the same icon as the BubbleMenu's Focus button —
// hand-drawn rather than mounting a React root into a widget DOM node, which
// would mean a mount/unmount lifecycle PM's decoration diffing doesn't offer
// a hook for.
const ALARM_CLOCK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6"/>' +
  '<path d="m22 6-3-3"/><path d="M6.38 18.7 4 21"/><path d="M17.64 18.67 20 21"/></svg>';

function buildIconWidget(): HTMLElement {
  const span = document.createElement("span");
  span.className = "gooni-focus-line-icon";
  span.contentEditable = "false";
  span.setAttribute("data-focus-line-icon", "true");
  span.innerHTML = ALARM_CLOCK_SVG;
  return span;
}

function buildTimerWidget(startedAt: number): HTMLElement {
  const span = document.createElement("span");
  span.className = "gooni-focus-line-timer";
  span.contentEditable = "false";
  span.setAttribute("data-focus-line-timer", "true");
  span.dataset.startedAt = String(startedAt);
  span.textContent = formatFocusElapsed(Date.now() - startedAt);
  return span;
}

/**
 * Decorates the line a running focus session is anchored to: an alarm-clock
 * icon at the start of its content, a live elapsed timer at the end.
 *
 * Pure VIEW-layer decoration — `Decoration.widget`, not a node or a mark. It
 * is never part of the document, so it cannot appear in `getHTML()`, an
 * export, a publish, the excerpt, the embedding, or anything the assistant
 * reads. See FocusLineExtension.test.ts for the content-purity assertion.
 *
 * The anchor is a single doc position (`pos`), always the START of a
 * textblock's content — for a plain paragraph that's right after the block
 * opens; for a bullet/numbered list item it's the same position, one level
 * deeper, and the marker is the browser's own `::marker` pseudo-element
 * rendered on the <li>, entirely outside this node's content. Anchoring at
 * content-start therefore puts the icon after the marker on every block type
 * without any per-type branching.
 *
 * The timer widget's DOM node carries its own `data-started-at` and re-reads
 * `Date.now()` on a plain `setInterval` owned by the plugin view — it does
 * NOT re-run `decorations()` every second. Decorations only recompute on a
 * transaction (an edit, a selection change, or an explicit
 * setFocusLineAt/clearFocusLine meta), so a self-ticking widget is what keeps
 * "counting up" independent of unrelated typing elsewhere in the note.
 */
export const FocusLineDecoration = Extension.create({
  name: "focusLineDecoration",

  addCommands() {
    return {
      setFocusLineAt:
        (pos, startedAt) =>
        ({ tr, dispatch }) => {
          if (dispatch) tr.setMeta(focusLineKey, { pos, startedAt });
          return true;
        },
      clearFocusLine:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) tr.setMeta(focusLineKey, EMPTY_STATE);
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    let tickInterval: ReturnType<typeof setInterval> | null = null;

    return [
      new Plugin<FocusLineState>({
        key: focusLineKey,
        state: {
          init: () => EMPTY_STATE,
          apply(tr, prev) {
            const meta = tr.getMeta(focusLineKey) as FocusLineState | undefined;
            if (meta) return meta;
            if (!tr.docChanged || prev.pos == null) return prev;
            const mapped = tr.mapping.mapResult(prev.pos);
            if (mapped.deleted) return EMPTY_STATE;
            return { ...prev, pos: mapped.pos };
          },
        },
        props: {
          decorations(state) {
            const val = focusLineKey.getState(state);
            if (!val || val.pos == null || val.startedAt == null) return null;
            if (val.pos < 0 || val.pos > state.doc.content.size) return null;
            let $pos;
            try {
              $pos = state.doc.resolve(val.pos);
            } catch {
              return null;
            }
            // Walk up to the nearest enclosing textblock. `pos` is stored as
            // a block's content-start, so this is normally a no-op — the
            // walk is what keeps it graceful if an edit reshapes the doc
            // around the anchor instead of just shifting it.
            let depth = $pos.depth;
            while (depth > 0 && !$pos.node(depth).isTextblock) depth--;
            if (!$pos.node(depth).isTextblock) return null;
            const start = $pos.start(depth);
            const end = $pos.end(depth);
            const startedAt = val.startedAt;
            return DecorationSet.create(state.doc, [
              Decoration.widget(start, buildIconWidget, { side: -1, key: "focus-line-icon" }),
              Decoration.widget(end, () => buildTimerWidget(startedAt), {
                side: 1,
                key: "focus-line-timer",
              }),
            ]);
          },
        },
        view(editorView) {
          // Ticks the timer widget's own text in place, without touching
          // ProseMirror state — a transaction dispatched every second (to
          // recompute decorations()) would tear down and rebuild the widget
          // DOM on every tick, which is both wasteful and would fight any
          // real edit landing in the same window.
          tickInterval = setInterval(() => {
            const nodes = editorView.dom.querySelectorAll<HTMLElement>(
              "[data-focus-line-timer]"
            );
            nodes.forEach((el) => {
              const startedAt = Number(el.dataset.startedAt);
              if (Number.isFinite(startedAt)) {
                el.textContent = formatFocusElapsed(Date.now() - startedAt);
              }
            });
          }, 1000);
          return {
            destroy() {
              if (tickInterval) clearInterval(tickInterval);
              tickInterval = null;
            },
          };
        },
      }),
    ];
  },
});
