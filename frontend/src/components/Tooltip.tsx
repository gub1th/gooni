import { useEffect, useRef } from "react";
import tippy, { type Instance } from "tippy.js";
import { color as ctok } from "../ui";

interface TooltipProps {
  label: string;
  children: React.ReactNode;
  placement?: "top" | "bottom" | "left" | "right";
  delay?: number;
}

// Lightweight tooltip wrapper using tippy.js (already installed for the slash
// menu). Wraps any child in a span and attaches tippy to that span — avoids
// the ref-forwarding dance for callers that pass HTML elements or components.
export function Tooltip({ label, children, placement = "bottom", delay = 200 }: TooltipProps) {
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const instanceRef = useRef<Instance | null>(null);

  useEffect(() => {
    if (!wrapperRef.current) return;
    // Self-styled DOM node as content — sidesteps having to import tippy's
    // default CSS while keeping the tooltip visually consistent with the
    // BubbleMenu / slash menu (dark pill, white text, Manrope).
    const tip = document.createElement("div");
    Object.assign(tip.style, {
      background: ctok.text,
      color: "#fff",
      padding: "4px 9px",
      borderRadius: "6px",
      fontSize: "11.5px",
      fontWeight: "500",
      letterSpacing: "0.1px",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      boxShadow: "0 4px 16px rgba(0,0,0,0.20)",
      whiteSpace: "nowrap",
      pointerEvents: "none",
    });
    tip.textContent = label;

    instanceRef.current = tippy(wrapperRef.current, {
      content: tip,
      placement,
      delay: [delay, 0],
      arrow: false,
      offset: [0, 6],
      animation: false,
      appendTo: () => document.body,
    });
    return () => instanceRef.current?.destroy();
  }, [label, placement, delay]);

  return (
    <span ref={wrapperRef} style={{ display: "inline-flex" }}>
      {children}
    </span>
  );
}
