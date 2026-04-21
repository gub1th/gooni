import { useEffect, useRef } from "react";
import { ModelSelector } from "../ModelSelector";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";

interface InputBarProps {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  sending: boolean;
}

export function InputBar({ input, setInput, onSend, sending }: InputBarProps) {
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
        flexDirection: "column",
        gap: 8,
        background: "#F2F2F7",
        borderRadius: 16,
        padding: "10px 12px",
        border: "1px solid rgba(0,0,0,0.08)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
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
      <ModelSelector />
    </div>
  );
}
