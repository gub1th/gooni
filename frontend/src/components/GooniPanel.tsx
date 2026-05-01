import { useRef, useState, useEffect, useCallback } from "react";
import { renderMarkdown } from "../utils/markdown";
import { extractOptions, extractPlanBlock, planMarkdownToHtml } from "../utils/planMarkdown";
import { fetchNote, updateNote } from "../services/api";
import { displayTitle } from "../utils/notePreview";
import { useGooniStore } from "../stores/useGooniStore";
import { useGooniModalCornerStore } from "../stores/useGooniModalCornerStore";
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

  // ── Mic input via the browser's Web Speech API ─────────────────────────────
  // No server, no extra deps: webkitSpeechRecognition (Chrome/Safari) or
  // SpeechRecognition (Firefox flag). When unsupported we still render the
  // mic icon but the click no-ops with a tooltip — degrades gracefully.
  const recognitionRef = useRef<unknown>(null);
  const [listening, setListening] = useState(false);
  const speechSupported = typeof window !== "undefined" && (
    "SpeechRecognition" in window || "webkitSpeechRecognition" in window
  );

  useEffect(() => {
    return () => {
      // Cleanup on unmount — kill any active recognition session.
      const r = recognitionRef.current as { stop?: () => void } | null;
      r?.stop?.();
    };
  }, []);

  function startListening() {
    if (!speechSupported || listening) return;
    const Ctor = (window as unknown as {
      SpeechRecognition?: new () => unknown;
      webkitSpeechRecognition?: new () => unknown;
    }).SpeechRecognition ?? (window as unknown as {
      webkitSpeechRecognition?: new () => unknown;
    }).webkitSpeechRecognition;
    if (!Ctor) return;
    const r = new Ctor() as {
      continuous: boolean;
      interimResults: boolean;
      lang: string;
      onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>>; resultIndex: number }) => void;
      onend: () => void;
      onerror: () => void;
      start: () => void;
      stop: () => void;
    };
    r.continuous = false;        // single utterance — like ChatGPT
    r.interimResults = true;
    r.lang = "en-US";
    let finalText = "";
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i] as ArrayLike<{ transcript: string }> & { isFinal?: boolean };
        const isFinal = (res as { isFinal?: boolean }).isFinal;
        const txt = res[0]?.transcript || "";
        if (isFinal) finalText += txt;
        else interim += txt;
      }
      // Live-append into the textarea — preserve anything user typed first.
      setInput((prev) => {
        // Strip any prior interim suffix so we don't double-append on each tick.
        const base = prev.replace(/\s*​[^​]*​$/, "");
        const sep = base && !base.endsWith(" ") ? " " : "";
        return interim
          ? `${base}${sep}​${finalText}${interim}​`
          : `${base}${sep}${finalText}`;
      });
    };
    r.onend = () => {
      setListening(false);
      // Strip the interim sentinels on close — leaves just the final text.
      setInput((prev) => prev.replace(/​/g, ""));
      recognitionRef.current = null;
    };
    r.onerror = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = r;
    setListening(true);
    r.start();
  }

  function stopListening() {
    const r = recognitionRef.current as { stop?: () => void } | null;
    r?.stop?.();
    setListening(false);
  }

  const hasInput = input.trim().length > 0;

  // Empty-state starter prompts — clicking one drops the text into the
  // composer focused so Daniel can edit before sending.
  const STARTER_PROMPTS = [
    "Help me plan my next steps",
    "What am I missing here?",
    "Summarize this for me",
  ];

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
        background: "var(--gooni-card, #FFFFFF)",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        position: "relative",
      }
    : fullscreen
    ? {
        flex: 1,
        height: "100vh",
        background: "var(--gooni-card, #FFFFFF)",
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
        background: "var(--gooni-card, #FFFFFF)",
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

      {/* Top header — character icon + title + kebab menu (surface
          toggles + reset-position) + close. Skipped for fullscreen, which
          has its own header. */}
      {!fullscreen && (
        <ChatHeader />
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
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: fullscreen ? "32px 24px 80px" : "32px 24px",
              textAlign: "center",
              fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
            }}
          >
            <div style={{ marginBottom: 16 }}>
              <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
                <circle cx="32" cy="32" r="28" fill="#4ADE80" opacity="0.12" />
                <circle cx="32" cy="30" r="14" fill="#1a1a1a" />
                <circle cx="32" cy="30" r="10" fill="#f2f2f2" />
                <circle cx="28" cy="28" r="2" fill="#1a1a1a" />
                <circle cx="36" cy="28" r="2" fill="#1a1a1a" />
                <path d="M28 33 Q32 35 36 33" stroke="#1a1a1a" strokeWidth="1.5" fill="none" strokeLinecap="round" />
                <rect x="24" y="42" width="16" height="12" rx="4" fill="#4ADE80" />
              </svg>
            </div>
            <div style={{ fontSize: 15, fontWeight: 500, color: "#1C1C1E", marginBottom: 6 }}>
              Ask me anything
            </div>
            <div style={{ fontSize: 13, color: "#8E8E93", lineHeight: 1.5, marginBottom: 20, maxWidth: 280 }}>
              {activeNote
                ? "Your active note is shared as context. I can help you expand, clarify, or plan."
                : "I'll use whatever note you open as context. Or just chat."}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%", maxWidth: 320 }}>
              {STARTER_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => setInput(prompt)}
                  style={{
                    padding: "10px 14px",
                    border: "0.5px solid rgba(0,0,0,0.10)",
                    borderRadius: 8,
                    background: "rgba(0,0,0,0.025)",
                    textAlign: "left",
                    fontSize: 13,
                    color: "#3C3C43",
                    cursor: "pointer",
                    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                    transition: "background 0.15s, border-color 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = "#4ADE80";
                    (e.currentTarget as HTMLButtonElement).style.background = "rgba(74,222,128,0.06)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(0,0,0,0.10)";
                    (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.025)";
                  }}
                >
                  {prompt}
                </button>
              ))}
            </div>
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
                    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
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
                      border: "1px solid var(--gooni-border, rgba(0,0,0,0.07))",
                      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
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

      {/* Input area — divider above the composer was dropped (mockup A);
          the composer's own border carries the visual separation. */}
      <div
        style={{
          padding: "8px 16px 16px",
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
              border: "1px solid var(--gooni-border, rgba(0,0,0,0.07))",
              width: "fit-content",
              maxWidth: "100%",
            }}
          >
            <span style={{ fontSize: 12 }}>📄</span>
            <span
              style={{
                fontSize: 12,
                color: "#636366",
                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {displayTitle(activeNote, "Untitled note")}
            </span>
          </div>
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            background: "#FFFFFF",
            borderRadius: 14,
            padding: "10px 12px",
            border: "0.5px solid rgba(0,0,0,0.12)",
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Gooni…"
            rows={2}
            style={{
              width: "100%",
              resize: "none",
              border: "none",
              padding: 0,
              fontSize: 14,
              fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
              outline: "none",
              background: "transparent",
              color: "var(--gooni-text, #1C1C1E)",
              lineHeight: 1.45,
            }}
          />
          {/* Composer footer — model selector flush left of the action button.
              Action morphs from mic (idle) → terracotta send (typing) so the
              same slot always carries the primary action (matches Claude).
              Web Speech API drives the mic; while listening, the icon turns
              red + the button click stops capture. */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <ModelSelector />
            {hasInput ? (
              <button
                onClick={handleSend}
                disabled={sending}
                title="Send (⌘↵)"
                aria-label="Send message"
                style={{
                  width: 30, height: 30,
                  borderRadius: 8,
                  border: "none",
                  background: sending ? "rgba(0,0,0,0.10)" : "#D26B3F",
                  color: "#FFFFFF",
                  cursor: sending ? "default" : "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                  boxShadow: sending ? "none" : "0 1px 3px rgba(210,107,63,0.35)",
                  transition: "background 0.15s, box-shadow 0.15s, transform 0.12s",
                }}
                onMouseEnter={(e) => { if (!sending) (e.currentTarget as HTMLButtonElement).style.background = "#B95B33"; }}
                onMouseLeave={(e) => { if (!sending) (e.currentTarget as HTMLButtonElement).style.background = "#D26B3F"; }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 13V3" />
                  <path d="M3.5 7.5L8 3l4.5 4.5" />
                </svg>
              </button>
            ) : (
              <button
                onClick={listening ? stopListening : startListening}
                disabled={!speechSupported}
                title={
                  !speechSupported
                    ? "Voice input not supported in this browser"
                    : listening ? "Stop recording" : "Start voice input"
                }
                aria-label={listening ? "Stop recording" : "Start voice input"}
                style={{
                  width: 30, height: 30,
                  borderRadius: 8,
                  border: "none",
                  background: listening ? "#FF3B30" : "rgba(0,0,0,0.04)",
                  color: listening ? "#FFFFFF" : speechSupported ? "#3C3C43" : "#C7C7CC",
                  cursor: speechSupported ? "pointer" : "not-allowed",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                  transition: "background 0.15s, color 0.15s",
                }}
                onMouseEnter={(e) => {
                  if (!speechSupported || listening) return;
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.08)";
                }}
                onMouseLeave={(e) => {
                  if (!speechSupported || listening) return;
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="6" y="2" width="4" height="8" rx="2" />
                  <path d="M3 8a5 5 0 0 0 10 0" />
                  <path d="M8 13v2" />
                </svg>
              </button>
            )}
          </div>
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

// Top-bar header — character icon + "Chat with Gooni" title, close X, and
// an overflow menu for surface (modal/sidebar) + reset-position. Pulled
// out of the inline pill toggle into a kebab popup so the bar stays clean
// even when both modes + reset are available.
function ChatHeader() {
  const surface = useGooniStore((s) => s.surface);
  const setSurface = useGooniStore((s) => s.setSurface);
  const toggle = useGooniStore((s) => s.toggle);
  const pos = useGooniModalCornerStore((s) => s.pos);
  const resetPos = useGooniModalCornerStore((s) => s.reset);
  const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
  const isCustomPosition = surface === "modal" && pos !== null;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click + Escape — same pattern as ModelSelector.
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Single render path for menu items so icons + label + click all stay in sync.
  const menuItems: { id: string; icon: React.ReactNode; label: string; onClick: () => void; active: boolean; show: boolean }[] = [
    {
      id: "modal",
      icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M5 6h6M5 9h4" /></svg>,
      label: "Floating bubble",
      onClick: () => { setSurface("modal"); setMenuOpen(false); },
      active: surface === "modal",
      show: true,
    },
    {
      id: "sidebar",
      icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M6 2v12" /></svg>,
      label: "Docked sidebar",
      onClick: () => { setSurface("sidebar"); setMenuOpen(false); },
      active: surface === "sidebar",
      show: true,
    },
    {
      id: "reset",
      icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9L13 3v3.5H9.5" /><path d="M13.5 8a5.5 5.5 0 0 1-9.4 3.9L3 13v-3.5h3.5" /></svg>,
      label: "Reset position",
      onClick: () => { resetPos(); setMenuOpen(false); },
      active: false,
      show: isCustomPosition,
    },
  ];

  return (
    <div
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 14px",
        borderBottom: "0.5px solid rgba(0,0,0,0.08)",
        flexShrink: 0,
        fontFamily: FONT,
        userSelect: "none",
      }}
    >
      {/* Drag handle scoped to the title block ONLY — putting it on the
          whole header eats clicks on the kebab + close buttons. */}
      <div
        data-gooni-drag-handle={surface === "modal" ? "true" : undefined}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          flex: 1, minWidth: 0,
          cursor: surface === "modal" ? "grab" : "default",
          padding: "2px 0",
        }}
      >
        <div
          aria-hidden
          style={{
            width: 8, height: 8, borderRadius: "50%",
            background: "#4ADE80",
            boxShadow: "0 0 0 3px rgba(74,222,128,0.18)",
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--gooni-text, #1C1C1E)" }}>
          Chat with Gooni
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
        <div ref={menuRef} style={{ position: "relative" }}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            title="Chat options"
            aria-label="Chat options"
            style={{
              width: 26, height: 26, borderRadius: 6,
              border: "none", background: menuOpen ? "rgba(0,0,0,0.06)" : "transparent",
              color: "var(--gooni-muted, #8E8E93)", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => { if (!menuOpen) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)"; }}
            onMouseLeave={(e) => { if (!menuOpen) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" /></svg>
          </button>
          {menuOpen && (
            <div
              role="menu"
              style={{
                position: "absolute", top: "calc(100% + 6px)", right: 0,
                minWidth: 180,
                background: "var(--gooni-card, #fff)",
                border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
                borderRadius: 10,
                boxShadow: "0 10px 28px rgba(0,0,0,0.10), 0 1px 3px rgba(0,0,0,0.06)",
                padding: 4,
                zIndex: 1300,
              }}
            >
              {menuItems.filter((it) => it.show).map((it) => (
                <button
                  key={it.id}
                  role="menuitem"
                  onClick={it.onClick}
                  style={{
                    width: "100%",
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "7px 10px",
                    borderRadius: 6,
                    background: it.active ? "rgba(0,0,0,0.06)" : "transparent",
                    color: "var(--gooni-text, #1C1C1E)",
                    border: "none", cursor: "pointer",
                    fontSize: 13, fontFamily: FONT, fontWeight: 500,
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => { if (!it.active) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)"; }}
                  onMouseLeave={(e) => { if (!it.active) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                >
                  <span style={{ display: "inline-flex", color: "var(--gooni-muted, #8E8E93)" }}>{it.icon}</span>
                  <span style={{ flex: 1 }}>{it.label}</span>
                  {it.active && (
                    <span style={{ color: "#30A14E", fontSize: 14 }}>✓</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={toggle}
          title="Close chat"
          aria-label="Close Gooni chat"
          style={{
            width: 26, height: 26, borderRadius: 6,
            border: "none", background: "transparent",
            color: "var(--gooni-muted, #8E8E93)", cursor: "pointer",
            fontSize: 16, lineHeight: 1,
            display: "flex", alignItems: "center", justifyContent: "center",
            transition: "background 0.1s",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
        >×</button>
      </div>
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
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
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
              border: "0.5px solid rgba(0,0,0,0.20)", background: "var(--gooni-card, #fff)",
              color: "var(--gooni-text, #1C1C1E)",
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
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
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
          fontSize: 13, color: "var(--gooni-text, #1C1C1E)", lineHeight: 1.5,
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
            <span style={{ fontSize: 11.5, color: "var(--gooni-muted, #8E8E93)" }}>
              or keep editing — ask Gooni to revise
            </span>
          </>
        )}
      </div>
    </div>
  );
}
