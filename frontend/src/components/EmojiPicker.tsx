import { useEffect, useRef } from "react";

const EMOJI_OPTIONS = [
  // Productivity / work
  "📁", "🗂️", "📂", "📋", "📌", "📍", "🗒️", "📝", "✏️", "🖊️",
  // Goals / health
  "🎯", "🏆", "💪", "🏃", "🧘", "🥗", "💊", "❤️", "🩺", "🧠",
  // Learning
  "📚", "🎓", "💡", "🔬", "🧪", "🖥️", "💻", "🔭", "✍️", "📖",
  // Life / home
  "🏠", "🌱", "🌿", "☀️", "🌙", "🧹", "🛒", "🍳", "🎵", "🎨",
  // People / social
  "👤", "👥", "💼", "🤝", "💬", "📱", "✈️", "🚀", "💰", "🌍",
];

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  anchorRect: DOMRect;
}

export function EmojiPicker({ onSelect, onClose, anchorRect }: EmojiPickerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    // Delay slightly so the double-click that opened us doesn't immediately close
    const t = setTimeout(() => document.addEventListener("mousedown", handleClick), 50);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  // Position below and left-aligned to the anchor, clamped to viewport
  const top = anchorRect.bottom + 6;
  const left = Math.min(anchorRect.left, window.innerWidth - 220);

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        top,
        left,
        zIndex: 2000,
        background: "#FFFFFF",
        borderRadius: 12,
        boxShadow: "0 6px 32px rgba(0,0,0,0.16), 0 0 0 1px rgba(0,0,0,0.06)",
        padding: 10,
        width: 210,
        display: "grid",
        gridTemplateColumns: "repeat(7, 1fr)",
        gap: 2,
      }}
    >
      {EMOJI_OPTIONS.map((emoji) => (
        <button
          key={emoji}
          onClick={() => { onSelect(emoji); onClose(); }}
          style={{
            width: 26,
            height: 26,
            border: "none",
            background: "transparent",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "background 0.1s",
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.07)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
