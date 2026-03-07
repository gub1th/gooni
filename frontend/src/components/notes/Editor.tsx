import { useEffect, useRef, useState } from "react"; // useRef kept for messagesEndRef
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useNotesStore } from "../../stores/notesStore";
import type { FeedItem, Message } from "../../types/notes";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  if (isToday) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  }
  if (isYesterday) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── InlineConversation ────────────────────────────────────────────────────────

interface InlineConversationProps {
  entry: FeedItem;
  messages: Message[];
  sending: boolean;
  onSendMessage: (content: string) => Promise<void>;
}

function InlineConversation({ entry, messages, sending, onSendMessage }: InlineConversationProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    await onSendMessage(text);
  }

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(0,0,0,0.06)" }}>
      {entry.type === "note" && entry.content && (
        <div style={{
          fontSize: 12,
          color: "#536471",
          marginBottom: 8,
          padding: "6px 10px",
          background: "rgba(0,0,0,0.03)",
          borderRadius: 8,
          fontStyle: "italic",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
        }}>
          {entry.content}
        </div>
      )}

      <div style={{ maxHeight: 240, overflowY: "auto", marginBottom: 8 }}>
        {messages.length === 0 && !sending && (
          <div style={{ color: "#94a3b8", fontSize: 13, padding: "4px 0", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>
            Ask Claude about this...
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} style={{ marginBottom: 8, display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{
              maxWidth: "85%",
              padding: "8px 12px",
              borderRadius: 12,
              fontSize: 14,
              lineHeight: 1.5,
              background: m.role === "user" ? "#1d9bf0" : "rgba(0,0,0,0.05)",
              color: m.role === "user" ? "#fff" : "#0f1419",
              whiteSpace: "pre-wrap",
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            }}>
              {m.content}
            </div>
          </div>
        ))}
        {sending && (
          <div style={{ color: "#94a3b8", fontSize: 13, padding: "2px 0", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>
            Claude is thinking...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey) { e.preventDefault(); handleSend(); }
          }}
          placeholder="Reply... (⌘↵ to send)"
          rows={1}
          style={{
            flex: 1, resize: "none",
            border: "1px solid rgba(0,0,0,0.12)", borderRadius: 20,
            padding: "8px 14px", fontSize: 14,
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            outline: "none", background: "#f7f9f9", color: "#0f1419",
          }}
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || sending}
          style={{
            padding: "8px 18px", borderRadius: 20, border: "none",
            background: input.trim() && !sending ? "#1d9bf0" : "rgba(0,0,0,0.06)",
            color: input.trim() && !sending ? "#fff" : "#94a3b8",
            fontSize: 14, fontWeight: 600, cursor: input.trim() && !sending ? "pointer" : "default",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

// ── FeedEntryRow ──────────────────────────────────────────────────────────────

interface FeedEntryProps {
  entry: FeedItem;
  isExpanded: boolean;
  isActiveEdit: boolean;
  messages: Message[];
  sendingFor: number | null;
  onDiscuss: () => void;
  onToggleConversation: () => void;
  onSendMessage: (content: string) => Promise<void>;
}

function FeedEntryRow({ entry, isExpanded, isActiveEdit, messages, sendingFor, onDiscuss, onToggleConversation, onSendMessage }: FeedEntryProps) {
  const isConversation = entry.type === "conversation";
  const content = isConversation ? (entry.title ?? "Untitled conversation") : entry.content;

  return (
    <div
      style={{
        padding: "14px 32px",
        borderBottom: "1px solid rgba(0,0,0,0.07)",
        background: isActiveEdit ? "rgba(29,155,240,0.04)" : "transparent",
        cursor: isConversation ? "pointer" : "default",
        transition: "background 0.1s",
      }}
      onClick={isConversation ? onToggleConversation : undefined}
      onMouseEnter={(e) => { if (!isActiveEdit) (e.currentTarget as HTMLDivElement).style.background = "#f7f9f9"; }}
      onMouseLeave={(e) => { if (!isActiveEdit) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
    >
      {/* Content */}
      <div style={{
        fontSize: 15,
        color: "#0f1419",
        lineHeight: 1.55,
        marginBottom: 10,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}>
        {isConversation && <span style={{ marginRight: 6, opacity: 0.6, fontSize: 13 }}>💬</span>}
        {content}
      </div>

      {/* Meta row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{
          fontSize: 13,
          color: "#536471",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
        }}>
          {formatTimestamp(entry.created_at)}
        </span>
        {!isConversation && (
          <span
            onClick={(e) => { e.stopPropagation(); onDiscuss(); }}
            style={{
              fontSize: 13,
              color: "#1d9bf0",
              cursor: "pointer",
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            }}
          >
            Discuss ↗
          </span>
        )}
      </div>

      {isExpanded && (
        <InlineConversation
          entry={entry}
          messages={messages}
          sending={sendingFor === entry.id}
          onSendMessage={onSendMessage}
        />
      )}
    </div>
  );
}

// ── Editor (main) ─────────────────────────────────────────────────────────────

export function Editor() {
  const {
    selectedSpaceId,
    feedEntries,
    messages,
    expandedEntryId,
    activeEditEntryId,
    loadFeed,
    submitNote,
    startConversation,
    seedConversation,
    updateEntry,
    loadMessages,
    sendMessage,
    setExpandedEntry,
    setActiveEditEntry,
  } = useNotesStore();

  const [sendingFor, setSendingFor] = useState<number | null>(null);

  // Derive goalId from selectedSpaceId
  const selectedGoalId = (() => {
    if (!selectedSpaceId?.startsWith("goal-")) return null;
    return parseInt(selectedSpaceId.replace("goal-", ""), 10) || null;
  })();

  const isBackendSpace = selectedSpaceId?.startsWith("goal-");
  const entries = (selectedSpaceId ? feedEntries[selectedSpaceId] : undefined) ?? [];
  const activeEditEntry = activeEditEntryId != null
    ? entries.find((e) => e.id === activeEditEntryId) ?? null
    : null;

  // Inject ProseMirror styles once
  useEffect(() => {
    if (document.querySelector("style[data-gooni-editor]")) return;
    const style = document.createElement("style");
    style.setAttribute("data-gooni-editor", "true");
    style.textContent = `
      .ProseMirror { outline: none; }
      .ProseMirror p { margin: 0 0 4px; }
      .ProseMirror ul, .ProseMirror ol { padding-left: 20px; margin: 0; }
      .ProseMirror > p:first-child:empty::before {
        content: "What's on your mind?";
        color: #aab8c2;
        pointer-events: none;
        float: left;
        height: 0;
      }
    `;
    document.head.appendChild(style);
  }, []);

  // Load feed when space changes
  useEffect(() => {
    if (selectedSpaceId) {
      loadFeed(selectedSpaceId, selectedGoalId ?? undefined);
    }
  }, [selectedSpaceId]);

  // ── Compose editor ──────────────────────────────────────────────────────────

  const composeEditor = useEditor(
    {
      extensions: [StarterKit],
      content: "",
      editorProps: {
        attributes: {
          style: [
            "font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            "font-size: 18px",
            "line-height: 1.6",
            "color: #0f1419",
            "outline: none",
            "min-height: 60px",
          ].join("; "),
        },
      },
    },
    [selectedSpaceId]
  );

  // ── Save logic (ref so the DOM listener always has fresh values) ─────────────
  const handleSaveRef = useRef<() => void>(() => {});
  handleSaveRef.current = () => {
    const text = composeEditor?.state.doc.textContent.trim() ?? "";
    if (!text) return;
    if (activeEditEntryId != null) {
      updateEntry(activeEditEntryId, text);
      setActiveEditEntry(null);
    } else {
      submitNote(selectedSpaceId!, selectedGoalId, text);
    }
    composeEditor?.commands.clearContent();
  };

  // Native DOM listener on the actual editor element — most reliable
  useEffect(() => {
    const el = composeEditor?.view?.dom;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && e.metaKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        handleSaveRef.current();
      }
    };
    el.addEventListener("keydown", onKey, true);
    return () => el.removeEventListener("keydown", onKey, true);
  }, [composeEditor]);

  // When switching to edit mode, load entry content into editor
  useEffect(() => {
    if (activeEditEntry && composeEditor) {
      const content = activeEditEntry.type === "note" ? activeEditEntry.content : "";
      composeEditor.commands.setContent(content);
      composeEditor.commands.focus("end");
    } else if (!activeEditEntry && composeEditor) {
      composeEditor.commands.clearContent();
    }
  }, [activeEditEntryId]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handleDiscuss(entry: FeedItem) {
    if (entry.type !== "note") return;
    const conv = await startConversation(selectedSpaceId!, selectedGoalId, entry.content);
    if (conv && conv.type === "conversation") {
      setSendingFor(conv.id);
      await seedConversation(conv.id, selectedGoalId);
      setSendingFor(null);
    }
  }

  async function handleToggleConversation(entry: FeedItem) {
    if (entry.type !== "conversation") return;
    if (expandedEntryId === entry.id) {
      setExpandedEntry(null);
    } else {
      setExpandedEntry(entry.id);
      if (!messages[entry.id]) await loadMessages(entry.id);
    }
  }

  async function handleSendInConversation(entryId: number, content: string) {
    setSendingFor(entryId);
    await sendMessage(entryId, content, selectedGoalId);
    setSendingFor(null);
  }

  const isEditMode = activeEditEntryId != null;

  return (
    <div style={{ flex: 1, height: "100vh", backgroundColor: "#FFFFFF", display: "flex", flexDirection: "column", overflow: "hidden" }}>

      {/* ── Compose area ─────────────────────────────────────────────────────── */}
      <div style={{ flexShrink: 0, padding: "20px 32px 16px", borderBottom: "1px solid rgba(0,0,0,0.08)", boxSizing: "border-box" }}>
        {isEditMode && (
          <div style={{ fontSize: 12, color: "#536471", marginBottom: 8, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>
            <span
              onClick={() => { setActiveEditEntry(null); composeEditor?.commands.clearContent(); }}
              style={{ color: "#f4212e", cursor: "pointer" }}
            >
              ✕ Cancel edit
            </span>
          </div>
        )}

        <div
          onKeyDownCapture={(e) => {
            if (!e.metaKey || e.key !== "Enter") return;
            e.preventDefault();
            const text = composeEditor?.state.doc.textContent.trim() ?? "";
            if (!text) return;
            if (e.shiftKey) {
              if (!isBackendSpace) return;
              startConversation(selectedSpaceId!, selectedGoalId, text).then((item) => {
                if (item?.type === "conversation") {
                  setSendingFor(item.id);
                  seedConversation(item.id, selectedGoalId).then(() => setSendingFor(null));
                }
              });
            } else {
              if (activeEditEntryId != null) {
                updateEntry(activeEditEntryId, text);
                setActiveEditEntry(null);
              } else {
                submitNote(selectedSpaceId!, selectedGoalId, text);
              }
            }
            composeEditor?.commands.clearContent();
          }}
        >
          <EditorContent editor={composeEditor} />
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
          <span style={{ fontSize: 12, color: "#aab8c2", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>
            {isEditMode ? "⌘↵ save edit" : isBackendSpace ? "⌘↵ · ⌘⇧↵ discuss" : ""}
          </span>
          <button
            onClick={() => handleSaveRef.current()}
            style={{
              padding: "7px 20px",
              borderRadius: 20,
              border: "none",
              background: "#0f1419",
              color: "#fff",
              fontSize: 14,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
              letterSpacing: "-0.1px",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "#272c30")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "#0f1419")}
          >
            {isEditMode ? "Save" : "Post"}
          </button>
        </div>
      </div>

      {/* ── Feed ─────────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {entries.length === 0 && (
          <div style={{ padding: "32px", textAlign: "center", color: "#aab8c2", fontSize: 14, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>
            No notes yet. Start writing above.
          </div>
        )}
        {entries.map((entry) => (
          <FeedEntryRow
            key={entry.id}
            entry={entry}
            isExpanded={expandedEntryId === entry.id}
            isActiveEdit={activeEditEntryId === entry.id}
            messages={messages[entry.id] ?? []}
            sendingFor={sendingFor}
            onDiscuss={() => handleDiscuss(entry)}
            onToggleConversation={() => handleToggleConversation(entry)}
            onSendMessage={(content) => handleSendInConversation(entry.id, content)}
          />
        ))}
      </div>
    </div>
  );
}
