import { useState } from "react";
import { sendChat } from "../services/api";
import { useGoalsStore } from "../stores/useGoalsStore";
import { useFeedStore } from "../stores/useFeedStore";

export function CaptureBar({ onSent }: { onSent?: () => void }) {
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const fetchGoals = useGoalsStore((s) => s.fetch);
  const fetchFeed = useFeedStore((s) => s.fetch);

  const submit = async () => {
    const msg = value.trim();
    if (!msg || loading) return;
    setLoading(true);
    setValue("");
    try {
      await sendChat(msg);
      await Promise.all([fetchGoals(), fetchFeed()]);
      onSent?.();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        padding: "10px 14px",
        opacity: loading ? 0.6 : 1,
        transition: "opacity 0.15s",
        background: "#fff",
      }}
    >
      <input
        style={{
          flex: 1,
          border: "none",
          outline: "none",
          fontSize: 15,
          fontFamily: "inherit",
          background: "transparent",
          color: "#1a202c",
        }}
        placeholder="Log food, a workout, or ask..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        disabled={loading}
      />
      <button
        onClick={submit}
        disabled={loading || !value.trim()}
        style={{
          background: "none",
          border: "none",
          cursor: value.trim() && !loading ? "pointer" : "default",
          color: value.trim() && !loading ? "#4a5568" : "#cbd5e0",
          fontSize: 18,
          padding: "0 4px",
          lineHeight: 1,
        }}
        aria-label="Send"
      >
        ↵
      </button>
    </div>
  );
}
