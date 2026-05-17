import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

// Subtle two-step delete. First click arms the button (turns red, swaps
// glyph to a question mark, starts a 2.5s timer); second click within the
// window fires onConfirm. Click anywhere else, mouseleave the row, or hit
// the timeout to disarm. Used by todo rows + habit rows so destructive
// actions never go off on a single mis-click.
//
// Keep it small + visually quiet so the row chrome doesn't shift width
// when the button morphs.

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

interface Props {
  onConfirm: () => void;
  size?: number;
  title?: string;
  /** Auto-disarm timeout in ms. Default 2500. */
  windowMs?: number;
}

export function ConfirmDeleteButton({
  onConfirm,
  size = 12,
  title = "Delete",
  windowMs = 2500,
}: Props) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!armed) return;
    timerRef.current = window.setTimeout(() => setArmed(false), windowMs);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [armed, windowMs]);

  if (!armed) {
    return (
      <button
        title={title}
        onClick={(e) => { e.stopPropagation(); setArmed(true); }}
        style={{
          border: "none", background: "transparent", cursor: "pointer",
          padding: 2, color: "#9CA3AF", display: "flex",
          fontFamily: FONT,
        }}
      >
        <X size={size} />
      </button>
    );
  }
  return (
    <button
      title="Click again to confirm — auto-cancels in a moment"
      onClick={(e) => {
        e.stopPropagation();
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        setArmed(false);
        onConfirm();
      }}
      onBlur={() => setArmed(false)}
      style={{
        border: "none", cursor: "pointer",
        background: "#FEE2E2",
        color: "#B91C1C",
        padding: "2px 8px", borderRadius: 99,
        fontSize: 10.5, fontWeight: 600, letterSpacing: 0.3,
        textTransform: "uppercase",
        fontFamily: FONT,
        display: "inline-flex", alignItems: "center", gap: 4,
        animation: "gooni-confirm-pulse 1.4s ease-in-out infinite",
      }}
    >
      <style>{`
        @keyframes gooni-confirm-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0); }
          50%      { box-shadow: 0 0 0 3px rgba(220,38,38,0.18); }
        }
      `}</style>
      delete?
    </button>
  );
}
