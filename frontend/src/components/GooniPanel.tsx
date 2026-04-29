import { useRef, useState, useEffect, useCallback } from "react";
import { renderMarkdown } from "../utils/markdown";
import { extractOptions, extractPlanBlock, planMarkdownToHtml } from "../utils/planMarkdown";
import { fetchNote, updateNote } from "../services/api";
import { useGooniStore } from "../stores/useGooniStore";
import { useConversationsStore } from "../stores/useConversationsStore";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { ModelSelector } from "./ModelSelector";
import { ThinkingIndicator } from "./chat/ThinkingIndicator";

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
  // Override the persisted sidebar width — pass a fixed number (px) or a
  // CSS string. When set, the drag-to-resize handle is also disabled
  // (plan view locks the proportion so the note isn't crushed).
  dockedWidth?: number | string;
}

export function GooniPanel({ fullscreen = false, floating = false, planContext, dockedWidth }: GooniPanelProps) {
  const { width: storedWidth, setWidth } = useGooniStore();
  const width = dockedWidth ?? storedWidth;
  const { messages, sending, send } = useConversationsStore();
  const { notes, activeNoteId, selectedSpaceId } = useNotesContentStore();
  const [input, setInput] = useState("");
  const [savingPlan, setSavingPlan] = useState(false);
  const [savedPlanIds, setSavedPlanIds] = useState<Set<number>>(new Set());
  // Per-message map of "which option(s) the user picked" so chips can
  // render in a "selected" state (highlighted bg + border) instead of
  // disappearing or echoing the choice as a separate user bubble.
  const [pickedByMessage, setPickedByMessage] = useState<Record<number, string[]>>({});
  // Inline free-text editor for the "Other" chip — keyed by assistant
  // message id so multiple turns don't share state.
  const [otherEditingFor, setOtherEditingFor] = useState<number | null>(null);
  const [otherDraft, setOtherDraft] = useState("");

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
  // Records the pick so the chip renders selected, then sends the answer.
  // The "PLAN_PICK::" prefix lets the bubble renderer suppress this user
  // turn visually — the selected chip already shows the choice; an extra
  // "Daniel chose: X" bubble would be noise.
  async function handleOptionPick(messageId: number, option: string) {
    if (sending || !planContext) return;
    setPickedByMessage((prev) => ({
      ...prev,
      [messageId]: [...(prev[messageId] ?? []), option],
    }));
    await send(`PLAN_PICK::${option}`, planContext.noteContent, "plan");
  }

  // "Other" chip → inline text input; submits as a regular user message
  // so Gooni gets free-form context. Suppression prefix not used here —
  // we want Daniel's words visible since they aren't a chip label.
  function handleOtherStart(messageId: number) {
    setOtherEditingFor(messageId);
    setOtherDraft("");
  }
  async function handleOtherSubmit() {
    if (!planContext || !otherDraft.trim() || sending) return;
    const text = otherDraft.trim();
    setOtherEditingFor(null);
    setOtherDraft("");
    await send(text, planContext.noteContent, "plan");
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
    // Enter sends, Shift+Enter inserts a newline (standard chat UX).
    // Cmd+Enter still sends as a backup for muscle memory.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Drag-to-resize (only in sidebar mode, and only when width isn't
  // externally locked via dockedWidth — plan view, for example, fixes
  // the proportion so the note can't get crushed).
  const onDragMouseDown = useCallback((e: React.MouseEvent) => {
    if (fullscreen || dockedWidth != null) return;
    e.preventDefault();
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = storedWidth;

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
  }, [fullscreen, dockedWidth, storedWidth, setWidth]);

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
      {/* Drag handle — left edge, sidebar only (not in floating + not fullscreen
          and not when width is externally locked via dockedWidth). */}
      {!fullscreen && !floating && dockedWidth == null && (
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

      {/* Top toolbar — surface toggle (modal ↔ sidebar). Only shown when
          panel is open via the FAB (floating or sidebar through GooniLayer);
          plan view + fullscreen lock the layout so they skip it. */}
      {!fullscreen && !planContext && (
        <SurfaceToggleBar />
      )}

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
        {messages.map((m) => {
          // Synthetic chip-pick user turn — render nothing at all (no
          // wrapper either, otherwise we leak an empty flex item).
          if (m.role === "user" && m.content.startsWith("PLAN_PICK::")) return null;
          return (
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
              pickedOptions={pickedByMessage[m.id] ?? []}
              isOtherEditing={otherEditingFor === m.id}
              otherDraft={otherDraft}
              onOptionPick={handleOptionPick}
              onOtherStart={handleOtherStart}
              onOtherChange={setOtherDraft}
              onOtherSubmit={handleOtherSubmit}
              onOtherCancel={() => { setOtherEditingFor(null); setOtherDraft(""); }}
              onSavePlan={handleSavePlan}
            />
          </div>
          );
        })}
        {sending && (
          <ThinkingIndicator />
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

// Top-bar surface toggle (modal popup ↔ docked sidebar) + close button.
// Lives inside the panel so the user can flip surfaces and dismiss the
// chat without the FAB hovering over the input area.
function SurfaceToggleBar() {
  const surface = useGooniStore((s) => s.surface);
  const setSurface = useGooniStore((s) => s.setSurface);
  const toggle = useGooniStore((s) => s.toggle);
  const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";

  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "6px 10px",
        borderBottom: "1px solid rgba(0,0,0,0.06)",
        flexShrink: 0,
        fontFamily: FONT,
      }}
    >
      <span style={{ fontSize: 10.5, color: "#8E8E93", letterSpacing: 0.4, flex: 1 }}>
        Gooni
      </span>
      <div style={{
        display: "flex", border: "1px solid rgba(0,0,0,0.10)",
        borderRadius: 6, overflow: "hidden", background: "#fff",
      }}>
        {(["modal", "sidebar"] as const).map((s) => {
          const active = surface === s;
          return (
            <button
              key={s}
              onClick={() => setSurface(s)}
              title={s === "modal" ? "Floating bubble" : "Docked sidebar"}
              style={{
                fontSize: 10.5, padding: "3px 8px",
                background: active ? "#1C1C1E" : "#fff",
                color: active ? "#fff" : "#6E6E73",
                border: "none", cursor: "pointer",
                fontFamily: FONT, fontWeight: 500,
              }}
            >{s}</button>
          );
        })}
      </div>
      <button
        onClick={toggle}
        title="Close chat"
        aria-label="Close Gooni chat"
        style={{
          width: 22, height: 22, borderRadius: 6,
          border: "none", background: "transparent",
          color: "#8E8E93", cursor: "pointer",
          fontSize: 14, lineHeight: 1,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: FONT,
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
      >×</button>
    </div>
  );
}


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
  pickedOptions,
  isOtherEditing,
  otherDraft,
  onOptionPick,
  onOtherStart,
  onOtherChange,
  onOtherSubmit,
  onOtherCancel,
  onSavePlan,
}: {
  message: BubbleMsg;
  fullscreen: boolean;
  isPlanMode: boolean;
  isSavingPlan: boolean;
  isPlanSaved: boolean;
  pickedOptions: string[];
  isOtherEditing: boolean;
  otherDraft: string;
  onOptionPick: (messageId: number, option: string) => void;
  onOtherStart: (messageId: number) => void;
  onOtherChange: (text: string) => void;
  onOtherSubmit: () => void;
  onOtherCancel: () => void;
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

  // Hide synthetic chip-pick user turns: the selected chip already shows
  // the choice, an extra "you said: X" bubble is just noise.
  if (m.role === "user" && m.content.startsWith("PLAN_PICK::")) {
    return null;
  }

  if (m.role === "user" || !isPlanMode) {
    return <div style={baseStyle}>{renderMarkdown(m.content)}</div>;
  }

  // Plan-mode assistant: pull out finalize block first, then options.
  const { before, plan, after } = extractPlanBlock(m.content);

  // For the non-plan portion, extract option chips out of body lines.
  const headerText = plan ? before : m.content;
  const { body: parsedBody, options } = extractOptions(headerText);
  const trailingText = plan ? after : "";
  const hasPick = pickedOptions.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, maxWidth: fullscreen ? 640 : "88%" }}>
      {parsedBody && (
        <div style={baseStyle}>{renderMarkdown(parsedBody)}</div>
      )}
      {options.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {options.map((opt, i) => {
            const picked = pickedOptions.includes(opt);
            return (
              <button
                key={`${m.id}-opt-${i}`}
                onClick={() => onOptionPick(m.id, opt)}
                disabled={hasPick}
                style={{
                  fontSize: 12, fontFamily: baseStyle.fontFamily,
                  color: picked ? "#fff" : "#1C1C1E",
                  background: picked ? "#30A14E" : "rgba(74,222,128,0.10)",
                  border: picked
                    ? "0.5px solid #30A14E"
                    : "0.5px solid rgba(74,222,128,0.45)",
                  borderRadius: 999, padding: "4px 12px",
                  cursor: hasPick ? "default" : "pointer",
                  opacity: hasPick && !picked ? 0.45 : 1,
                  transition: "background 0.15s, color 0.15s, opacity 0.15s",
                }}
              >
                {picked ? `✓ ${opt}` : opt}
              </button>
            );
          })}
          {/* "Other" chip — opens an inline text input so Daniel can answer
              freely when none of the options fit. Only offered before any
              chip pick on this message; once picked, the panel is locked. */}
          {!hasPick && !isOtherEditing && (
            <button
              onClick={() => onOtherStart(m.id)}
              style={{
                fontSize: 12, fontFamily: baseStyle.fontFamily,
                color: "#6B6B70",
                background: "transparent",
                border: "0.5px dashed rgba(0,0,0,0.20)",
                borderRadius: 999, padding: "4px 12px",
                cursor: "pointer",
              }}
            >Other…</button>
          )}
        </div>
      )}
      {isOtherEditing && (
        <div style={{ display: "flex", gap: 6, width: "100%" }}>
          <input
            autoFocus
            value={otherDraft}
            onChange={(e) => onOtherChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); onOtherSubmit(); }
              if (e.key === "Escape") onOtherCancel();
            }}
            placeholder="type your answer…"
            style={{
              flex: 1, fontSize: 12, fontFamily: baseStyle.fontFamily,
              padding: "6px 10px", borderRadius: 999,
              border: "0.5px solid rgba(0,0,0,0.20)", background: "#fff",
              color: "#1C1C1E",
            }}
          />
          <button
            onClick={onOtherSubmit}
            style={{
              fontSize: 12, fontFamily: baseStyle.fontFamily,
              color: "#fff", background: "#1C1C1E",
              border: "none", borderRadius: 999, padding: "6px 14px",
              cursor: "pointer",
            }}
          >Send</button>
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
