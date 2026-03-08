import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { useNotesStore } from "../../stores/notesStore";
import type { FeedItem, Message } from "../../types/notes";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
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
  messages: Message[];
  sending: boolean;
  onSendMessage: (content: string) => Promise<void>;
}

function InlineConversation({ messages, sending, onSendMessage }: InlineConversationProps) {
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
      <div style={{ maxHeight: 240, overflowY: "auto", marginBottom: 8 }}>
        {messages.length === 0 && !sending && (
          <div style={{ color: "#94a3b8", fontSize: 13, padding: "4px 0", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>
            Claude is thinking...
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
  messages: Message[];
  sendingFor: number | null;
  onToggle: () => void;
  onSendMessage: (content: string) => Promise<void>;
}

function FeedEntryRow({ entry, isExpanded, messages, sendingFor, onToggle, onSendMessage }: FeedEntryProps) {
  return (
    <div
      style={{
        padding: "14px 32px",
        borderBottom: "1px solid rgba(0,0,0,0.07)",
        cursor: "pointer",
        transition: "background 0.1s",
      }}
      onClick={onToggle}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "#f7f9f9"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
    >
      <div style={{
        fontSize: 15,
        color: "#0f1419",
        lineHeight: 1.55,
        marginBottom: 10,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}>
        <span style={{ marginRight: 6, opacity: 0.6, fontSize: 13 }}>💬</span>
        {entry.title ?? "Untitled conversation"}
      </div>

      <div style={{ display: "flex", alignItems: "center" }}>
        <span style={{
          fontSize: 13,
          color: "#536471",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
        }}>
          {formatTimestamp(entry.created_at)}
        </span>
      </div>

      {isExpanded && (
        <InlineConversation
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
    loadFeed,
    startConversation,
    seedConversation,
    loadMessages,
    sendMessage,
    setExpandedEntry,
  } = useNotesStore();

  const [sendingFor, setSendingFor] = useState<number | null>(null);

  const entries = (selectedSpaceId ? feedEntries[selectedSpaceId] : undefined) ?? [];

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
      loadFeed(selectedSpaceId);
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

  // ── Submit handler ──────────────────────────────────────────────────────────

  const handleSubmitRef = useRef<() => Promise<void>>(async () => {});
  handleSubmitRef.current = async () => {
    const text = composeEditor?.state.doc.textContent.trim() ?? "";
    if (!text || !selectedSpaceId) return;
    const item = await startConversation(selectedSpaceId, text);
    if (item?.type === "conversation") {
      setSendingFor(item.id);
      await seedConversation(item.id, text);
      setSendingFor(null);
    }
    composeEditor?.commands.clearContent();
  };

  // Native DOM listener — most reliable for catching ⌘↵ inside ProseMirror
  useEffect(() => {
    const el = composeEditor?.view?.dom;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        handleSubmitRef.current().catch(console.error);
      }
    };
    el.addEventListener("keydown", onKey, true);
    return () => el.removeEventListener("keydown", onKey, true);
  }, [composeEditor]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handleToggle(entry: FeedItem) {
    if (expandedEntryId === entry.id) {
      setExpandedEntry(null);
      setSendingFor(null);
    } else {
      setExpandedEntry(entry.id);
      setSendingFor(null);
      if (!messages[entry.id]) await loadMessages(entry.id);
    }
  }

  async function handleSendInConversation(entryId: number, content: string) {
    setSendingFor(entryId);
    await sendMessage(entryId, content);
    setSendingFor(null);
  }

  return (
    <div style={{ flex: 1, height: "100vh", backgroundColor: "#FFFFFF", display: "flex", flexDirection: "column", overflow: "hidden" }}>

      {/* ── Compose area ─────────────────────────────────────────────────────── */}
      <div style={{ flexShrink: 0, padding: "20px 32px 16px", borderBottom: "1px solid rgba(0,0,0,0.08)", boxSizing: "border-box" }}>
        <div>
          <EditorContent editor={composeEditor} />
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
          <span style={{ fontSize: 12, color: "#aab8c2", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>
            {selectedSpaceId ? "⌘↵ to chat" : ""}
          </span>
          <button
            onClick={() => handleSubmitRef.current().catch(console.error)}
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
            Chat
          </button>
        </div>
      </div>

      {/* ── Feed ─────────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {entries.length === 0 && (
          <div style={{ padding: "32px", textAlign: "center", color: "#aab8c2", fontSize: 14, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>
            No conversations yet. Start writing above.
          </div>
        )}
        {entries.map((entry) => (
          <FeedEntryRow
            key={entry.id}
            entry={entry}
            isExpanded={expandedEntryId === entry.id}
            messages={messages[entry.id] ?? []}
            sendingFor={sendingFor}
            onToggle={() => handleToggle(entry)}
            onSendMessage={(content) => handleSendInConversation(entry.id, content)}
          />
        ))}
      </div>
    </div>
  );
}
