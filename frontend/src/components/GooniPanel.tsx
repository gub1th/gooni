import { useRef, useState, useEffect, useCallback } from "react";
import { useGooniStore } from "../stores/useGooniStore";
import { useConversationsStore } from "../stores/useConversationsStore";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { useFocusesStore } from "../stores/useFocusesStore";
import { ModelSelector } from "./ModelSelector";
import { ChatGraphView } from "./chat/ChatGraphView";

interface GooniPanelProps {
  fullscreen?: boolean;
  // New: panel rendered inside the floating shell anchored to the FAB.
  // Skips the drag-to-resize handle and uses 100% width/height of its parent.
  floating?: boolean;
}

export function GooniPanel({ fullscreen = false, floating = false }: GooniPanelProps) {
  const { width, setWidth } = useGooniStore();
  const { messages, sending, send, activeId } = useConversationsStore();
  const [viewMode, setViewMode] = useState<"chat" | "graph">("chat");
  const { notes, activeNoteId, selectedSpaceId } = useNotesContentStore();
  const { staleFocuses, fetchStale } = useFocusesStore();
  const [input, setInput] = useState("");

  // Pull stale focuses lazily so the empty-state can offer a check-in starter.
  // Cheap fetch — 6-row table at most. Only runs when the panel is mounted.
  useEffect(() => {
    fetchStale();
  }, [fetchStale]);
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

  const containerStyle: React.CSSProperties = floating
    ? {
        flex: 1,
        width: "100%",
        height: "100%",
        background: "#FFFFFF",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        position: "relative",
      }
    : fullscreen
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
      {/* Drag handle — left edge, sidebar only (not in floating + not fullscreen) */}
      {!fullscreen && !floating && (
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

      {/* View toggle — small floating chip top-right. Replaces the old header
          bar. Only shown when the conversation has enough turns to graph,
          and only in sidebar mode (fullscreen has its own ergonomics).
          Close behavior moved to the floating ChatLauncher (FAB). */}
      {!fullscreen && activeId !== null && messages.length > 6 && (
        <div style={{
          position: "absolute",
          top: 12,
          right: 12,
          zIndex: 5,
          display: "flex", gap: 0,
          border: "1px solid rgba(0,0,0,0.10)", borderRadius: 6,
          overflow: "hidden",
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        }}>
          {(["chat", "graph"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              style={{
                fontSize: 11, padding: "3px 9px",
                background: viewMode === m ? "#1C1C1E" : "#fff",
                color: viewMode === m ? "#fff" : "#6E6E73",
                border: "none", cursor: "pointer",
                fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
                fontWeight: 500,
              }}
            >
              {m}
            </button>
          ))}
        </div>
      )}

      {/* Graph view — renders in place of messages when toggled on. */}
      {viewMode === "graph" && activeId !== null && (
        <div style={{ flex: 1, overflowY: "auto" }}>
          <ChatGraphView conversationId={activeId} />
        </div>
      )}

      {/* Messages */}
      {viewMode === "chat" && (
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
        {messages.length === 0 && (() => {
          // Stale-focus check-in only fires when there's no active note —
          // a note in view should keep priority over a focus nudge.
          const checkin = !activeNote && staleFocuses.length > 0 ? staleFocuses[0] : null;
          if (checkin) {
            const days = checkin.days_since_activity;
            const heat =
              days === null ? "you haven't started yet"
              : days === 1 ? "1 day"
              : `${days} days`;
            return (
              <div style={{
                marginTop: fullscreen ? 80 : 32,
                padding: "0 4px",
                fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
                textAlign: "center",
              }}>
                <div style={{ fontSize: 13, color: "#3C3C43", lineHeight: 1.55 }}>
                  Hey — it's been <strong>{heat}</strong> since we touched <strong>{checkin.name}</strong>.
                </div>
                <button
                  onClick={() => {
                    const seed = `Let's talk about "${checkin.name}". What's the latest?`;
                    send(seed).catch(console.error);
                  }}
                  style={{
                    marginTop: 14,
                    background: "#1C1C1E", color: "#fff",
                    border: "none", borderRadius: 999, padding: "7px 14px",
                    fontFamily: "inherit", fontSize: 12, fontWeight: 500, cursor: "pointer",
                  }}
                >
                  Talk about it
                </button>
              </div>
            );
          }
          return (
            <div
              style={{
                color: "#AEAEB2",
                fontSize: 13,
                fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
                textAlign: "center",
                marginTop: fullscreen ? 80 : 32,
              }}
            >
              {fullscreen
                ? "Ask Gooni anything, or open a note to get feedback on it."
                : "Ask Gooni anything. Your active note is shared as context."}
            </div>
          );
        })()}
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
                    fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
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
                      fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
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
                fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
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
              fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
              fontStyle: "italic",
            }}
          >
            Gooni is thinking...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      )}

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
                fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
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
              fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
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
