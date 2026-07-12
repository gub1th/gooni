import { useState, type ReactNode } from "react";
import { X, Maximize2, type LucideIcon } from "lucide-react";
import { FONT, frost, z } from "../../ui";
import { useWidgetLayoutStore } from "../../stores/useWidgetLayoutStore";

// The generic draggable frosted shell every home-screen widget lives inside.
// Concrete widgets (calendar, …) supply only their Icon, title, and compact
// body — the shell owns the frame, the drag-to-reposition (lifted from the
// FloatingModal pattern: pointer-capture → live follow → clamp on release),
// the expand affordance (opens the widget's full panel), and hide (flips the
// widget off in the layout store; re-enable from Settings ▸ Widgets).
//
// Drag only starts on the header's [data-widget-drag] grip so the expand/hide
// buttons stay clickable.

const WIDGET_W = 236;
const EDGE = 12; // viewport clamp margin

export function Widget({
  id,
  title,
  Icon,
  index,
  onExpand,
  onHide,
  children,
}: {
  id: string;
  title: string;
  Icon: LucideIcon;
  index: number;
  onExpand?: () => void;
  onHide?: () => void;
  children: ReactNode;
}) {
  const pos = useWidgetLayoutStore((s) => s.positions[id]);
  const setPos = useWidgetLayoutStore((s) => s.setPos);
  const [dragGrab, setDragGrab] = useState<{ dx: number; dy: number } | null>(null);
  const [livePos, setLivePos] = useState<{ x: number; y: number } | null>(null);
  const dragging = dragGrab != null;

  function startDrag(e: React.PointerEvent, rect: DOMRect) {
    setDragGrab({ dx: e.clientX - rect.left, dy: e.clientY - rect.top });
    setLivePos({ x: rect.left, y: rect.top });
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* pointer capture is best-effort */
    }
  }
  function moveDrag(e: React.PointerEvent) {
    if (!dragGrab) return;
    setLivePos({ x: e.clientX - dragGrab.dx, y: e.clientY - dragGrab.dy });
  }
  function endDrag(e: React.PointerEvent) {
    if (dragGrab && livePos) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const clamped = {
        x: Math.max(EDGE, Math.min(vw - rect.width - EDGE, livePos.x)),
        y: Math.max(EDGE, Math.min(vh - rect.height - EDGE, livePos.y)),
      };
      setPos(id, clamped);
    }
    setDragGrab(null);
    setLivePos(null);
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
  }

  // Live cursor while dragging → stored pos → computed default (top-right,
  // stacked down by registration index so multiple widgets don't overlap).
  const placement: React.CSSProperties =
    dragging && livePos
      ? { left: livePos.x, top: livePos.y, right: "auto" }
      : pos
      ? { left: pos.x, top: pos.y, right: "auto" }
      : { right: 20, top: 84 + index * 132, left: "auto" };

  return (
    <div
      data-widget
      onPointerDown={(e) => {
        const target = e.target as HTMLElement;
        if (!target.closest?.("[data-widget-drag]")) return;
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        startDrag(e, rect);
      }}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{
        position: "fixed",
        ...placement,
        width: WIDGET_W,
        zIndex: z.overlay,
        borderRadius: 16,
        overflow: "hidden",
        border: "1px solid rgba(244,245,244,0.1)",
        boxShadow: dragging
          ? "0 0 0 1px rgba(74,222,128,0.5), 0 22px 64px rgba(0,0,0,0.6)"
          : "0 18px 60px rgba(0,0,0,0.5)",
        ...frost.panel,
        fontFamily: FONT,
        color: "#F4F5F4",
        transition: dragging ? "none" : "box-shadow 200ms ease",
        userSelect: dragging ? "none" : undefined,
        touchAction: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "9px 8px 9px 12px",
          borderBottom: "1px solid rgba(244,245,244,0.07)",
        }}
      >
        <div
          data-widget-drag
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flex: 1,
            minWidth: 0,
            cursor: dragging ? "grabbing" : "grab",
          }}
        >
          <Icon size={14} color="rgba(74,222,128,0.9)" strokeWidth={2} />
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              letterSpacing: 0.2,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </span>
        </div>
        {onExpand && (
          <HeaderBtn label="Expand" onClick={onExpand}>
            <Maximize2 size={13} />
          </HeaderBtn>
        )}
        {onHide && (
          <HeaderBtn label="Hide widget" onClick={onHide}>
            <X size={14} />
          </HeaderBtn>
        )}
      </div>
      <div style={{ padding: "10px 12px 12px" }}>{children}</div>
    </div>
  );
}

function HeaderBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 24,
        height: 24,
        borderRadius: 7,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        color: "rgba(244,245,244,0.55)",
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(255,255,255,0.08)";
        e.currentTarget.style.color = "rgba(244,245,244,0.9)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "rgba(244,245,244,0.55)";
      }}
    >
      {children}
    </button>
  );
}
