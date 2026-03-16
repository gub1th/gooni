export function ThinkingIndicator() {
  return (
    <div style={{ display: "flex", alignItems: "center", paddingLeft: 4, marginBottom: 12 }}>
      <style>{`
        @keyframes gooni-bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30% { transform: translateY(-5px); opacity: 1; }
        }
      `}</style>
      <div style={{ display: "flex", gap: 5 }}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "#C7C7CC",
              animation: "gooni-bounce 1.2s ease-in-out infinite",
              animationDelay: `${i * 0.2}s`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
