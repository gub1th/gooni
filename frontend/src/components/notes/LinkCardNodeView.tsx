import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { hostnameFromUrl } from "./LinkCardExtension";
import { frostInk as ctok } from "../../ui";

// Editor-side React rendering for LinkCard. Mirrors the static
// renderHTML output so editor + public look identical, but uses
// inline styles for the editor (public CSS lives in public.$noteId.tsx).
export function LinkCardNodeView({ node, selected }: NodeViewProps) {
  const url = (node.attrs.url as string) || "";
  const title = (node.attrs.title as string) || url;
  const description = (node.attrs.description as string) || "";
  const image = (node.attrs.image as string) || "";
  const siteName = (node.attrs.siteName as string) || hostnameFromUrl(url);

  return (
    <NodeViewWrapper
      as="a"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-link-card=""
      data-url={url}
      data-title={title}
      data-description={description || undefined}
      data-image={image || undefined}
      data-site={siteName || undefined}
      className="gooni-link-card"
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 0,
        border: selected ? "1.5px solid #2D7DFF" : "1px solid rgba(0,0,0,0.12)",
        borderRadius: 8,
        margin: "12px 0",
        background: ctok.bg,
        textDecoration: "none",
        color: "inherit",
        overflow: "hidden",
        minHeight: 72,
        transition: "background 120ms",
      }}
      onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => {
        e.currentTarget.style.background = "#F2F2F4";
      }}
      onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => {
        e.currentTarget.style.background = ctok.bg;
      }}
    >
      <span
        className="gooni-link-card-body"
        style={{
          flex: 1,
          minWidth: 0,
          padding: "10px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <span
          className="gooni-link-card-site"
          style={{
            fontSize: 11,
            color: ctok.muted,
            letterSpacing: 0.2,
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          {siteName}
        </span>
        <span
          className="gooni-link-card-title"
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: ctok.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            lineHeight: 1.3,
          }}
        >
          {title}
        </span>
        {description && (
          <span
            className="gooni-link-card-desc"
            style={{
              fontSize: 12.5,
              color: "var(--gooni-muted, #6E6E73)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              lineHeight: 1.4,
            }}
          >
            {description}
          </span>
        )}
      </span>
      {image && (
        <span
          className="gooni-link-card-thumb"
          style={{
            flexShrink: 0,
            width: 110,
            backgroundImage: `url(${JSON.stringify(image).slice(1, -1)})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
          aria-hidden="true"
        />
      )}
    </NodeViewWrapper>
  );
}
