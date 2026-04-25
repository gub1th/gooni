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
