import { useEffect, useMemo, useRef, useState } from "react";
import { useNotesStore } from "../stores/notesStore";
import { useJarvisStore } from "../stores/useJarvisStore";
import { useNotesContentStore } from "../stores/useNotesContentStore";

export function JarvisPanel() {
  const { isOpen, messages, sending, send, toggle } = useJarvisStore();
  const { selectedSpaceId } = useNotesStore();
  const { notes, activeNoteId } = useNotesContentStore();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const spaceId = selectedSpaceId || "general";
  const activeNote = useMemo(
    () => (notes[spaceId] ?? []).find((n) => n.id === activeNoteId) ?? null,
    [notes, spaceId, activeNoteId]
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    await send(text, activeNote?.content ?? "");
  }

  if (!isOpen) return null;

  return (
    <div style={{ width: 300, height: "100%", background: "#fff", borderLeft: "1px solid rgba(0,0,0,0.08)", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid rgba(0,0,0,0.08)", display: "flex", justifyContent: "space-between" }}>
        <strong>Jarvis</strong>
        <button onClick={toggle} style={{ border: "none", background: "transparent", cursor: "pointer" }}>×</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {messages.map((msg) => (
          <div key={msg.id} style={{ textAlign: msg.role === "user" ? "right" : "left", marginBottom: 10 }}>
            <span style={{ display: "inline-block", padding: "8px 12px", borderRadius: 12, background: msg.role === "user" ? "#1d9bf0" : "#f1f5f9", color: msg.role === "user" ? "#fff" : "#111" }}>{msg.content}</span>
          </div>
        ))}
        {sending && <div style={{ fontSize: 13, color: "#94a3b8" }}>Jarvis is thinking...</div>}
        <div ref={messagesEndRef} />
      </div>
      <div style={{ padding: 12, borderTop: "1px solid rgba(0,0,0,0.08)", display: "flex", gap: 8 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="type... ⌘↵"
          rows={1}
          style={{ flex: 1, resize: "none" }}
        />
        <button onClick={handleSend} disabled={!input.trim() || sending}>→</button>
      </div>
    </div>
  );
}
