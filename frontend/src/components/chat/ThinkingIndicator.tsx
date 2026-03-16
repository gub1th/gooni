const N = [
  { x: 6, y: 12 },
  { x: 6, y: 28 },
  { x: 30, y: 7 },
  { x: 30, y: 20 },
  { x: 30, y: 33 },
  { x: 55, y: 20 },
];

const EDGES = [
  { f: 0, t: 2, d: 0.0 },
  { f: 0, t: 3, d: 0.15 },
  { f: 1, t: 3, d: 0.1 },
  { f: 1, t: 4, d: 0.25 },
  { f: 2, t: 5, d: 0.6 },
  { f: 3, t: 5, d: 0.7 },
  { f: 4, t: 5, d: 0.8 },
];

const NODE_DELAYS = [0, 0.1, 0.55, 0.65, 0.75, 1.0];

export function ThinkingIndicator() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        paddingLeft: 4,
        marginBottom: 12,
      }}
    >
      <style>{`
        @keyframes ti-node-glow {
          0%, 100% { opacity: 0.2; }
          50% { opacity: 1; }
        }
        @keyframes ti-dot-fade {
          0%, 20% { opacity: 0; }
          50% { opacity: 1; }
          80%, 100% { opacity: 0; }
        }
      `}</style>

      <svg
        width="62"
        height="40"
        viewBox="0 0 62 40"
        style={{ overflow: "visible", flexShrink: 0 }}
      >
        <defs>
          <filter id="ti-glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="1.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Static edges */}
        {EDGES.map((e, i) => (
          <line
            key={i}
            x1={N[e.f].x}
            y1={N[e.f].y}
            x2={N[e.t].x}
            y2={N[e.t].y}
            stroke="rgba(0,122,255,0.15)"
            strokeWidth="1"
          />
        ))}

        {/* Traveling signal pulses */}
        {EDGES.map((e, i) => (
          <circle key={`p${i}`} r="2" fill="#007AFF" filter="url(#ti-glow)">
            <animateMotion
              dur="1.5s"
              repeatCount="indefinite"
              begin={`${e.d}s`}
              {...({ path: `M${N[e.f].x},${N[e.f].y} L${N[e.t].x},${N[e.t].y}` } as object)}
            />
          </circle>
        ))}

        {/* Nodes */}
        {N.map((n, i) => (
          <circle
            key={`n${i}`}
            cx={n.x}
            cy={n.y}
            r={i === 5 ? 4 : 3}
            fill="#007AFF"
            filter="url(#ti-glow)"
            style={{
              animation: `ti-node-glow 1.5s ease-in-out infinite ${NODE_DELAYS[i]}s`,
            }}
          />
        ))}
      </svg>

      <span style={{ fontSize: 13, color: "#8E8E93" }}>
        Gooni is thinking
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              animation: `ti-dot-fade 1.4s ease-in-out infinite ${i * 0.25}s`,
              display: "inline-block",
            }}
          >
            .
          </span>
        ))}
      </span>
    </div>
  );
}
