import { useRef, useState } from "react";
import { sendChat } from "../services/api";
import { useGoalsStore } from "../stores/useGoalsStore";
import { useFeedStore } from "../stores/useFeedStore";

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function CaptureBar({ onSent }: { onSent?: () => void }) {
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [image, setImage] = useState<{ file: File; dataUri: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fetchGoals = useGoalsStore((s) => s.fetch);
  const fetchFeed = useFeedStore((s) => s.fetch);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canSubmit = (value.trim() || image) && !loading;

  const attachImage = async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const dataUri = await fileToDataUri(file);
    setImage({ file, dataUri });
  };

  const submit = async () => {
    if (!canSubmit) return;
    const msg = value.trim();
    setLoading(true);
    setValue("");
    const imageUri = image?.dataUri;
    setImage(null);
    try {
      await sendChat(msg, imageUri);
      await Promise.all([fetchGoals(), fetchFeed()]);
      onSent?.();
    } finally {
      setLoading(false);
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };

  const onDragLeave = () => setDragging(false);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) await attachImage(file);
    inputRef.current?.focus();
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const file = Array.from(e.clipboardData.files).find((f) =>
      f.type.startsWith("image/")
    );
    if (file) {
      e.preventDefault();
      await attachImage(file);
    }
  };

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        border: `1px solid ${dragging ? "#a5b4fc" : "#e2e8f0"}`,
        borderRadius: 8,
        background: dragging ? "#f5f3ff" : "#fff",
        opacity: loading ? 0.6 : 1,
        transition: "border-color 0.15s, background 0.15s, opacity 0.15s",
      }}
    >
      {/* Image preview */}
      {image && (
        <div style={{ padding: "10px 14px 0" }}>
          <div style={{ position: "relative", display: "inline-block" }}>
            <img
              src={image.dataUri}
              alt="attachment"
              style={{ height: 72, borderRadius: 6, display: "block", objectFit: "cover" }}
            />
            <button
              onClick={() => setImage(null)}
              style={{
                position: "absolute",
                top: -6,
                right: -6,
                width: 18,
                height: 18,
                borderRadius: "50%",
                border: "none",
                background: "#6b7280",
                color: "#fff",
                fontSize: 10,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Input row */}
      <div style={{ display: "flex", alignItems: "center", padding: "10px 14px" }}>
        {/* Image attach button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={loading}
          title="Attach image"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#9ca3af",
            fontSize: 16,
            padding: "0 8px 0 0",
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          📎
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) await attachImage(file);
            e.target.value = "";
          }}
        />

        <input
          ref={inputRef}
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            fontSize: 15,
            fontFamily: "inherit",
            background: "transparent",
            color: "#1a202c",
          }}
          placeholder={dragging ? "Drop image here..." : "Log food, a workout, or ask..."}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={onPaste}
          disabled={loading}
        />

        <button
          onClick={submit}
          disabled={!canSubmit}
          style={{
            background: "none",
            border: "none",
            cursor: canSubmit ? "pointer" : "default",
            color: canSubmit ? "#4a5568" : "#cbd5e0",
            fontSize: 18,
            padding: "0 4px",
            lineHeight: 1,
          }}
          aria-label="Send"
        >
          ↵
        </button>
      </div>
    </div>
  );
}
