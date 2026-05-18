import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { AttachmentNodeView } from "./AttachmentNodeView";

export interface AttachmentAttrs {
  url: string;
  filename: string;
  mime: string;
  size: number; // bytes
  attachmentId: number | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    attachment: {
      setAttachment: (attrs: AttachmentAttrs) => ReturnType;
    };
  }
}

// Block-level atom node. Renders to:
//   <div data-attachment
//        data-url="..."
//        data-filename="..."
//        data-mime="..."
//        data-size="..."
//        data-attachment-id="..."
//        class="gooni-attachment-card">
//     <a href="..." target="_blank" rel="noopener" class="gooni-attachment-link">
//       <span class="gooni-attachment-icon">…</span>
//       <span class="gooni-attachment-meta">
//         <span class="gooni-attachment-name">filename.pdf</span>
//         <span class="gooni-attachment-sub">PDF · 1.4 MB</span>
//       </span>
//     </a>
//   </div>
//
// Same DOM works on public sanitized HTML — clicking the `<a>` opens the
// file in a new tab. The editor's NodeView intercepts the click and shows
// the inline preview modal instead.
export const Attachment = Node.create({
  name: "attachment",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      url: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-url") || "",
        renderHTML: (attrs) => ({ "data-url": attrs.url || "" }),
      },
      filename: {
        default: "attachment",
        parseHTML: (el) => el.getAttribute("data-filename") || "attachment",
        renderHTML: (attrs) => ({ "data-filename": attrs.filename || "attachment" }),
      },
      mime: {
        default: "application/octet-stream",
        parseHTML: (el) => el.getAttribute("data-mime") || "application/octet-stream",
        renderHTML: (attrs) => ({ "data-mime": attrs.mime || "application/octet-stream" }),
      },
      size: {
        default: 0,
        parseHTML: (el) => {
          const n = parseInt(el.getAttribute("data-size") || "0", 10);
          return Number.isFinite(n) ? n : 0;
        },
        renderHTML: (attrs) => ({ "data-size": String(attrs.size ?? 0) }),
      },
      attachmentId: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute("data-attachment-id");
          if (!v) return null;
          const n = parseInt(v, 10);
          return Number.isFinite(n) ? n : null;
        },
        renderHTML: (attrs) =>
          attrs.attachmentId != null
            ? { "data-attachment-id": String(attrs.attachmentId) }
            : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-attachment]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const filename = (node.attrs.filename as string) || "attachment";
    const mime = (node.attrs.mime as string) || "application/octet-stream";
    const size = Number(node.attrs.size) || 0;
    const url = (node.attrs.url as string) || "";
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-attachment": "",
        class: "gooni-attachment-card",
      }),
      [
        "a",
        {
          href: url,
          target: "_blank",
          rel: "noopener noreferrer",
          class: "gooni-attachment-link",
        },
        ["span", { class: "gooni-attachment-icon" }, iconLabelForMime(mime)],
        [
          "span",
          { class: "gooni-attachment-meta" },
          ["span", { class: "gooni-attachment-name" }, filename],
          ["span", { class: "gooni-attachment-sub" }, `${shortMime(mime)} · ${formatBytes(size)}`],
        ],
      ],
    ];
  },

  addCommands() {
    return {
      setAttachment:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent([
            { type: this.name, attrs },
            { type: "paragraph" },
          ]),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(AttachmentNodeView);
  },
});

// Pure helpers — duplicated in AttachmentNodeView for parity with the
// static renderHTML output. Keep them aligned if you change either.
export function iconLabelForMime(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return "IMG";
  if (m === "application/pdf") return "PDF";
  if (m.startsWith("video/")) return "VID";
  if (m.startsWith("audio/")) return "AUD";
  if (m.startsWith("text/") || m.includes("json") || m.includes("xml")) return "TXT";
  if (m.includes("zip") || m.includes("compressed") || m.includes("tar") || m.includes("rar")) return "ZIP";
  if (m.includes("word") || m.includes("officedocument.wordprocessing")) return "DOC";
  if (m.includes("sheet") || m.includes("excel")) return "XLS";
  if (m.includes("presentation") || m.includes("powerpoint")) return "PPT";
  return "FILE";
}

export function shortMime(mime: string): string {
  if (!mime) return "file";
  const last = mime.split("/").pop() || mime;
  return last.replace(/^vnd\.[^.]*\./, "").replace(/^x-/, "").toUpperCase();
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}
