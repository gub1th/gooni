import { useRef, useState, useEffect } from "react";
import { useJarvisStore } from "../stores/useJarvisStore";
import { useNotesContentStore } from "../stores/useNotesContentStore";

export function JarvisPanel() {
  const { messages, sending, toggle, send } = useJarvisStore();
  const { notes, activeNoteId, selectedSpaceId } = useNotesContentStore();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const spaceId = selectedSpaceId ?? "general";
  const activeNote = (notes[spaceId] ?? []).find((n) => n.id === activeNoteId) ?? null;

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    const noteContent = activeNote?.content ?? undefined;
    await send(text, noteContent);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div
      style={{
        width: 300,
        minWidth: 300,
        height: "100vh",
        background: "#FFFFFF",
        borderLeft: "1px solid rgba(0,0,0,0.08)",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "16px 16px 12px",
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
          Jarvis
        </span>
        <button
          onClick={toggle}
          title="Close Jarvis"
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
      </div>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 12px",
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
              marginTop: 32,
            }}
          >
            Ask Jarvis anything. Your active note is shared as context.
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
            <div
              style={{
                maxWidth: "88%",
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
            Jarvis is thinking...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div
        style={{
          padding: "8px 12px 12px",
          borderTop: "1px solid rgba(0,0,0,0.08)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Jarvis... (⌘↵)"
            rows={2}
            style={{
              flex: 1,
              resize: "none",
              border: "1px solid rgba(0,0,0,0.12)",
              borderRadius: 12,
              padding: "8px 12px",
              fontSize: 13.5,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
              outline: "none",
              background: "#F2F2F7",
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
      </div>
    </div>
  );
}
