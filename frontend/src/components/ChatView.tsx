import { useEffect, useRef, useState } from "react";
import { fetchDashboardStats, type DashboardStats } from "../services/api";
import { useConversationsStore } from "../stores/useConversationsStore";
import { InputBar } from "./chat/InputBar";
import { MessageBubble } from "./chat/MessageBubble";
import { StatChip } from "./chat/StatChip";
import { ThinkingIndicator } from "./chat/ThinkingIndicator";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
const DISPLAY_FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

const CHIPS = ["Brain dump", "How am I doing?", "What should I focus on?"];

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

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function getDateStr(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

export function ChatView() {
  const { activeId, messages, sending, pendingIntention, send } = useConversationsStore();
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

  async function handleSend(imageUrl?: string) {
    const text = input.trim();
    if (!text && !imageUrl) return;
    if (sending) return;
    setInput("");
    await send(text, undefined, undefined, imageUrl);
  }

  return (
    <div style={{
      flex: 1,
      display: "flex",
      flexDirection: "column",
      height: "100vh",
      overflow: "hidden",
      background: "var(--gooni-card, #FFFFFF)",
      fontFamily: FONT,
    }}>
      {/* Greeting + Stats — collapses when chat starts */}
      <div style={{
        maxHeight: chatStarted ? 0 : 180,
        opacity: chatStarted ? 0 : 1,
        overflow: "hidden",
        transition: "max-height 0.4s ease, opacity 0.25s ease",
        flexShrink: 0,
        padding: chatStarted ? 0 : "40px 48px 0",
      }}>
        <div style={{ fontSize: 28, fontWeight: 700, fontFamily: DISPLAY_FONT, color: "var(--gooni-text, #1C1C1E)", letterSpacing: "-0.3px" }}>
          {getGreeting()}, Daniel
        </div>
        <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)", marginTop: 4 }}>{getDateStr()}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
          <StatChip value={stats?.notes_this_week ?? "—"} label="notes this week" />
          <StatChip value={stats && stats.streak > 0 ? `${stats.streak} 🔥` : (stats?.streak ?? "—")} label="streak" />
        </div>
      </div>

      {/* Messages */}
      <div style={{
        flex: chatStarted ? 1 : 0,
        overflowY: "auto",
        padding: chatStarted ? "20px 48px 8px" : 0,
        maxWidth: 720,
        width: "100%",
        alignSelf: "center",
        boxSizing: "border-box",
        transition: "flex 0.3s ease",
      }}>
        {messages.map(m => <MessageBubble key={m.id} message={m} />)}
        {sending && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
            {pendingIntention && (
              <div style={{ marginBottom: 6, maxWidth: "80%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4, color: "#AEAEB2", fontSize: 12, fontFamily: FONT, marginBottom: 4 }}>
                  <span>Assessed your intention</span>
                  <span style={{ fontSize: 10 }}>▾</span>
                </div>
                <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(0,0,0,0.03)", border: "1px solid var(--gooni-border, rgba(0,0,0,0.07))", fontFamily: FONT }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
                    <span style={{ color: "#AEAEB2", fontSize: 13, marginTop: 1 }}>⊙</span>
                    <span style={{ fontSize: 12.5, color: "#636366", lineHeight: 1.5 }}>{pendingIntention}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "#34C759", fontSize: 13 }}>✓</span>
                    <span style={{ fontSize: 12, color: "#AEAEB2" }}>Done</span>
                  </div>
                </div>
              </div>
            )}
            <ThinkingIndicator />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {!chatStarted && <div style={{ flex: 1 }} />}

      {/* Input + chips */}
      <div style={{
        padding: chatStarted ? "12px 48px 20px" : "0 48px 0",
        maxWidth: 720,
        width: "100%",
        alignSelf: "center",
        boxSizing: "border-box",
        flexShrink: 0,
      }}>
        <InputBar input={input} setInput={setInput} onSend={handleSend} sending={sending} />
        <div style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          marginTop: 12,
          opacity: chatStarted ? 0 : 1,
          maxHeight: chatStarted ? 0 : 48,
          overflow: "hidden",
          transition: "opacity 0.2s ease, max-height 0.3s ease",
        }}>
          {CHIPS.map(chip => (
            <button
              key={chip}
              onClick={() => setInput(chip)}
              style={chipStyle}
              onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.07)")}
              onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.03)")}
            >{chip}</button>
          ))}
        </div>
      </div>

      {!chatStarted && <div style={{ flex: 1.2 }} />}
    </div>
  );
}
