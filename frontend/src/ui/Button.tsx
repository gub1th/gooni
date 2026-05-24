import React from "react";
import { FONT, color, radius } from "./tokens";

// Button primitive. Replaces the dozens of hand-rolled `<button style={{…}}>`
// pills scattered across the app (and the modalPrimaryBtn/modalCancelBtn
// style objects). Variants cover the cases that actually existed:
//   primary — dark solid fill (the old modalPrimaryBtn) — default
//   accent  — blue solid fill (links / key CTAs)
//   ghost   — bordered transparent (the old modalCancelBtn / "cancel")
//   danger  — red, for destructive actions
//   subtle  — borderless, muted text (icon-ish text buttons)

export type ButtonVariant = "primary" | "accent" | "ghost" | "danger" | "subtle";
export type ButtonSize = "sm" | "md";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

const SIZES: Record<ButtonSize, React.CSSProperties> = {
  sm: { padding: "4px 10px", fontSize: 12 },
  md: { padding: "6px 14px", fontSize: 13 },
};

function variantStyle(variant: ButtonVariant): React.CSSProperties {
  switch (variant) {
    case "accent":
      return { background: color.accent, color: color.white, border: "none" };
    case "ghost":
      return {
        background: "transparent",
        color: color.text,
        border: `0.5px solid ${color.border}`,
      };
    case "danger":
      return { background: color.danger, color: color.white, border: "none" };
    case "subtle":
      return { background: "transparent", color: color.muted, border: "none" };
    case "primary":
    default:
      return { background: color.text, color: color.card, border: "none" };
  }
}

export function Button({
  variant = "primary",
  size = "md",
  fullWidth = false,
  disabled,
  style,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      disabled={disabled}
      style={{
        ...SIZES[size],
        ...variantStyle(variant),
        fontFamily: FONT,
        fontWeight: variant === "ghost" || variant === "subtle" ? 500 : 600,
        borderRadius: radius.md,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        width: fullWidth ? "100%" : undefined,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        whiteSpace: "nowrap",
        transition: "opacity 0.12s, background 0.12s",
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
