const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";

interface MessageBubbleProps {
  message: { id: number; role: "user" | "assistant"; content: string };
}

export function MessageBubble({ message }: MessageBubbleProps) {
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
