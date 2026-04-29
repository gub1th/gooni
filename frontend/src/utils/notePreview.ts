// Helpers for note-card previews — extract the first <img src> from TipTap HTML
// and produce a clean text excerpt that EXCLUDES image tags so the alt-less
// image isn't rendered as a blank gap in the excerpt.

const IMG_TAG_RE = /<img\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/i;

export function extractFirstImage(html: string): string | null {
  if (!html) return null;
  const m = IMG_TAG_RE.exec(html);
  if (!m) return null;
  return m[1] || m[2] || m[3] || null;
}

// Strip all HTML to plain text. Removes images first so they don't leave
// alt-text artifacts. Collapses whitespace.
export function stripHtmlForExcerpt(html: string): string {
  if (!html) return "";
  return html
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Strip HTML preserving line breaks — used when we care about the FIRST line
// of content for title fallbacks. Block-level closers become \n so first-line
// detection is meaningful.
function stripHtmlPreservingLines(html: string): string {
  if (!html) return "";
  return html
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// Display title for a note: prefer the explicit title field, fall back to the
// first line of the body (Apple Notes style), final fallback "Untitled" only
// when both are empty. Composer-created notes never set a title, so this
// keeps the UI from showing a wall of "Untitled" rows.
export function displayTitle(
  note: { title?: string | null; content?: string | null },
  empty = "Untitled",
): string {
  const t = note.title?.trim();
  if (t) return t;
  const plain = stripHtmlPreservingLines(note.content || "");
  if (plain) {
    const lineEnd = plain.search(/[\n\r]/);
    const firstLine = plain.slice(0, lineEnd > 0 ? lineEnd : 50).trim();
    if (firstLine) return firstLine;
  }
  return empty;
}
