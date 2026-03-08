import { useEffect, useRef, useState } from "react";
import { useJarvisStore } from "../stores/useJarvisStore";
import { useNotesContentStore } from "../stores/useNotesContentStore";

export function JarvisPanel() {
  const { messages, sending, send } = useJarvisStore();
  const { notes, activeNoteId } = useNotesContentStore();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeNote = activeNoteId ? (notes.notes["1"] as any)?.find((n: any) => n.id === activeNoteId) : null;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;

    setInput("");
    await send(text, activeNote?.content);
  }

  if (!useJarvisStore.getState().isOpen) {
    return null;
  }

  return (
    <div style={{
      width: 300,
      height: "100vh",
      background: "#FFFFFF",
      borderLeft: "1px solid rgba(0,0,0,0.08)",
      display: "flex",
      flexDirection: "column",
      position: "absolute",
      right: 0,
      top: 0,
      boxShadow: "-4px 0px 12px rgba(0,0,0,0.1)",
    }}>
      {/* Header */}
      <div style={{
        padding: "16px 20px",
        borderBottom: "1px solid rgba(0,0,0,0.08)",
        background: "#F9FAFB",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: "#0f1419" }}>
            Jarvis
          </div>
          <button
            onClick={() => useJarvisStore.getState().toggle()}
            style={{
              padding: "4px 8px",
              border: "none",
              background: "transparent",
              color: "#8E8E93",
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            ×
          </button>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px" }}>
        {messages.length === 0 && !sending && (
          <div style={{
            color: "#94a3b8",
            fontSize: 13,
            padding: "4px 0",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif"
          }}>
            Ask me anything...
          </div>
        )}

        {messages.map((msg: any) => (
          <div
            key={msg.id}
            style={{
              marginBottom: 12,
              display: "flex",
              flexDirection: "column",
              alignItems: msg.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div style={{
              maxWidth: "85%",
              padding: "8px 12px",
              borderRadius: 12,
              fontSize: 14,
              lineHeight: 1.5,
              background: msg.role === "user" ? "#1d9bf0" : "rgba(0,0,0,0.05)",
              color: msg.role === "user" ? "#fff" : "#0f1419",
              whiteSpace: "pre-wrap",
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            }}>
              {msg.content}
            </div>
          </div>
        ))}

        {sending && (
          <div style={{
            color: "#94a3b8",
            fontSize: 13,
            padding: "2px 0",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif"
          }}>
            Jarvis is thinking...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: "16px",
        borderTop: "1px solid rgba(0,0,0,0.08)",
        background: "#F9FAFB",
      }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Type your message... (⌘↵ to send)"
            rows={1}
            style={{
              flex: 1,
              resize: "none",
              border: "1px solid rgba(0,0,0,0.12)",
              borderRadius: 20,
              padding: "8px 14px",
              fontSize: 14,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
              outline: "none",
              background: "#f7f9f9",
              color: "#0f1419",
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            style={{
              padding: "8px 18px",
              borderRadius: 20,
              border: "none",
              background: input.trim() && !sending ? "#1d9bf0" : "rgba(0,0,0,0.06)",
              color: input.trim() && !sending ? "#fff" : "#94a3b8",
              fontSize: 14,
              fontWeight: 600,
              cursor: input.trim() && !sending ? "pointer" : "default",
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
