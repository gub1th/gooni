// The shape a QUICK capture takes when it becomes a note: the first line is the
// title, everything after it is the body. The ambient capture box has always
// done this on ⌘↵ (`text.split("\n")` → title + rest), and the expanded note
// editor writes through the same rule — otherwise the same gesture would
// produce a titled note from the box and an "Untitled" one from the editor.
//
// Pure + HTML-level on purpose: the editor's document is HTML by the time it is
// submitted, and doing the split here (rather than over ProseMirror nodes) keeps
// the rule testable in jsdom with no editor to stand up.

const MAX_TITLE = 120;

export interface TitleAndBody {
  title: string;
  body: string;
}

/**
 * Split a note's HTML into `{title, body}` by lifting its first block.
 *
 * Two cases deliberately keep the WHOLE document as the body:
 *   · no first block at all (empty document)
 *   · a first block with no text — a lone image, a figure, an attachment card.
 *     Its text content is "", so there is no title to lift, and removing the
 *     block anyway would silently destroy the one thing the note contained.
 */
export function splitTitleAndBody(html: string): TitleAndBody {
  const trimmed = (html ?? "").trim();
  if (!trimmed) return { title: "", body: "" };

  const doc = new DOMParser().parseFromString(`<body>${trimmed}</body>`, "text/html");
  const first = doc.body.firstElementChild;
  if (!first) {
    // No element wrapper at all (a bare text node) — treat the text as the title.
    const text = (doc.body.textContent ?? "").trim();
    return text ? { title: text.slice(0, MAX_TITLE), body: "" } : { title: "", body: trimmed };
  }

  const title = (first.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!title) return { title: "", body: trimmed };

  first.remove();
  return { title: title.slice(0, MAX_TITLE), body: doc.body.innerHTML.trim() };
}

/**
 * Plain text → the editor's HTML. Each line becomes its own paragraph, so the
 * first line lands in its own block and `splitTitleAndBody` lifts exactly the
 * line the capture box would have used as the title.
 *
 * Escapes on the way in: the box's text is a user's raw keystrokes, and a typed
 * `<b>` must survive as those four characters rather than becoming markup.
 */
export function textToParagraphs(text: string): string {
  const lines = (text ?? "").split("\n");
  // A trailing empty line is the caret sitting on a fresh line, not content.
  while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.every((l) => l.trim() === "")) return "";
  return lines.map((line) => `<p>${escapeHtml(line) || "<br>"}</p>`).join("");
}

/**
 * Does this document hold anything a plain-text box could NOT show?
 *
 * The capture box and the note editor are one composer in two sizes, and
 * collapsing mirrors the editor's TEXT back into the box. That is lossless for
 * the ordinary case (a few lines of prose) and lossy the moment there is a
 * heading, a list, an image or a task item — so the box says so, rather than
 * quietly presenting a flattened copy as the whole thought.
 *
 * Paragraphs and line breaks are exactly what the box can render, so they don't
 * count. Anything else does.
 */
export function hasRichContent(html: string): boolean {
  return /<(?!\/?(?:p|br)\b)[a-z]/i.test(html ?? "");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
