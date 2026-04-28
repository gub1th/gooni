import { useState } from "react";
import { renderMarkdown } from "../../utils/markdown";
import type { RouterSignals } from "../../services/api";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";

const TOOL_LABELS: Record<string, string> = {
  web_search: "🔍 Searched the web",
  save_memory: "💾 Saved a memory",
  fetch_url: "🔗 Fetched a URL",
};

interface MessageBubbleProps {
  message: {
    id: number;
    role: "user" | "assistant";
    content: string;
    intention?: string;
    tools_used?: string[];
    signals?: RouterSignals;
  };
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const [expanded, setExpanded] = useState(false);
  const [signalsExpanded, setSignalsExpanded] = useState(false);

  const signals = message.signals;
  const signalCounts = signals
    ? signals.tone_corrections.length + signals.feature_requests.length + signals.memory_count
    : 0;

  // Short headline for the router chip — what the unified extractor decided
  // about the user's last turn. Mirrors the "Assessed your intention" line.
  const routerLabel = signals && signalCounts > 0
    ? [
        signals.tone_corrections.length > 0 ? `tone (${signals.tone_corrections.length})` : null,
        signals.feature_requests.length > 0 ? `feature (${signals.feature_requests.length})` : null,
        signals.memory_count > 0 ? `memory (${signals.memory_count})` : null,
      ].filter(Boolean).join(" · ")
    : "no signals";

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
      {!isUser && signals && (
        <div style={{ marginBottom: 4, maxWidth: "80%" }}>
          <button
            onClick={() => setSignalsExpanded((v) => !v)}
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
            <span>Routed: {routerLabel}</span>
            <span style={{ fontSize: 10 }}>{signalsExpanded ? "▾" : "▸"}</span>
          </button>
          {signalsExpanded && (
            <div
              style={{
                marginTop: 4,
                padding: "8px 10px",
                borderRadius: 8,
                background: "rgba(0,0,0,0.03)",
                border: "1px solid rgba(0,0,0,0.07)",
                fontFamily: FONT,
                fontSize: 12.5,
                color: "#636366",
                lineHeight: 1.5,
              }}
            >
              {signals.tone_corrections.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", color: "#9CA3AF", marginBottom: 2 }}>
                    Tone — preference memory
                  </div>
                  {signals.tone_corrections.map((t, i) => (
                    <div key={i}>· {t.rule}</div>
                  ))}
                </div>
              )}
              {signals.feature_requests.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", color: "#9CA3AF", marginBottom: 2 }}>
                    Feature request — Gooni Backlog
                  </div>
                  {signals.feature_requests.map((f, i) => (
                    <div key={i}>· {f.title}{f.why ? ` — ${f.why}` : ""}</div>
                  ))}
                </div>
              )}
              {signals.memory_count > 0 && (
                <div>
                  <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", color: "#9CA3AF", marginBottom: 2 }}>
                    Memory candidates — reconciler
                  </div>
                  <div>· {signals.memory_count} candidate{signals.memory_count > 1 ? "s" : ""} extracted</div>
                </div>
              )}
              {signalCounts === 0 && <div>No router signals on this turn.</div>}
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
        {renderMarkdown(message.content)}
      </div>
    </div>
  );
}
