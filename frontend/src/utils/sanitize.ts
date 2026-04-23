/**
 * Tiny no-dep HTML sanitizer for rendering trusted-ish TipTap output on public
 * pages. Not a DOMPurify replacement — deliberately narrow:
 *
 *   - Drops tags that shouldn't appear in notes (script, iframe, style, etc.)
 *   - Strips every `on*` attribute (onclick, onerror, onload, …) on anything
 *   - Rewrites `href`/`src` to reject `javascript:` and other non-safe schemes
 *
 * TipTap's own schema already prevents most of these, but anything that reaches
 * the DB via `/notes PATCH content` can be arbitrary HTML. Belt-and-suspenders
 * before we render with dangerouslySetInnerHTML on /public/<id>.
 */

// Elements we refuse to render even if TipTap would never emit them.
const BANNED_TAGS = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "META", "LINK",
  "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT",
]);

// Allowed URL schemes on href/src. Also allow protocol-relative (//) and
// relative/anchor URLs (no scheme).
const SAFE_SCHEMES = /^(https?:|mailto:|data:image\/)/i;

function isUrlSafe(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  // no-scheme / relative / anchor: safe
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return true;
  return SAFE_SCHEMES.test(trimmed);
}

export function sanitizeHtml(html: string): string {
  if (!html) return "";

  // Parse in a detached document so untrusted markup never touches the live DOM.
  const doc = new DOMParser().parseFromString(html, "text/html");

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  const toRemove: Element[] = [];
  // Buffer removals — mutating during walk skips siblings.
  let node: Element | null = walker.currentNode as Element;
  while ((node = walker.nextNode() as Element | null)) {
    if (BANNED_TAGS.has(node.tagName)) {
      toRemove.push(node);
      continue;
    }
    // Drop every on* attribute — covers onclick, onerror, onload, …
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.toLowerCase().startsWith("on")) {
        node.removeAttribute(attr.name);
      }
    }
    // Neutralize dangerous URL schemes on href/src.
    for (const urlAttr of ["href", "src"]) {
      const v = node.getAttribute(urlAttr);
      if (v != null && !isUrlSafe(v)) {
        node.removeAttribute(urlAttr);
      }
    }
  }
  for (const el of toRemove) el.remove();

  return doc.body.innerHTML;
}
