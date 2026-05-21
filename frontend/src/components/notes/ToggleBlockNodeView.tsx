import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { ChevronRight } from "lucide-react";

/**
 * Toggle block — Notion-style collapsible section. Chevron clicks
 * toggle `open` attr. Summary text is the inline label; expanded
 * children render NodeViewContent (any block content).
 */
export function ToggleBlockNodeView({ node, updateAttributes }: NodeViewProps) {
  const open = node.attrs.open !== false;
  const summary = (node.attrs.summary as string) || "Toggle";

  return (
    <NodeViewWrapper
      data-toggle-block
      data-open={open ? "true" : "false"}
      className="gooni-toggle-block"
    >
      <div
        className="gooni-toggle-header"
        contentEditable={false}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          margin: "2px 0",
        }}
      >
        <button
          onClick={(e) => {
            e.preventDefault();
            updateAttributes({ open: !open });
          }}
          title={open ? "Collapse" : "Expand"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            padding: 0,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            color: "var(--gooni-muted, #6B7280)",
            borderRadius: 4,
            transition: "background 0.12s, transform 0.18s ease",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(15,23,42,0.06)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
        >
          <ChevronRight
            size={14}
            strokeWidth={2.2}
            style={{
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 0.18s ease",
            }}
          />
        </button>
        <input
          value={summary}
          onChange={(e) => updateAttributes({ summary: e.target.value })}
          placeholder="Toggle"
          style={{
            flex: 1,
            minWidth: 0,
            border: "none",
            outline: "none",
            background: "transparent",
            fontSize: "inherit",
            fontWeight: 600,
            color: "var(--gooni-text, #1C1C1E)",
            fontFamily: "inherit",
            padding: 0,
          }}
        />
      </div>
      {/* Children render here. Hidden when collapsed, but kept in the
          DOM so cursor state survives toggle. ProseMirror needs the
          content slot accessible even when not visually shown. */}
      <div
        style={{
          paddingLeft: 24,
          display: open ? "block" : "none",
          borderLeft: "1px solid rgba(15,23,42,0.06)",
          marginLeft: 8,
        }}
      >
        <NodeViewContent />
      </div>
    </NodeViewWrapper>
  );
}
