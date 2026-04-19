import { useRef, useState, useEffect, useCallback } from "react";
import { useGooniStore } from "../stores/useGooniStore";
import { useConversationsStore } from "../stores/useConversationsStore";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { ModelSelector } from "./ModelSelector";

interface GooniPanelProps {
  fullscreen?: boolean;
}

export function GooniPanel({ fullscreen = false }: GooniPanelProps) {
  const { toggle, width, setWidth } = useGooniStore();
  const { messages, sending, send } = useConversationsStore();
  const { notes, activeNoteId, selectedSpaceId } = useNotesContentStore();
  const [input, setInput] = useState("");
  const [expandedIntentions, setExpandedIntentions] = useState<Set<number>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const spaceId = selectedSpaceId ?? "general";
  const activeNote = (notes[spaceId] ?? []).find((n) => n.id === activeNoteId) ?? null;

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    await send(text, activeNote?.content ?? undefined);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Drag-to-resize (only in sidebar mode)
  const onDragMouseDown = useCallback((e: React.MouseEvent) => {
    if (fullscreen) return;
    e.preventDefault();
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = width;

    function onMouseMove(e: MouseEvent) {
      if (!isDragging.current) return;
      const delta = dragStartX.current - e.clientX; // drag left = wider
      setWidth(dragStartWidth.current + delta);
    }
    function onMouseUp() {
      isDragging.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [fullscreen, width, setWidth]);

  const containerStyle: React.CSSProperties = fullscreen
    ? {
        flex: 1,
        height: "100vh",
        background: "#FFFFFF",
        borderLeft: "1px solid rgba(0,0,0,0.08)",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        position: "relative",
      }
    : {
        width,
        minWidth: width,
        height: "100vh",
        background: "#FFFFFF",
        borderLeft: "1px solid rgba(0,0,0,0.08)",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        position: "relative",
      };

  return (
    <div style={containerStyle}>
      {/* Drag handle — left edge, sidebar only */}
      {!fullscreen && (
        <div
          onMouseDown={onDragMouseDown}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 4,
            height: "100%",
            cursor: "col-resize",
            zIndex: 10,
            background: "transparent",
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.08)")}
          onMouseLeave={(e) => {
            if (!isDragging.current)
              (e.currentTarget as HTMLDivElement).style.background = "transparent";
          }}
        />
      )}

      {/* Header */}
      <div
        style={{
          height: 52,
          padding: "0 16px",
          borderBottom: "1px solid rgba(0,0,0,0.08)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "#1C1C1E",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
          }}
        >
          Gooni
        </span>
        {!fullscreen && (
          <button
            onClick={toggle}
            title="Close Gooni"
            style={{
              width: 24,
              height: 24,
              borderRadius: "50%",
              background: "rgba(0,0,0,0.06)",
              border: "none",
              cursor: "pointer",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#636366",
              padding: 0,
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.12)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
          >
            ×
          </button>
        )}
      </div>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              color: "#AEAEB2",
              fontSize: 13,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
              textAlign: "center",
              marginTop: fullscreen ? 80 : 32,
            }}
          >
            {fullscreen
              ? "Ask Gooni anything, or open a note to get feedback on it."
              : "Ask Gooni anything. Your active note is shared as context."}
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: m.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            {m.role === "assistant" && m.intention && (
              <div style={{ marginBottom: 4, maxWidth: fullscreen ? 640 : "88%" }}>
                <button
                  onClick={() => setExpandedIntentions((prev) => {
                    const next = new Set(prev);
                    next.has(m.id) ? next.delete(m.id) : next.add(m.id);
                    return next;
                  })}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: "2px 0",
                    color: "#AEAEB2",
                    fontSize: 12,
                    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
                  }}
                >
                  <span>Assessed your intention</span>
                  <span style={{ fontSize: 10 }}>{expandedIntentions.has(m.id) ? "▾" : "▸"}</span>
                </button>
                {expandedIntentions.has(m.id) && (
                  <div
                    style={{
                      marginTop: 4,
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: "rgba(0,0,0,0.03)",
                      border: "1px solid rgba(0,0,0,0.07)",
                      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
                      <span style={{ color: "#AEAEB2", fontSize: 13, marginTop: 1 }}>⊙</span>
                      <span style={{ fontSize: 12.5, color: "#636366", lineHeight: 1.5 }}>{m.intention}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ color: "#34C759", fontSize: 13 }}>✓</span>
                      <span style={{ fontSize: 12, color: "#AEAEB2" }}>Done</span>
                    </div>
                  </div>
                )}
              </div>
            )}
            <div
              style={{
                maxWidth: fullscreen ? 640 : "88%",
                padding: "8px 12px",
                borderRadius: 14,
                fontSize: 13.5,
                lineHeight: 1.5,
                background: m.role === "user" ? "#1C1C1E" : "rgba(0,0,0,0.05)",
                color: m.role === "user" ? "#FFFFFF" : "#1C1C1E",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
              }}
            >
              {m.content}
            </div>
          </div>
        ))}
        {sending && (
          <div
            style={{
              color: "#AEAEB2",
              fontSize: 13,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
              fontStyle: "italic",
            }}
          >
            Gooni is thinking...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div
        style={{
          padding: "8px 16px 16px",
          borderTop: "1px solid rgba(0,0,0,0.08)",
          flexShrink: 0,
          maxWidth: fullscreen ? 720 : undefined,
          width: "100%",
          boxSizing: "border-box",
          alignSelf: fullscreen ? "center" : undefined,
        }}
      >
        {/* Active note context chip */}
        {activeNote && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 8,
              padding: "5px 10px",
              borderRadius: 8,
              background: "rgba(0,0,0,0.04)",
              border: "1px solid rgba(0,0,0,0.07)",
              width: "fit-content",
              maxWidth: "100%",
            }}
          >
            <span style={{ fontSize: 12 }}>📄</span>
            <span
              style={{
                fontSize: 12,
                color: "#636366",
                fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {activeNote.title?.trim() || "Untitled note"}
            </span>
          </div>
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            background: "#F2F2F7",
            borderRadius: 12,
            padding: "8px 12px",
            border: "1px solid rgba(0,0,0,0.08)",
          }}
        >
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Gooni... (⌘↵)"
            rows={2}
            style={{
              flex: 1,
              resize: "none",
              border: "none",
              padding: 0,
              fontSize: 13.5,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
              outline: "none",
              background: "transparent",
              color: "#1C1C1E",
              lineHeight: 1.4,
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            style={{
              width: 34,
              height: 34,
              borderRadius: "50%",
              border: "none",
              background: input.trim() && !sending ? "#1C1C1E" : "rgba(0,0,0,0.08)",
              color: input.trim() && !sending ? "#FFFFFF" : "#AEAEB2",
              fontSize: 16,
              cursor: input.trim() && !sending ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              transition: "background 0.1s",
            }}
          >
            →
          </button>
        </div>
        <ModelSelector />
        </div>
      </div>
    </div>
  );
}
