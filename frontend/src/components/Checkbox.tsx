import type { CSSProperties } from "react";

interface Props {
  checked: boolean;
  onChange: () => void;
  size?: number;
  ariaLabel?: string;
  onClick?: (e: React.MouseEvent) => void;
}

// Custom checkbox so we control the look + animation. Native input has
// platform-default chrome that doesn't match the rest of the app.
export function Checkbox({ checked, onChange, size = 18, ariaLabel, onClick }: Props) {
  const style: CSSProperties = {
    width: size, height: size,
    borderRadius: 5,
    border: checked ? "1px solid #30A14E" : "1.5px solid #C7C7CC",
    background: checked ? "#30A14E" : "#FFFFFF",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    cursor: "pointer", flexShrink: 0,
    transition: "background 160ms ease, border-color 160ms ease, transform 80ms",
    padding: 0,
    boxShadow: checked ? "0 1px 3px rgba(48,161,78,0.25)" : "none",
  };
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel ?? (checked ? "Mark not done" : "Mark done")}
      onClick={(e) => { onClick?.(e); onChange(); }}
      onMouseDown={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = "scale(0.92)"; }}
      onMouseUp={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)"; }}
      style={style}
    >
      <svg
        viewBox="0 0 16 16"
        width={size - 4}
        height={size - 4}
        style={{
          opacity: checked ? 1 : 0,
          transform: checked ? "scale(1)" : "scale(0.6)",
          transition: "opacity 140ms ease, transform 160ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        <path
          d="M3.5 8.5 L6.8 11.5 L12.5 5.2"
          stroke="#FFFFFF"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    </button>
  );
}
