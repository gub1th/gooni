import { useEffect } from "react";
import { createPortal } from "react-dom";
import { z } from "../../ui";

interface Props {
  url: string;
  filename: string;
  mime: string;
  size: number;
  onClose: () => void;
}

// Shared preview surface for an attachment. Renders image / PDF / video
// inline; falls back to a download button for opaque MIME types. Same
// component used by the editor's NodeView and the public-note page's
// global click handler.
export function AttachmentModal({ url, filename, mime, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const lower = (mime || "").toLowerCase();
  const isImage = lower.startsWith("image/");
  const isPdf = lower === "application/pdf";
  const isVideo = lower.startsWith("video/");
  const isAudio = lower.startsWith("audio/");

  // Portal to <body>. In the editor this modal mounts inside the
  // AttachmentNodeView's clickable NodeViewWrapper, so without a portal its
  // own clicks (Close / overlay / Download) bubble up to the wrapper's
  // onClick → setOpen(true) and the modal re-opens the instant you try to
  // close it. Body-level mount also escapes any editor stacking context.
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        zIndex: z.modalScrim,
        display: "flex",
        flexDirection: "column",
        padding: 24,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          color: "#fff",
          marginBottom: 14,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 14, opacity: 0.9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60vw" }}>
          {filename}
        </span>
        <div style={{ display: "flex", gap: 10 }}>
          <a
            href={url}
            download={filename}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{
              fontSize: 13,
              color: "#fff",
              background: "rgba(255,255,255,0.18)",
              border: "1px solid rgba(255,255,255,0.25)",
              padding: "6px 12px",
              borderRadius: 8,
              textDecoration: "none",
            }}
          >
            Download
          </a>
          <button
            onClick={onClose}
            style={{
              background: "rgba(255,255,255,0.18)",
              border: "1px solid rgba(255,255,255,0.25)",
              color: "#fff",
              padding: "6px 12px",
              borderRadius: 8,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
      </div>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#fff",
          borderRadius: 12,
          overflow: "hidden",
          minHeight: 0,
        }}
      >
        {isImage ? (
          <img
            src={url}
            alt={filename}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
          />
        ) : isPdf ? (
          <iframe
            src={url}
            title={filename}
            style={{ width: "100%", height: "100%", border: "none" }}
          />
        ) : isVideo ? (
          <video controls src={url} style={{ maxWidth: "100%", maxHeight: "100%" }} />
        ) : isAudio ? (
          <audio controls src={url} style={{ width: "60%" }} />
        ) : (
          <div style={{ textAlign: "center", padding: 32, color: "#444" }}>
            <p style={{ fontSize: 15, marginBottom: 12 }}>No inline preview for this file type.</p>
            <a
              href={url}
              download={filename}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-block",
                background: "#2D7DFF",
                color: "#fff",
                padding: "10px 18px",
                borderRadius: 8,
                fontSize: 14,
                textDecoration: "none",
              }}
            >
              Open / download
            </a>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
