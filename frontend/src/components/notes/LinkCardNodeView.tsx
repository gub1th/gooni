import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { hostnameFromUrl } from "./LinkCardExtension";
import { frostInk as ctok } from "../../ui";

// Editor-side React rendering for LinkCard. Mirrors the static renderHTML
// output so editor + public look identical, but uses inline styles for the
// editor (public CSS lives in public.$noteId.tsx).
//
// A SMARTLINK, not a smartcard. It shipped as a 72px-tall block with a
// 110px thumbnail and a two-line description — a chunky slab that broke the
// flow of a note every time a URL appeared. A pasted link is usually a
// reference, not a piece of content, and it should read as one line of prose
// with a chip on it. So: one row, favicon + title + host, no image, no
// description, no vertical margin beyond a line's worth.
//
// The favicon comes from the SITE'S OWN origin (`/favicon.ico`), never a
// third-party favicon service — the same rule the browser extension follows
// and for the same reason: a favicon service would receive every host you
// ever link to. A failed load hides the img and leaves the dot.
export function LinkCardNodeView({ node, selected }: NodeViewProps) {
  const url = (node.attrs.url as string) || "";
  const title = (node.attrs.title as string) || url;
  const siteName = (node.attrs.siteName as string) || hostnameFromUrl(url);
  const description = (node.attrs.description as string) || "";
  const image = (node.attrs.image as string) || "";

  const favicon = (() => {
    try { return `${new URL(url).origin}/favicon.ico`; }
    catch { return null; }
  })();

  return (
    <NodeViewWrapper
      as="a"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-link-card=""
      data-url={url}
      data-title={title}
      // description + image are still CARRIED even though this view doesn't
      // render them: the OG fetch writes them, the public page's own CSS
      // reads them, and dropping the attrs here would silently strip metadata
      // from every note that already has it.
      data-description={description || undefined}
      data-image={image || undefined}
      data-site={siteName || undefined}
      className="gooni-link-card"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        maxWidth: "100%",
        border: selected ? `1.5px solid ${ctok.accent}` : `1px solid ${ctok.hairline}`,
        borderRadius: 6,
        margin: "2px 0",
        padding: "2px 8px 2px 6px",
        background: ctok.bg,
        textDecoration: "none",
        color: "inherit",
        lineHeight: 1.45,
        transition: "background 120ms",
      }}
      onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => {
        e.currentTarget.style.background = ctok.hover;
      }}
      onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => {
        e.currentTarget.style.background = ctok.bg;
      }}
    >
      {favicon && (
        <img
          src={favicon}
          alt=""
          width={14}
          height={14}
          style={{ flexShrink: 0, borderRadius: 3, display: "block" }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
      )}
      <span
        className="gooni-link-card-title"
        style={{
          fontSize: 13.5,
          fontWeight: 500,
          color: ctok.text,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {title}
      </span>
      <span
        className="gooni-link-card-site"
        style={{ fontSize: 11.5, color: ctok.muted, flexShrink: 0 }}
      >
        {siteName}
      </span>
    </NodeViewWrapper>
  );
}
