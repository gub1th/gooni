import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { FocusLineDecoration, formatFocusElapsed } from "./FocusLineExtension";

// Headless tiptap editor — no React, no BubbleMenu. This exercises the
// extension exactly the way NoteEditor uses it: `setFocusLineAt(pos,
// startedAt)` after starting a session, `clearFocusLine()` after it ends.
function makeEditor(html: string): Editor {
  return new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit, FocusLineDecoration],
    content: html,
  });
}

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** Start of a textblock's content — same position NoteEditor anchors on. */
function textblockStart(ed: Editor, matchText: string): number {
  let found: number | null = null;
  ed.state.doc.descendants((node, pos) => {
    if (found != null) return false;
    if (node.isTextblock && node.textContent.includes(matchText)) {
      found = pos + 1; // start of this block's content
    }
    return found == null;
  });
  if (found == null) throw new Error(`no textblock containing "${matchText}"`);
  return found;
}

/** This element's children, minus ProseMirror's own view-internal padding
 * nodes (the trailing-break `<br>` / separator `<img>` it adds so an
 * otherwise-empty inline run still has somewhere for the cursor to land) —
 * those aren't part of our decoration and aren't part of the document. */
function realChildren(el: Element): Element[] {
  return Array.from(el.children).filter(
    (c) => !c.className.toString().startsWith("ProseMirror-")
  );
}

describe("FocusLineDecoration", () => {
  it("renders nothing until a focus line is set", () => {
    editor = makeEditor("<p>hello world</p>");
    expect(editor.view.dom.querySelector("[data-focus-line-icon]")).toBeNull();
    expect(editor.view.dom.querySelector("[data-focus-line-timer]")).toBeNull();
  });

  it("places the icon at the start and the timer at the end of a plain paragraph", () => {
    editor = makeEditor("<p>hello world</p>");
    const pos = textblockStart(editor, "hello world");
    const startedAt = Date.now() - 5000;
    editor.commands.setFocusLineAt(pos, startedAt);

    const p = editor.view.dom.querySelector("p") as HTMLElement;
    expect(p).toBeTruthy();
    const [first, last] = realChildren(p);
    expect(first.hasAttribute("data-focus-line-icon")).toBe(true);
    expect(last.hasAttribute("data-focus-line-timer")).toBe(true);
    // Text itself is untouched, sitting between the two widgets.
    expect(p.textContent).toContain("hello world");
  });

  it("places the icon after the bullet marker, not before it — bullet list", () => {
    editor = makeEditor("<ul><li>buy milk</li></ul>");
    const pos = textblockStart(editor, "buy milk");
    editor.commands.setFocusLineAt(pos, Date.now());

    const li = editor.view.dom.querySelector("li") as HTMLElement;
    expect(li).toBeTruthy();
    // The marker is the browser's own ::marker pseudo-element on the <li> —
    // not a DOM node we can query — so "after the marker" is proven by the
    // icon being the first thing INSIDE the li's paragraph content, never a
    // sibling preceding the <li> itself (which would be the only way to
    // render before a CSS list marker).
    const p = li.querySelector("p") as HTMLElement;
    expect(realChildren(p)[0].hasAttribute("data-focus-line-icon")).toBe(true);
    expect(li.previousSibling).toBeNull();
    expect(li.parentElement?.tagName).toBe("UL");
  });

  it("places the icon after the marker on a numbered line too", () => {
    editor = makeEditor("<ol><li>first step</li></ol>");
    const pos = textblockStart(editor, "first step");
    editor.commands.setFocusLineAt(pos, Date.now());

    const li = editor.view.dom.querySelector("li") as HTMLElement;
    const p = li.querySelector("p") as HTMLElement;
    expect(realChildren(p)[0].hasAttribute("data-focus-line-icon")).toBe(true);
    expect(li.parentElement?.tagName).toBe("OL");
  });

  it("clearFocusLine removes both widgets", () => {
    editor = makeEditor("<p>hello world</p>");
    const pos = textblockStart(editor, "hello world");
    editor.commands.setFocusLineAt(pos, Date.now());
    expect(editor.view.dom.querySelector("[data-focus-line-icon]")).not.toBeNull();

    editor.commands.clearFocusLine();
    expect(editor.view.dom.querySelector("[data-focus-line-icon]")).toBeNull();
    expect(editor.view.dom.querySelector("[data-focus-line-timer]")).toBeNull();
  });

  it("never enters the document — getHTML() is byte-identical before and after", () => {
    // Ends in a paragraph (not the list) so StarterKit's own TrailingNode
    // extension has nothing to append on the first transaction — keeping
    // this test isolated to what FocusLineDecoration itself does to the doc.
    editor = makeEditor("<p>hello world</p><ul><li>buy milk</li></ul><p>tail</p>");
    const before = editor.getHTML();
    const pos = textblockStart(editor, "hello world");
    editor.commands.setFocusLineAt(pos, Date.now());

    expect(editor.getHTML()).toBe(before);

    // Also true through a real edit while the decoration is live.
    editor.commands.focus("end");
    editor.commands.insertContent(" more");
    const afterEdit = editor.getHTML();
    expect(afterEdit).not.toBe(before); // the edit itself landed
    expect(afterEdit).not.toContain("focus-line");
    expect(afterEdit).not.toContain("gooni-focus-line");

    editor.commands.clearFocusLine();
    expect(editor.getHTML()).toBe(afterEdit);
  });

  it("is a no-op decoration when the anchor position is out of range", () => {
    editor = makeEditor("<p>hi</p>");
    editor.commands.setFocusLineAt(999, Date.now());
    expect(editor.view.dom.querySelector("[data-focus-line-icon]")).toBeNull();
  });
});

describe("formatFocusElapsed", () => {
  it("renders m:ss under an hour", () => {
    expect(formatFocusElapsed(0)).toBe("0:00");
    expect(formatFocusElapsed(7_000)).toBe("0:07");
    expect(formatFocusElapsed(65_000)).toBe("1:05");
  });

  it("renders h:mm:ss past an hour", () => {
    expect(formatFocusElapsed(3_661_000)).toBe("1:01:01");
  });
});
