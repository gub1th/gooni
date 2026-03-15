import { useEffect, useRef, useState } from "react";
import { fetchDashboardStats, type DashboardStats } from "../services/api";
import { useConversationsStore } from "../stores/useConversationsStore";

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
const DISPLAY_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function getDateStr(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function StatChip({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      style={{
        padding: "5px 12px",
        borderRadius: 20,
        background: "rgba(0,0,0,0.05)",
        fontSize: 13,
        color: "#3C3C43",
        fontFamily: FONT,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ fontWeight: 600 }}>{value}</span>
      <span style={{ color: "#8E8E93", marginLeft: 5 }}>{label}</span>
    </div>
  );
}

interface MessageBubbleProps {
  message: { id: number; role: "user" | "assistant"; content: string };
}

function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        marginBottom: 12,
      }}
    >
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

interface InputBarProps {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  sending: boolean;
}

function InputBar({ input, setInput, onSend, sending }: InputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  }, [input]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 8,
        background: "#F2F2F7",
        borderRadius: 16,
        padding: "10px 12px",
        border: "1px solid rgba(0,0,0,0.08)",
      }}
    >
      <textarea
        ref={textareaRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="What's on your mind?"
        rows={1}
        style={{
          flex: 1,
          background: "transparent",
          border: "none",
          outline: "none",
          resize: "none",
          fontSize: 14,
          fontFamily: FONT,
          color: "#1C1C1E",
          lineHeight: 1.5,
          overflowY: "hidden",
        }}
      />
      <button
        onClick={onSend}
        disabled={!input.trim() || sending}
        style={{
          width: 32,
          height: 32,
          borderRadius: 10,
          border: "none",
          background: !input.trim() || sending ? "rgba(0,0,0,0.1)" : "#1C1C1E",
          color: !input.trim() || sending ? "#AEAEB2" : "#FFFFFF",
          cursor: !input.trim() || sending ? "default" : "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          transition: "background 0.1s",
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 12V2M7 2L3 6M7 2L11 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

interface DashboardProps {
  onGoToNote: (noteId: number, spaceId: string) => void;
}

const CHIPS = ["Brain dump", "Set a goal", "How am I doing?", "What should I focus on?"];

const chipStyle: React.CSSProperties = {
  padding: "7px 14px",
  borderRadius: 20,
  border: "1px solid rgba(0,0,0,0.1)",
  background: "rgba(0,0,0,0.03)",
  fontSize: 13,
  fontFamily: FONT,
  color: "#3C3C43",
  cursor: "pointer",
  transition: "background 0.1s",
};

export function Dashboard({ onGoToNote: _onGoToNote }: DashboardProps) {
  const { activeId, messages, sending, send } = useConversationsStore();
  const [input, setInput] = useState("");
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const chatStarted = activeId !== null || messages.length > 0;

  useEffect(() => {
    fetchDashboardStats().then(setStats).catch(console.error);
  }, []);

  useEffect(() => {
    if (chatStarted) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, chatStarted]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    await send(text);
  }

  function handleChip(text: string) {
    setInput(text);
  }

  const greeting = getGreeting();
  const dateStr = getDateStr();

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
        background: "#FFFFFF",
        fontFamily: FONT,
      }}
    >
      {/* Greeting + Stats — fades out when chat starts */}
      <div
        style={{
          maxHeight: chatStarted ? 0 : 180,
          opacity: chatStarted ? 0 : 1,
          overflow: "hidden",
          transition: "max-height 0.4s ease, opacity 0.25s ease",
          flexShrink: 0,
          padding: chatStarted ? 0 : "40px 48px 0",
        }}
      >
        <div
          style={{
            fontSize: 28,
            fontWeight: 700,
            fontFamily: DISPLAY_FONT,
            color: "#1C1C1E",
            letterSpacing: "-0.3px",
          }}
        >
          {greeting}, Daniel
        </div>
        <div style={{ fontSize: 13, color: "#8E8E93", marginTop: 4 }}>{dateStr}</div>
        <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
          <StatChip
            value={stats?.notes_this_week ?? "—"}
            label="notes this week"
          />
          <StatChip
            value={stats?.workouts_this_week ?? "—"}
            label="workouts"
          />
          <StatChip
            value={stats && stats.streak > 0 ? `${stats.streak} 🔥` : (stats?.streak ?? "—")}
            label="streak"
          />
          <StatChip
            value={stats?.active_goals_count ?? "—"}
            label="goals"
          />
        </div>
      </div>

      {/* Messages area */}
      <div
        style={{
          flex: chatStarted ? 1 : 0,
          overflowY: "auto",
          padding: chatStarted ? "20px 0 8px" : 0,
          maxWidth: 720,
          width: "100%",
          alignSelf: "center",
          boxSizing: "border-box",
          transition: "flex 0.3s ease",
          paddingLeft: chatStarted ? 48 : 0,
          paddingRight: chatStarted ? 48 : 0,
        }}
      >
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {sending && (
          <div style={{ color: "#AEAEB2", fontStyle: "italic", fontSize: 13, paddingLeft: 4 }}>
            Gooni is thinking...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Vertical spacer to center input when no chat */}
      {!chatStarted && <div style={{ flex: 1 }} />}

      {/* Input + Chips */}
      <div
        style={{
          padding: chatStarted ? "12px 48px 20px" : "0 48px 0",
          maxWidth: 720,
          width: "100%",
          alignSelf: "center",
          boxSizing: "border-box",
          flexShrink: 0,
        }}
      >
        <InputBar input={input} setInput={setInput} onSend={handleSend} sending={sending} />

        {/* Quick-prompt chips */}
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            marginTop: 12,
            opacity: chatStarted ? 0 : 1,
            maxHeight: chatStarted ? 0 : 48,
            overflow: "hidden",
            transition: "opacity 0.2s ease, max-height 0.3s ease",
          }}
        >
          {CHIPS.map((chip) => (
            <button
              key={chip}
              onClick={() => handleChip(chip)}
              style={chipStyle}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.07)")
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.03)")
              }
            >
              {chip}
            </button>
          ))}
        </div>
      </div>

      {/* Bottom spacer when no chat (mirrors top to center input) */}
      {!chatStarted && <div style={{ flex: 1.2 }} />}
    </div>
  );
}
