import { useEffect, useRef, useState } from "react";
import { Plus, X, Mic } from "lucide-react";
import { ModelSelector } from "../ModelSelector";
import { SendButton } from "./SendButton";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

interface InputBarProps {
  input: string;
  setInput: (v: string) => void;
  onSend: (imageUrl?: string) => void;
  sending: boolean;
}

export function InputBar({ input, setInput, onSend, sending }: InputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  // SpeechRecognition isn't in TS lib.dom — kept loose-typed.
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  }, [input]);

  // Close popup on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      const btn = plusBtnRef.current;
      if (btn?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement)?.closest?.("[data-input-popup]")) return;
      setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setMenuOpen(false); }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSend() {
    onSend(pendingImage ?? undefined);
    setPendingImage(null);
  }

  function pickFile() {
    setMenuOpen(false);
    fileInputRef.current?.click();
  }

  // Inline base64 — same convention as TipTap image extension in NoteEditor.
  // Backend's chat orchestrator accepts data URLs as image_url.
  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") setPendingImage(result);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  // Web Speech API — Chrome/Edge/Safari ship webkitSpeechRecognition. No
  // backend transcription needed. Appends results to whatever's already typed.
  function toggleVoice() {
    if (recording) {
      recognitionRef.current?.stop();
      setRecording(false);
      return;
    }
    const w = window as any;
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      alert("Voice input isn't supported in this browser.");
      return;
    }
    const rec = new Ctor();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "en-US";
    rec.onresult = (e: any) => {
      const transcript = Array.from(e.results as ArrayLike<any>)
        .map((r: any) => r[0].transcript).join(" ");
      setInput(input ? `${input} ${transcript}` : transcript);
    };
    rec.onend = () => setRecording(false);
    rec.onerror = () => setRecording(false);
    recognitionRef.current = rec;
    rec.start();
    setRecording(true);
  }

  const canSend = (!!input.trim() || !!pendingImage) && !sending;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          background: "var(--gooni-input-bg, #F2F2F7)",
          borderRadius: 26,
          padding: "12px 14px",
          border: "1px solid var(--gooni-border, rgba(0,0,0,0.08))",
          position: "relative",
        }}
      >
        {pendingImage && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "6px 8px", borderRadius: 12,
            background: "var(--gooni-card, #FFFFFF)",
            border: "1px solid var(--gooni-border, rgba(0,0,0,0.06))",
            alignSelf: "flex-start",
          }}>
            <img src={pendingImage} alt="attachment" style={{
              width: 40, height: 40, borderRadius: 8, objectFit: "cover",
            }} />
            <span style={{ fontSize: 12, color: "var(--gooni-muted, #8E8E93)" }}>image attached</span>
            <button
              onClick={() => setPendingImage(null)}
              aria-label="Remove attachment"
              style={{
                background: "transparent", border: "none", cursor: "pointer",
                color: "var(--gooni-muted, #8E8E93)", padding: 2, display: "flex",
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Gooni"
          rows={1}
          style={{
            background: "transparent",
            border: "none",
            outline: "none",
            resize: "none",
            fontSize: 14,
            fontFamily: FONT,
            color: "var(--gooni-text, #1C1C1E)",
            lineHeight: 1.5,
            overflowY: "hidden",
            padding: "0 4px",
          }}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            ref={plusBtnRef}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Attach"
            style={iconBtnStyle}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--gooni-hover, rgba(0,0,0,0.06))"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            <Plus size={18} />
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={onFileChosen}
            style={{ display: "none" }}
          />

          <div style={{ flex: 1 }} />

          <ModelSelector />

          <button
            onClick={toggleVoice}
            aria-label={recording ? "Stop voice input" : "Voice input"}
            title={recording ? "Stop" : "Voice input"}
            style={{
              ...iconBtnStyle,
              color: recording ? "#CF222E" : "var(--gooni-text, #1C1C1E)",
              background: recording ? "rgba(207,34,46,0.10)" : "transparent",
            }}
            onMouseEnter={(e) => { if (!recording) (e.currentTarget as HTMLButtonElement).style.background = "var(--gooni-hover, rgba(0,0,0,0.06))"; }}
            onMouseLeave={(e) => { if (!recording) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            <Mic size={16} />
          </button>

          <SendButton onClick={handleSend} disabled={!canSend} title="Send (Enter)" />

        </div>

        {menuOpen && (
          <div
            data-input-popup
            style={{
              position: "absolute",
              bottom: "calc(100% + 6px)",
              left: 8,
              background: "var(--gooni-card, #FFFFFF)",
              border: "1px solid var(--gooni-border, rgba(0,0,0,0.10))",
              borderRadius: 12,
              padding: 6,
              minWidth: 180,
              boxShadow: "0 12px 32px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)",
              zIndex: 50,
              fontFamily: FONT,
            }}
          >
            <PopupItem label="Upload files" onClick={pickFile} />
          </div>
        )}
      </div>

      <div style={{
        fontSize: 11, color: "var(--gooni-muted, #AEAEB2)",
        textAlign: "center", fontFamily: FONT, padding: "2px 0",
      }}>
        Gooni is AI and can make mistakes. Please double-check responses.
      </div>
    </div>
  );
}

function PopupItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "block", width: "100%", textAlign: "left",
        padding: "8px 10px", borderRadius: 8, border: "none",
        background: "transparent",
        color: "var(--gooni-text, #1C1C1E)",
        fontSize: 13, fontFamily: FONT, cursor: "pointer",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--gooni-hover, rgba(0,0,0,0.05))"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
    >
      {label}
    </button>
  );
}

const iconBtnStyle: React.CSSProperties = {
  width: 32, height: 32, borderRadius: "50%",
  border: "none", background: "transparent",
  color: "var(--gooni-text, #1C1C1E)",
  display: "flex", alignItems: "center", justifyContent: "center",
  cursor: "pointer", flexShrink: 0,
  transition: "background 0.1s",
};
