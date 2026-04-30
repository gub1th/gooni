import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import type { Editor, Range } from "@tiptap/core";
import type { LucideIcon } from "lucide-react";

export interface SlashItem {
  title: string;
  description?: string;
  Icon: LucideIcon;
  command: (props: { editor: Editor; range: Range }) => void;
  keywords?: string[];
}

interface SlashMenuProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
}

export interface SlashMenuRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

// Confluence-style block-insert menu. Renders a vertical list with keyboard nav.
// Owns its selection state; ref exposes onKeyDown so the TipTap suggestion
// plugin can forward keystrokes while the editor still has focus.
export const SlashMenu = forwardRef<SlashMenuRef, SlashMenuProps>(({ items, command }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset highlight whenever the filtered set changes — typing more characters
  // narrows the list, and we want the first match to be the default.
  useEffect(() => { setSelectedIndex(0); }, [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "ArrowUp") {
        setSelectedIndex((i) => (i + items.length - 1) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === "ArrowDown") {
        setSelectedIndex((i) => (i + 1) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === "Enter") {
        if (items[selectedIndex]) command(items[selectedIndex]);
        return true;
      }
      return false;
    },
  }), [items, selectedIndex, command]);

  return (
    <div
      style={{
        background: "#FFFFFF",
        borderRadius: 10,
        padding: 6,
        minWidth: 240,
        maxHeight: 320,
        overflowY: "auto",
        boxShadow: "0 8px 28px rgba(0,0,0,0.16), 0 0 0 1px rgba(0,0,0,0.06)",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      {items.length === 0 ? (
        <div style={{ padding: "10px 12px", fontSize: 13, color: "#94A3B8" }}>No matches</div>
      ) : (
        items.map((item, i) => (
          <button
            key={item.title}
            onMouseDown={(e) => { e.preventDefault(); command(item); }}
            onMouseEnter={() => setSelectedIndex(i)}
            style={{
              display: "flex", alignItems: "center", gap: 10,
              width: "100%", padding: "8px 10px",
              borderRadius: 6,
              border: "none",
              background: i === selectedIndex ? "rgba(15,23,42,0.06)" : "transparent",
              cursor: "pointer",
              textAlign: "left",
              color: "#0F172A",
              fontFamily: "inherit",
              transition: "background 0.08s",
            }}
          >
            <span style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 28, height: 28, borderRadius: 6,
              background: i === selectedIndex ? "#fff" : "rgba(15,23,42,0.04)",
              border: "1px solid rgba(15,23,42,0.06)",
              flexShrink: 0,
              color: "#475569",
            }}>
              <item.Icon size={15} strokeWidth={1.8} />
            </span>
            <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
              <span style={{ fontSize: 13.5, fontWeight: 500, lineHeight: 1.3 }}>{item.title}</span>
              {item.description && (
                <span style={{ fontSize: 11.5, color: "#94A3B8", lineHeight: 1.3, marginTop: 1 }}>
                  {item.description}
                </span>
              )}
            </span>
          </button>
        ))
      )}
    </div>
  );
});

SlashMenu.displayName = "SlashMenu";
