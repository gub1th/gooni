import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { GREEN, roundedRectPath } from "./wavePath";

// The core "everything is the line" primitive. Wraps any content; when `show`
// flips true the rounded-rect outline draws itself on (a stroke-dashoffset
// sweep races around the perimeter), then the content fades in inside it. On
// hide, the outline erases and the content fades. pathLength=1 normalizes the
// dash math so we never need getTotalLength.

export function TracedOutline({
  show,
  radius = 16,
  color = GREEN,
  strokeWidth = 1.5,
  drawMs = 460,
  contentDelayMs = 160,
  glow = 0.3,
  children,
  style,
  onMouseEnter,
  onMouseLeave,
}: {
  show: boolean;
  radius?: number;
  color?: string;
  strokeWidth?: number;
  drawMs?: number;
  contentDelayMs?: number;
  glow?: number;
  children: ReactNode;
  style?: CSSProperties;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const inset = strokeWidth / 2 + 0.5;
  const d = size.w > 0 && size.h > 0
    ? roundedRectPath(inset, inset, size.w - inset * 2, size.h - inset * 2, radius)
    : "";

  return (
    <div ref={wrapRef} style={{ position: "relative", ...style }} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <svg
        width={size.w}
        height={size.h}
        aria-hidden
        style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}
      >
        {d && (
          <path
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={show ? 0 : 1}
            style={{
              transition: `stroke-dashoffset ${drawMs}ms cubic-bezier(0.4,0,0.1,1), opacity ${drawMs}ms ease`,
              opacity: show ? 1 : 0,
              filter: glow > 0 ? `drop-shadow(0 0 3px rgba(74,222,128,${glow}))` : undefined,
            }}
          />
        )}
      </svg>
      <div
        style={{
          opacity: show ? 1 : 0,
          transition: `opacity 240ms ease ${show ? contentDelayMs : 0}ms`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
