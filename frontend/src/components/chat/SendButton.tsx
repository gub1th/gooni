import { forwardRef } from "react";
import { frostInk as ctok } from "../../ui";

interface SendButtonProps {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
}

// Shared send affordance for both the chat InputBar and the embedded note
// composer. Composer's black + green-accent style is the canonical look —
// scale animates between 0.92 (idle) → 1 (active) → 1.08 (hover), with a
// soft mascot-green ring + drop shadow when active. The chat InputBar
// previously rendered a plain black circle; aligning both eliminates the
// "two surfaces, two buttons" feeling Daniel flagged in #122/#123/#124.
export const SendButton = forwardRef<HTMLButtonElement, SendButtonProps>(
  function SendButton({ onClick, disabled = false, title = "Submit (Enter)", ariaLabel = "Send" }, ref) {
    return (
      <button
        ref={ref}
        onClick={onClick}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          border: "none",
          // `ctok.text` behind a hardcoded `#fff` is the inverted primary a light
          // page wants; in dark it resolves to white on white and the arrow
          // disappears. Same bug the integrations connect button had.
          background: disabled ? ctok.disabled : ctok.accentDim,
          color: disabled ? ctok.faint : ctok.accent,
          cursor: disabled ? "default" : "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          flexShrink: 0,
          transition: "background 0.25s ease, color 0.25s ease, transform 0.2s ease, box-shadow 0.25s ease",
          transform: disabled ? "scale(0.92)" : "scale(1)",
          boxShadow: disabled
            ? "none"
            : "0 0 0 1px rgba(74,222,128,0.35)",
        }}
        onMouseEnter={(e) => {
          if (disabled) return;
          const el = e.currentTarget as HTMLButtonElement;
          el.style.transform = "scale(1.08)";
          el.style.boxShadow = "0 0 0 1px rgba(74,222,128,0.55)";
        }}
        onMouseLeave={(e) => {
          if (disabled) return;
          const el = e.currentTarget as HTMLButtonElement;
          el.style.transform = "scale(1)";
          el.style.boxShadow = "0 0 0 1px rgba(74,222,128,0.35)";
        }}
      >
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
          <path
            d="M6.5 10.5 L6.5 3 M3 6.5 L6.5 3 L10 6.5"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    );
  }
);
