import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";

/**
 * Notion-style outline rail. Walks the TipTap doc, picks out heading
 * nodes (H1/H2), and renders them as a sticky list. Click jumps the
 * editor selection to that heading + smooth-scrolls it into view.
 *
 * Hidden by default until there are 2+ headings — a short note doesn't
 * need an outline.
 */

interface Heading {
  level: 1 | 2;
  text: string;
  pos: number;
}

function collectHeadings(editor: Editor | null): Heading[] {
  if (!editor) return [];
  const out: Heading[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      const level = node.attrs.level;
      if (level === 1 || level === 2) {
        out.push({ level, text: node.textContent || "Untitled", pos });
      }
    }
    return true;
  });
  return out;
}

export function OutlinePanel({ editor }: { editor: Editor | null }) {
  const [headings, setHeadings] = useState<Heading[]>([]);

  // Re-walk the doc on every editor transaction. TipTap fires onUpdate
  // for content changes; we also need selection-only changes to refresh
  // the active-heading highlight, so subscribe to the broader event.
  useEffect(() => {
    if (!editor) return;
    const refresh = () => setHeadings(collectHeadings(editor));
    refresh();
    editor.on("update", refresh);
    editor.on("selectionUpdate", refresh);
    return () => {
      editor.off("update", refresh);
      editor.off("selectionUpdate", refresh);
    };
  }, [editor]);

  if (!editor || headings.length < 2) return null;

  function jumpTo(pos: number) {
    if (!editor) return;
    editor.chain().focus().setTextSelection(pos + 1).run();
    // Scroll the heading into view. setTextSelection alone doesn't
    // scroll on most browsers when the element is far off-screen.
    requestAnimationFrame(() => {
      const view = editor.view;
      try {
        const dom = view.domAtPos(pos + 1);
        const node = dom.node;
        const el =
          node.nodeType === Node.ELEMENT_NODE
            ? (node as HTMLElement)
            : (node.parentElement as HTMLElement | null);
        if (el && typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      } catch {
        // best-effort — selection alone is fine if scroll fails
      }
    });
  }

  return (
    <aside
      style={{
        position: "sticky",
        top: 72,
        alignSelf: "flex-start",
        width: 180,
        flexShrink: 0,
        padding: "0 12px 0 0",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        maxHeight: "calc(100vh - 96px)",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: "var(--gooni-muted, #9CA3AF)",
          marginBottom: 6,
          paddingLeft: 6,
        }}
      >
        On this page
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {headings.map((h, idx) => (
          <button
            key={`${h.pos}-${idx}`}
            onClick={() => jumpTo(h.pos)}
            title={h.text}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              border: "none",
              background: "transparent",
              padding: "3px 6px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12.5,
              color: h.level === 1
                ? "var(--gooni-text, #1C1C1E)"
                : "var(--gooni-muted, #6B7280)",
              fontWeight: h.level === 1 ? 600 : 400,
              paddingLeft: h.level === 1 ? 6 : 18,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "rgba(15,23,42,0.05)";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--gooni-text, #1C1C1E)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color =
                h.level === 1 ? "var(--gooni-text, #1C1C1E)" : "var(--gooni-muted, #6B7280)";
            }}
          >
            {h.text}
          </button>
        ))}
      </div>
    </aside>
  );
}
