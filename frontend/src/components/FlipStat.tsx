import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

// 3D card-flip stat — cycles through N faces. Auto-advances every
// `autoIntervalMs`; the chevron flips manually. Each face is a stat-card
// shape (label + value + optional sub line). Front + back render
// simultaneously; backface-visibility hides whichever face is rotated away.
//
// Remount-on-complete trick: when a flip animation finishes, we bump `seq`
// so the inner div remounts at rotateY(0) with `transition: none`. That
// avoids the visible "snap-back" you'd get from animating from 180→0 to
// reset state.
//
// idx points at the face shown by the FRONT side. Back side always renders
// (idx+1) % faces.length so the next face is queued mid-flip.

export interface FlipFace {
  key: string;
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
}

interface FlipStatProps {
  faces: FlipFace[];
  autoIntervalMs?: number;
  width?: number;
}

export function FlipStat({ faces, autoIntervalMs = 15000, width = 132 }: FlipStatProps) {
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<"idle" | "flipping">("idle");
  // seq remounts the inner card after each flip completes so the rotation
  // resets to 0 with no transition (no visible un-flip jitter).
  const [seq, setSeq] = useState(0);
  const flipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  function flip() {
    if (phase === "flipping" || faces.length < 2) return;
    setPhase("flipping");
    if (flipTimer.current) clearTimeout(flipTimer.current);
    flipTimer.current = setTimeout(() => {
      setIdx((i) => (i + 1) % faces.length);
      setPhase("idle");
      setSeq((s) => s + 1);
      flipTimer.current = null;
    }, 600);
  }

  // Auto-cycle. Resetting on idx change means a manual flip "rebases" the
  // 15s timer — feels less like the card is fighting you.
  useEffect(() => {
    if (faces.length < 2) return;
    if (autoTimer.current) clearInterval(autoTimer.current);
    autoTimer.current = setInterval(flip, autoIntervalMs);
    return () => {
      if (autoTimer.current) clearInterval(autoTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoIntervalMs, faces.length, idx]);

  useEffect(() => () => {
    if (flipTimer.current) clearTimeout(flipTimer.current);
    if (autoTimer.current) clearInterval(autoTimer.current);
  }, []);

  if (faces.length === 0) return null;

  const front = faces[idx];
  const back = faces[(idx + 1) % faces.length];

  return (
    <div style={{
      position: "relative",
      perspective: 900,
      width,
      height: 70,
      flexShrink: 0,
    }}>
      <div
        key={seq}
        style={{
          position: "absolute",
          inset: 0,
          transformStyle: "preserve-3d",
          transform: phase === "flipping" ? "rotateY(180deg)" : "rotateY(0deg)",
          transition: phase === "flipping" ? "transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)" : "none",
        }}
      >
        <FlipFaceCard face={front} side="front" />
        <FlipFaceCard face={back} side="back" />
      </div>

      {/* Manual-flip arrow. Sits flush to the right edge, fades in on hover
          of the wrapping card. Always tappable on touch (visible). */}
      <button
        onClick={flip}
        aria-label={`Show ${back.label}`}
        title={`Next: ${back.label}`}
        style={{
          position: "absolute",
          right: -10,
          top: "50%",
          transform: "translateY(-50%)",
          width: 22, height: 22, borderRadius: "50%",
          background: "var(--gooni-card, #fff)",
          border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.10))",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "var(--gooni-muted, #8E8E93)",
          cursor: "pointer", padding: 0,
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
          fontFamily: FONT,
          zIndex: 2,
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = "var(--gooni-text, #1C1C1E)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = "var(--gooni-muted, #8E8E93)";
        }}
      >
        <ChevronRight size={12} />
      </button>
    </div>
  );
}

function FlipFaceCard({ face, side }: { face: FlipFace; side: "front" | "back" }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        backfaceVisibility: "hidden",
        WebkitBackfaceVisibility: "hidden",
        transform: side === "back" ? "rotateY(180deg)" : "none",
        background: "var(--gooni-card, #fff)",
        border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
        borderRadius: 10,
        padding: "10px 14px",
        display: "flex", flexDirection: "column", alignItems: "flex-start",
        fontFamily: FONT,
        boxSizing: "border-box",
      }}
    >
      <div style={{
        fontSize: 11, color: "var(--gooni-muted, #8E8E93)", letterSpacing: 0.3,
      }}>{face.label}</div>
      <div style={{
        fontSize: 20, fontWeight: 600,
        color: "var(--gooni-text, #1C1C1E)", marginTop: 1, lineHeight: 1.1,
        fontVariantNumeric: "tabular-nums",
      }}>
        {face.value}
      </div>
      {face.hint != null && (
        <div style={{ marginTop: 2 }}>
          {face.hint}
        </div>
      )}
    </div>
  );
}
