import { useState } from "react";
import { renderMarkdown } from "../../utils/markdown";
import type { RouterSignals, MessageTraceStep } from "../../services/api";
import { color as ctok, FONT } from "../../ui";


const TOOL_LABELS: Record<string, string> = {
  web_search: "🔍 Searched the web",
  save_memory: "💾 Saved a memory",
  fetch_url: "🔗 Fetched a URL",
};

const TRACE_ICON: Record<MessageTraceStep["type"], string> = {
  intention: "⊙",
  memory_recall: "◇",
  tool_call: "▸",
  reply: "✎",
  pipeline_version: "⚙",
  master_prompt: "▤",
  extracted_signals: "⌖",
  memories_applied: "★",
  // ReAct loop (v6+). Plan = pre-reply intent. Verify = post-reply audit
  // check. Like Claude's reasoning UI — surfaces in the collapsible.
  plan: "◎",
  verify: "✓",
};

interface MessageBubbleProps {
  message: {
    id: number;
    role: "user" | "assistant";
    content: string;
    intention?: string;
    tools_used?: string[];
    signals?: RouterSignals;
    trace?: MessageTraceStep[] | null;
  };
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const [expanded, setExpanded] = useState(false);
  const [signalsExpanded, setSignalsExpanded] = useState(false);
  const [traceExpanded, setTraceExpanded] = useState(false);

  // Unified trace overrides the legacy intention/tools_used/signals visuals.
  // Older messages stored before the trace column was wired fall back below.
  const trace = message.trace && message.trace.length > 0 ? message.trace : null;

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
      {!isUser && trace && (
        <div style={{ marginBottom: 6, maxWidth: "80%" }}>
          <button
            onClick={() => setTraceExpanded((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "2px 0",
              color: "var(--gooni-muted, #6B7280)",
              fontSize: 12.5,
              fontFamily: FONT,
              fontWeight: 500,
            }}
          >
            <span>Reasoning</span>
            <span style={{ fontSize: 10 }}>{traceExpanded ? "▾" : "▸"}</span>
            <span style={{ fontSize: 11, color: ctok.muted }}>
              · {trace.length} step{trace.length === 1 ? "" : "s"}
            </span>
          </button>
          {traceExpanded && (
            <div
              style={{
                marginTop: 6,
                paddingLeft: 4,
                borderLeft: "1px solid rgba(0,0,0,0.08)",
                fontFamily: FONT,
              }}
            >
              {trace.map((step, idx) => (
                <TraceStep key={idx} step={step} />
              ))}
            </div>
          )}
        </div>
      )}
      {!isUser && !trace && !!message.tools_used?.length && (
        <div style={{ marginBottom: 4 }}>
          {message.tools_used.map((tool) => (
            <div
              key={tool}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 0",
                color: ctok.faint,
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
      {!isUser && !trace && message.intention && (
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
              color: ctok.faint,
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
                <span style={{ color: ctok.faint, fontSize: 13, marginTop: 1 }}>⊙</span>
                <span style={{ fontSize: 12.5, color: "var(--gooni-muted, #636366)", lineHeight: 1.5 }}>{message.intention}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: "#34C759", fontSize: 13 }}>✓</span>
                <span style={{ fontSize: 12, color: ctok.faint }}>Done</span>
              </div>
            </div>
          )}
        </div>
      )}
      {!isUser && !trace && signals && (
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
              color: ctok.faint,
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
                color: "var(--gooni-muted, #636366)",
                lineHeight: 1.5,
              }}
            >
              {signals.tone_corrections.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", color: ctok.muted, marginBottom: 2 }}>
                    Tone — preference memory
                  </div>
                  {signals.tone_corrections.map((t, i) => (
                    <div key={i}>· {t.rule}</div>
                  ))}
                </div>
              )}
              {signals.feature_requests.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", color: ctok.muted, marginBottom: 2 }}>
                    Feature request — Gooni Backlog
                  </div>
                  {signals.feature_requests.map((f, i) => (
                    <div key={i}>· {f.title}{f.why ? ` — ${f.why}` : ""}</div>
                  ))}
                </div>
              )}
              {signals.memory_count > 0 && (
                <div>
                  <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", color: ctok.muted, marginBottom: 2 }}>
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
          background: isUser ? ctok.text : ctok.hover,
          color: isUser ? "#FFFFFF" : ctok.text,
          fontSize: 14,
          fontFamily: FONT,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {renderMarkdown(message.content)}
      </div>
      {!isUser && trace && <ActionCards trace={trace} />}
    </div>
  );
}

// Inline action chips below the reply bubble — structured confirmation
// of what the router actually captured this turn. Todos died in the
// Slice 6 nuke; promises are the surviving router capture worth chipping.
function ActionCards({ trace }: { trace: MessageTraceStep[] }) {
  const cards: { icon: string; text: string }[] = [];
  for (const step of trace) {
    // TraceBuilder canonical: tool calls land with `type: "tool_call"`
    // and `key` carrying the router event name (router:promise etc.).
    // Fall back to label for older trace shapes.
    if (step.type !== "tool_call") continue;
    const name = (step.key || step.label || "").toString();
    const args = (step.args || {}) as Record<string, unknown>;
    const text =
      typeof args.text === "string" ? args.text :
      typeof args.match === "string" ? args.match :
      "";
    if (name !== "router:promise" || !text) continue;
    const utt = typeof args.utterance === "string" ? args.utterance : text;
    cards.push({ icon: "🤝", text: trim(utt) });
  }
  if (cards.length === 0) return null;
  return (
    <div style={{
      display: "flex", flexWrap: "wrap", gap: 6,
      marginTop: 8, maxWidth: "80%",
    }}>
      {cards.slice(0, 6).map((c, i) => (
        <span
          key={i}
          style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "3px 8px", borderRadius: 99,
            background: "rgba(15,23,42,0.06)", color: "#0F172A",
            fontSize: 11.5, fontFamily: FONT, fontWeight: 500,
            border: "0.5px solid rgba(15,23,42,0.08)",
            maxWidth: 280,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
          title={c.text}
        >
          <span style={{ opacity: 0.7 }}>{c.icon}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{c.text}</span>
        </span>
      ))}
      {cards.length > 6 && (
        <span style={{
          padding: "3px 8px", borderRadius: 99,
          fontSize: 11, color: ctok.muted,
        }}>
          +{cards.length - 6} more
        </span>
      )}
    </div>
  );
}

function trim(s: string, n = 48): string {
  s = (s || "").trim();
  return s.length <= n ? s : s.slice(0, n).trimEnd() + "…";
}

function TraceStep({ step }: { step: MessageTraceStep }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!step.detail || (step.args && Object.keys(step.args).length > 0);
  return (
    <div style={{ padding: "4px 0 4px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
      <button
        onClick={() => hasDetail && setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          background: "none", border: "none",
          cursor: hasDetail ? "pointer" : "default",
          padding: 0, fontFamily: FONT, color: ctok.text,
          fontSize: 12.5, lineHeight: 1.4, textAlign: "left",
        }}
      >
        <span style={{ color: ctok.muted, fontSize: 11, width: 14, flexShrink: 0 }}>
          {TRACE_ICON[step.type]}
        </span>
        <span>{step.label}</span>
        {hasDetail && (
          <span style={{ fontSize: 9, color: ctok.muted }}>{open ? "▾" : "▸"}</span>
        )}
      </button>
      {open && step.detail && (
        <div
          style={{
            marginLeft: 22,
            fontSize: 12, color: "var(--gooni-muted, #636366)", lineHeight: 1.5,
            background: "rgba(0,0,0,0.03)",
            padding: "6px 10px", borderRadius: 6,
            wordBreak: "break-word",
          }}
        >
          {step.detail}
        </div>
      )}
      {open && step.args && Object.keys(step.args).length > 0 && (
        <div
          style={{
            marginLeft: 22,
            fontSize: 11, color: ctok.muted, lineHeight: 1.5,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          {Object.entries(step.args).map(([k, v]) => (
            <div key={k}>{k}: {String(v)}</div>
          ))}
        </div>
      )}
    </div>
  );
}
