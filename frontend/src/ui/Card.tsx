import React from "react";
import { color, radius, space } from "./tokens";

// Card primitive — the raised surface used everywhere (dashboard tiles,
// list rows, panels). Standardizes the card/border/radius/padding combo that
// was copy-pasted as inline styles. Pass `style` to extend.

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** padding from the space scale; default "lg" (16) */
  pad?: keyof typeof space | number;
  /** drop the border (e.g. nested cards) */
  borderless?: boolean;
}

export function Card({
  pad = "lg",
  borderless = false,
  style,
  children,
  ...rest
}: CardProps) {
  const padding = typeof pad === "number" ? pad : space[pad];
  return (
    <div
      style={{
        background: color.card,
        border: borderless ? "none" : `1px solid ${color.border}`,
        borderRadius: radius.lg,
        padding,
        boxSizing: "border-box",
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
