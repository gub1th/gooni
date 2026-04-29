import { useRef, useState, useEffect, useCallback } from "react";
import { renderMarkdown } from "../utils/markdown";
import { extractOptions, extractPlanBlock, planMarkdownToHtml } from "../utils/planMarkdown";
import { fetchNote, updateNote } from "../services/api";
import { useGooniStore } from "../stores/useGooniStore";
import { useConversationsStore } from "../stores/useConversationsStore";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { ModelSelector } from "./ModelSelector";
import { ChatGraphView } from "./chat/ChatGraphView";

interface GooniPanelProps {
  fullscreen?: boolean;
  // New: panel rendered inside the floating shell anchored to the FAB.
  // Skips the drag-to-resize handle and uses 100% width/height of its parent.
  floating?: boolean;
  // When set, this panel is hosting a plan-mode session: every send uses
  // mode="plan" and entry_content=noteContent so the orchestrator engages
  // PLAN_MODE_PROMPT every turn (entry context isn't persisted in the
  // conversation, so it has to be re-injected on each call). Assistant
  // messages get parsed for `[ ] option` chips and `<plan>...</plan>`
  // finalize blocks; the latter renders a Save-to-note card.
  planContext?: {
    noteId: number;
    noteContent: string;
    onSaved?: () => void;
  };
}

export function GooniPanel({ fullscreen = false, floating = false, planContext }: GooniPanelProps) {
  const { width, setWidth } = useGooniStore();
  const { messages, sending, send, activeId } = useConversationsStore();
  const [viewMode, setViewMode] = useState<"chat" | "graph">("chat");
  const { notes, activeNoteId, selectedSpaceId } = useNotesContentStore();
  const [input, setInput] = useState("");
  const [savingPlan, setSavingPlan] = useState(false);
  const [savedPlanIds, setSavedPlanIds] = useState<Set<number>>(new Set());

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
    if (planContext) {
      await send(text, planContext.noteContent, "plan");
    } else {
      await send(text, activeNote?.content ?? undefined);
    }
  }

  // Click handler for option chips inside an assistant plan-mode message.
  async function handleOptionPick(option: string) {
    if (sending || !planContext) return;
    await send(`Daniel chose: ${option}`, planContext.noteContent, "plan");
  }

  // "Save to note" — appends the plan markdown (converted to TipTap HTML)
  // to the source note below an <hr/>, preserving the original body. We
  // refetch the note to avoid clobbering anything Daniel might have edited
  // in another tab while planning.
  async function handleSavePlan(messageId: number, planMd: string) {
    if (!planContext || savingPlan) return;
    setSavingPlan(true);
    try {
      const fresh = await fetchNote(planContext.noteId);
      const planHtml = planMarkdownToHtml(planMd);
      const merged = `${fresh.content ?? ""}<hr/>${planHtml}`.trim();
      await updateNote(planContext.noteId, fresh.title ?? "", merged);
      setSavedPlanIds((prev) => {
        const next = new Set(prev);
        next.add(messageId);
        return next;
      });
      planContext.onSaved?.();
    } catch (e) {
      console.error("save plan failed:", e);
    } finally {
      setSavingPlan(false);
    }
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
        {messages.length === 0 && (
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
            <AssistantOrUserBubble
              message={m}
              fullscreen={fullscreen}
              isPlanMode={Boolean(planContext)}
              isSavingPlan={savingPlan}
              isPlanSaved={savedPlanIds.has(m.id)}
              onOptionPick={handleOptionPick}
              onSavePlan={handleSavePlan}
            />
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


// ── Message bubble with plan-mode awareness ─────────────────────────────────
//
// Default: render the bubble exactly as before (markdown body in a chat
// bubble). Plan mode adds two parsers on top of assistant messages:
//   1. `<plan>...</plan>` blocks → render as a "finalized plan" card with
//      a Save-to-note button next to a Keep-editing dismissal.
//   2. `[ ] option text` lines → render below the body as clickable chips
//      that auto-send "Daniel chose: <opt>" so the conversation continues
//      without typing.
// Both parsers are pure-text: if the patterns don't appear, the message
// renders identically to a normal chat turn.

interface BubbleMsg {
  id: number;
  role: "user" | "assistant";
  content: string;
}

function AssistantOrUserBubble({
  message: m,
  fullscreen,
  isPlanMode,
  isSavingPlan,
  isPlanSaved,
  onOptionPick,
  onSavePlan,
}: {
  message: BubbleMsg;
  fullscreen: boolean;
  isPlanMode: boolean;
  isSavingPlan: boolean;
  isPlanSaved: boolean;
  onOptionPick: (option: string) => void;
  onSavePlan: (messageId: number, planMd: string) => void;
}) {
  const baseStyle: React.CSSProperties = {
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
  };

  if (m.role === "user" || !isPlanMode) {
    return <div style={baseStyle}>{renderMarkdown(m.content)}</div>;
  }

  // Plan-mode assistant: pull out finalize block first, then options.
  const { before, plan, after } = extractPlanBlock(m.content);

  // For the non-plan portion, extract option chips out of body lines.
  const headerText = plan ? before : m.content;
  const { body: parsedBody, options } = extractOptions(headerText);
  const trailingText = plan ? after : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, maxWidth: fullscreen ? 640 : "88%" }}>
      {parsedBody && (
        <div style={baseStyle}>{renderMarkdown(parsedBody)}</div>
      )}
      {options.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {options.map((opt, i) => (
            <button
              key={`${m.id}-opt-${i}`}
              onClick={() => onOptionPick(opt)}
              style={{
                fontSize: 12, fontFamily: baseStyle.fontFamily,
                color: "#1C1C1E",
                background: "rgba(74,222,128,0.10)",
                border: "0.5px solid rgba(74,222,128,0.45)",
                borderRadius: 999, padding: "4px 12px",
                cursor: "pointer",
              }}
              title={`Send "Daniel chose: ${opt}"`}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
      {plan && (
        <PlanFinalizeCard
          planMd={plan}
          isSaving={isSavingPlan}
          isSaved={isPlanSaved}
          onSave={() => onSavePlan(m.id, plan)}
        />
      )}
      {trailingText && (
        <div style={baseStyle}>{renderMarkdown(trailingText)}</div>
      )}
    </div>
  );
}

function PlanFinalizeCard({
  planMd, isSaving, isSaved, onSave,
}: {
  planMd: string;
  isSaving: boolean;
  isSaved: boolean;
  onSave: () => void;
}) {
  return (
    <div
      style={{
        background: "#FDFCFA",
        border: "1px solid rgba(74,222,128,0.45)",
        borderRadius: 12,
        padding: "12px 14px",
        fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
        display: "flex", flexDirection: "column", gap: 10,
        width: "100%",
      }}
    >
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        fontSize: 11, color: "#3A8C3F", letterSpacing: 0.5,
        textTransform: "uppercase", fontWeight: 600,
      }}>
        <span>📋</span><span>Plan ready</span>
      </div>
      <div
        style={{
          fontSize: 13, color: "#1C1C1E", lineHeight: 1.5,
          whiteSpace: "pre-wrap",
        }}
      >
        {renderMarkdown(planMd)}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {isSaved ? (
          <span style={{
            fontSize: 12, color: "#3A8C3F", fontWeight: 500,
          }}>✓ Saved to note</span>
        ) : (
          <>
            <button
              onClick={onSave}
              disabled={isSaving}
              style={{
                fontSize: 12, fontWeight: 500,
                color: "#fff", background: "#1C1C1E",
                border: "none", borderRadius: 8,
                padding: "6px 12px",
                cursor: isSaving ? "default" : "pointer",
                opacity: isSaving ? 0.6 : 1,
              }}
            >
              {isSaving ? "Saving…" : "Save to note"}
            </button>
            <span style={{ fontSize: 11.5, color: "#8E8E93" }}>
              or keep editing — ask Gooni to revise
            </span>
          </>
        )}
      </div>
    </div>
  );
}
