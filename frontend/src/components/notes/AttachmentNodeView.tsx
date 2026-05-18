import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import React, { useState } from "react";
import { AttachmentModal } from "./AttachmentModal";
import { formatBytes, iconLabelForMime, shortMime } from "./AttachmentExtension";

// Card surface for an Attachment node. Click → opens AttachmentModal
// (image lightbox / PDF iframe / generic download fallback). Same DOM
// shape as the static renderHTML output so public sanitized HTML can
// look identical without React.
export function AttachmentNodeView({ node, selected }: NodeViewProps) {
  const filename = (node.attrs.filename as string) || "attachment";
  const mime = (node.attrs.mime as string) || "application/octet-stream";
  const size = Number(node.attrs.size) || 0;
  const url = (node.attrs.url as string) || "";

  const [open, setOpen] = useState(false);

  return (
    <NodeViewWrapper
      data-attachment=""
      data-url={url}
      data-filename={filename}
      data-mime={mime}
      data-size={String(size)}
      className="gooni-attachment-card"
      style={{
        border: selected ? "1.5px solid #2D7DFF" : "1px solid rgba(0,0,0,0.12)",
        borderRadius: 10,
        padding: 10,
        margin: "10px 0",
        background: "#FAFAFA",
        cursor: "pointer",
        transition: "background 120ms, border-color 120ms",
        userSelect: "none",
      }}
      onClick={(e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (url) setOpen(true);
      }}
    >
      <div
        className="gooni-attachment-link"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          textDecoration: "none",
          color: "inherit",
        }}
      >
        <span
          className="gooni-attachment-icon"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 38,
            height: 38,
            borderRadius: 8,
            background: "rgba(45,125,255,0.10)",
            color: "#2D7DFF",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.3,
            flexShrink: 0,
          }}
        >
          {iconLabelForMime(mime)}
        </span>
        <span
          className="gooni-attachment-meta"
          style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 2 }}
        >
          <span
            className="gooni-attachment-name"
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: "#1C1C1E",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {filename}
          </span>
          <span
            className="gooni-attachment-sub"
            style={{ fontSize: 12, color: "#8E8E93" }}
          >
            {shortMime(mime)} · {formatBytes(size)}
          </span>
        </span>
      </div>
      {open && (
        <AttachmentModal
          url={url}
          filename={filename}
          mime={mime}
          size={size}
          onClose={() => setOpen(false)}
        />
      )}
    </NodeViewWrapper>
  );
}
