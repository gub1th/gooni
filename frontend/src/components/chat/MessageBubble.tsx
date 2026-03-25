import { useState } from "react";

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";

const TOOL_LABELS: Record<string, string> = {
  web_search: "🔍 Searched the web",
  save_memory: "💾 Saved a memory",
  fetch_url: "🔗 Fetched a URL",
};

interface MessageBubbleProps {
  message: { id: number; role: "user" | "assistant"; content: string; intention?: string; tools_used?: string[] };
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: isUser ? "flex-end" : "flex-start",
        marginBottom: 12,
      }}
    >
      {!isUser && !!message.tools_used?.length && (
        <div style={{ marginBottom: 4 }}>
          {message.tools_used.map((tool) => (
            <div
              key={tool}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 0",
                color: "#AEAEB2",
                fontSize: 12,
                fontFamily: FONT,
              }}
            >
              <span>{TOOL_LABELS[tool] ?? tool}</span>
              <span style={{ color: "#34C759", fontSize: 11 }}>✓</span>
            </div>
          ))}
        </div>
      )}
      {!isUser && message.intention && (
        <div style={{ marginBottom: 4, maxWidth: "80%" }}>
          <button
            onClick={() => setExpanded((v) => !v)}
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
              fontFamily: FONT,
            }}
          >
            <span>Assessed your intention</span>
            <span style={{ fontSize: 10 }}>{expanded ? "▾" : "▸"}</span>
          </button>
          {expanded && (
            <div
              style={{
                marginTop: 4,
                padding: "8px 10px",
                borderRadius: 8,
                background: "rgba(0,0,0,0.03)",
                border: "1px solid rgba(0,0,0,0.07)",
                fontFamily: FONT,
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
                <span style={{ color: "#AEAEB2", fontSize: 13, marginTop: 1 }}>⊙</span>
                <span style={{ fontSize: 12.5, color: "#636366", lineHeight: 1.5 }}>{message.intention}</span>
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
          maxWidth: "80%",
          padding: "10px 14px",
          borderRadius: isUser ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
          background: isUser ? "#1C1C1E" : "#F2F2F7",
          color: isUser ? "#FFFFFF" : "#1C1C1E",
          fontSize: 14,
          fontFamily: FONT,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {message.content}
      </div>
    </div>
  );
}
