import { useState, type ReactNode } from "react";

// Dark round glass control button shared by the portfolio surfaces — the
// /walk top-right cluster and the /public plaza — so the two pages read as
// one control family (Daniel: "same buttons in /public"). Carries a styled
// hover/focus tooltip; native `title=` was slow to appear and unstyled.
export function CtrlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const active = hover || focus;
  return (
    <div style={{ position: "relative", display: "flex" }}>
      <button
        onClick={onClick}
        aria-label={label}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          all: "unset",
          boxSizing: "border-box",
          width: 40,
          height: 40,
          borderRadius: 999,
          cursor: "pointer",
          background: active ? "rgba(30,36,33,0.82)" : "rgba(18,22,20,0.66)",
          border: "1px solid rgba(242,239,232,0.16)",
          color: "#E8E6DF",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backdropFilter: "blur(14px) saturate(140%)",
          WebkitBackdropFilter: "blur(14px) saturate(140%)",
          boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
          transform: active ? "scale(1.06)" : "scale(1)",
          // Green ring on keyboard focus only — a hover ring would read as
          // a fake focus state.
          outline: focus ? "2px solid rgba(74,222,128,0.6)" : "none",
          outlineOffset: 2,
          transition: "background 160ms ease, transform 120ms ease",
        }}
      >
        {children}
      </button>
      {/* Tooltip opens downward — the cluster hugs the top edge. Dark pill so
          it reads on both the bright plaza sky and the dark walk. Right-aligned
          to the button so it can't push past the right viewport edge.
          Non-interactive so it never eats the click. */}
      <span
        role="tooltip"
        style={{
          position: "absolute",
          top: "calc(100% + 8px)",
          right: 0,
          padding: "5px 9px",
          borderRadius: 7,
          background: "rgba(14,17,15,0.94)",
          color: "#E8E6DF",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: "0.02em",
          whiteSpace: "nowrap",
          border: "1px solid rgba(242,239,232,0.14)",
          boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
          opacity: active ? 1 : 0,
          transform: active ? "translateY(0)" : "translateY(-4px)",
          transition: "opacity 140ms ease, transform 140ms ease",
          pointerEvents: "none",
          zIndex: 1,
        }}
      >
        {label}
      </span>
    </div>
  );
}
