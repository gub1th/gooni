import { HamsterWheel } from "../animations/HamsterWheel";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

export function ThinkingIndicator() {
  return (
    <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <style>{`
          @keyframes th-pulse { 0%,100% { opacity:.7 } 50% { opacity:1 } }
        `}</style>
        <HamsterWheel size={48} />
        <span
          style={{
            fontSize: 13,
            color: "#636366",
            fontFamily: FONT,
            animation: "th-pulse 2.5s ease-in-out infinite 0.15s",
          }}
        >
          Gooni is thinking...
        </span>
      </div>
    </div>
  );
}
