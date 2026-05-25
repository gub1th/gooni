import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { FileText } from "lucide-react";
import type { ApiNote } from "../../services/api";

interface NoteMentionMenuProps {
  items: ApiNote[];
  loading?: boolean;
  query?: string;
  command: (note: ApiNote) => void;
}

export interface NoteMentionMenuRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

// @-mention note picker. Mirrors SlashMenu's keyboard contract (ref exposes
// onKeyDown so the TipTap suggestion plugin can forward keystrokes while the
// editor keeps focus). Items are async note-title matches; shows a loading +
// empty state since the fetch is debounced.
export const NoteMentionMenu = forwardRef<NoteMentionMenuRef, NoteMentionMenuProps>(
  ({ items, loading, query, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useImperativeHandle(
      ref,
      () => ({
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
      }),
      [items, selectedIndex, command]
    );

    return (
      <div
        style={{
          background: "var(--gooni-card, #FFFFFF)",
          borderRadius: 10,
          padding: 6,
          minWidth: 260,
          maxHeight: 320,
          overflowY: "auto",
          boxShadow: "0 8px 28px rgba(0,0,0,0.16), 0 0 0 1px rgba(0,0,0,0.06)",
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        {loading && items.length === 0 ? (
          <div style={{ padding: "10px 12px", fontSize: 13, color: "var(--gooni-faint, #94A3B8)" }}>Searching…</div>
        ) : items.length === 0 ? (
          <div style={{ padding: "10px 12px", fontSize: 13, color: "var(--gooni-faint, #94A3B8)" }}>
            {query ? `No notes matching “${query}”` : "No notes yet"}
          </div>
        ) : (
          items.map((note, i) => (
            <button
              key={note.id}
              onMouseDown={(e) => {
                e.preventDefault();
                command(note);
              }}
              onMouseEnter={() => setSelectedIndex(i)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "8px 10px",
                borderRadius: 6,
                border: "none",
                background: i === selectedIndex ? "rgba(15,23,42,0.06)" : "transparent",
                cursor: "pointer",
                textAlign: "left",
                color: "var(--gooni-text, #0F172A)",
                fontFamily: "inherit",
                transition: "background 0.08s",
              }}
            >
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  background: i === selectedIndex ? "var(--gooni-card, #fff)" : "rgba(15,23,42,0.04)",
                  border: "1px solid rgba(15,23,42,0.06)",
                  flexShrink: 0,
                  color: "var(--gooni-muted, #475569)",
                }}
              >
                <FileText size={15} strokeWidth={1.8} />
              </span>
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                <span
                  style={{
                    fontSize: 13.5,
                    fontWeight: 500,
                    lineHeight: 1.3,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {note.title || "Untitled"}
                </span>
                {note.excerpt && (
                  <span
                    style={{
                      fontSize: 11.5,
                      color: "var(--gooni-faint, #94A3B8)",
                      lineHeight: 1.3,
                      marginTop: 1,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {note.excerpt}
                  </span>
                )}
              </span>
            </button>
          ))
        )}
      </div>
    );
  }
);

NoteMentionMenu.displayName = "NoteMentionMenu";
