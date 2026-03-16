const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";

const NODES = [
  { x: 27, y:  7, d: 0.0 },
  { x: 30, y: 20, d: 0.6 },
  { x: 25, y: 30, d: 1.1 },
  { x:  8, y: 28, d: 1.7 },
  { x:  5, y: 16, d: 0.9 },
  { x: 13, y:  5, d: 0.3 },
];

const SYNAPSES = [
  "M18,18 Q25,11 27,7",
  "M18,18 Q27,15 30,20",
  "M18,18 Q27,26 25,30",
  "M18,18 Q10,28 8,28",
  "M18,18 Q7,20 5,16",
  "M18,18 Q11,10 13,5",
];

const SPARKS = [
  { si: 0, begin: 0.0, dur: 2.2 },
  { si: 3, begin: 0.8, dur: 2.0 },
  { si: 5, begin: 1.6, dur: 1.8 },
];

export function ThinkingIndicator() {
  return (
    <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <style>{`
          @keyframes th-pulse   { 0%,100% { opacity:.7 } 50% { opacity:1 } }
          @keyframes th-node    { 0%,100% { opacity:.15 } 50% { opacity:.85 } }
          @keyframes th-synapse { 0%,100% { opacity:.05 } 50% { opacity:.15 } }
        `}</style>

        <svg width="36" height="36" viewBox="0 0 36 36">
          <defs>
            <filter id="th-glow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="1.2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {SYNAPSES.map((d, i) => (
            <path
              key={i}
              d={d}
              fill="none"
              stroke="#007AFF"
              strokeWidth="0.8"
              style={{
                animation: `th-synapse ${2.4 + i * 0.28}s ease-in-out infinite ${i * 0.35}s`,
              }}
            />
          ))}

          {SPARKS.map((s, i) => (
            <circle key={i} r="1.4" fill="#007AFF" filter="url(#th-glow)">
              <animateMotion
                dur={`${s.dur}s`}
                repeatCount="indefinite"
                begin={`${s.begin}s`}
                {...({ path: SYNAPSES[s.si] } as object)}
              />
            </circle>
          ))}

          {NODES.map((n, i) => (
            <circle
              key={i}
              cx={n.x}
              cy={n.y}
              r="2"
              fill="#007AFF"
              filter="url(#th-glow)"
              style={{
                animation: `th-node 2.5s ease-in-out infinite ${n.d}s`,
              }}
            />
          ))}

          <text
            x="18"
            y="22"
            textAnchor="middle"
            fontSize="13"
            style={{ animation: "th-pulse 2.5s ease-in-out infinite" }}
          >
            🧠
          </text>
        </svg>

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
