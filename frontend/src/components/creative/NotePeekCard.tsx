import { Html } from "@react-three/drei";
import type { PublicNote } from "../../services/api";

// In-world peek card. Pops above a note-coin when the player is
// standing on its tile. Title + excerpt + a "click coin to read" hint.
// Non-interactive (pointerEvents=none) — the click target is the coin
// mesh itself, so HTML can't swallow R3F events.

const FONT = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
const DISPLAY = "'Iowan Old Style', 'Hoefler Text', Georgia, 'Times New Roman', serif";

const EXCERPT_MAX = 140;

function trimExcerpt(s: string): string {
  if (s.length <= EXCERPT_MAX) return s;
  return s.slice(0, EXCERPT_MAX).trimEnd() + "…";
}

type Props = {
  note: PublicNote;
  height: number;
};

export function NotePeekCard({ note, height }: Props) {
  const title = note.title?.trim() || "untitled";
  const excerpt = trimExcerpt(note.excerpt || "");
  return (
    <Html
      position={[0, height, 0]}
      center
      distanceFactor={8}
      pointerEvents="none"
      zIndexRange={[60, 70]}
      style={{ pointerEvents: "none" }}
    >
      <div
        style={{
          background: "rgba(20,22,28,0.82)",
          color: "#fff",
          padding: "12px 16px",
          borderRadius: 14,
          width: 260,
          fontFamily: FONT,
          userSelect: "none",
          backdropFilter: "blur(8px) saturate(160%)",
          WebkitBackdropFilter: "blur(8px) saturate(160%)",
          boxShadow: "0 6px 22px rgba(0,0,0,0.42), 0 0 0 1px rgba(255,228,140,0.20) inset",
          animation: "note-peek-in 280ms ease-out",
        }}
      >
        <div
          style={{
            fontFamily: DISPLAY,
            fontSize: 17,
            lineHeight: 1.2,
            letterSpacing: "-0.01em",
            marginBottom: excerpt ? 6 : 0,
            color: "#ffe79a",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </div>
        {excerpt && (
          <div
            style={{
              fontSize: 12.5,
              lineHeight: 1.4,
              color: "rgba(255,255,255,0.78)",
              marginBottom: 8,
            }}
          >
            {excerpt}
          </div>
        )}
        <div
          style={{
            fontSize: 10.5,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "rgba(255,228,140,0.78)",
          }}
        >
          click coin to read →
        </div>
      </div>
      <style>{`
        @keyframes note-peek-in {
          0%   { transform: translateY(8px) scale(0.92); opacity: 0; }
          100% { transform: translateY(0) scale(1.0); opacity: 1; }
        }
      `}</style>
    </Html>
  );
}
