import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { FONT, color, radius, z } from "./tokens";

// Canonical modal primitive. Wraps the overlay+card chrome that ~30 one-off
// modals (FocusModal, SettingsModal, ItemModal, ExploreModal, …) each
// reinvented. Theme tokens flow through via the color tokens so it renders
// correctly in dark mode without per-call overrides.
//
// Closing: Esc, × button, and backdrop click all route to onClose. onClose
// also owns any "save before exiting" semantics — this primitive doesn't
// second-guess persistence shape.
export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;                       // small uppercase eyebrow at top of card
  children: React.ReactNode;           // body
  footer?: React.ReactNode;            // optional footer row (cancel / save / etc.)
  width?: number | string;             // CSS width — defaults to 440 (clamped to 100%)
  // Disable backdrop-click close — useful for forms where a stray click
  // shouldn't lose typing. Esc + × still close.
  disableBackdropClose?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 440,
  disableBackdropClose = false,
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Esc to close + scroll-lock the body while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  // Auto-focus the first focusable element on open — covers the common
  // "modal opens with a single input" case without per-consumer ref dances.
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      const el = cardRef.current?.querySelector<HTMLElement>(
        "input, textarea, select, button, [tabindex]:not([tabindex='-1'])"
      );
      el?.focus();
    });
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      role="presentation"
      onMouseDown={(e) => {
        if (disableBackdropClose) return;
        if (e.target === overlayRef.current) onClose();
      }}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(15, 18, 24, 0.45)",
        zIndex: z.modalScrim,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24,
        animation: "gooni-modal-overlay-in 160ms ease-out",
      }}
    >
      <style>{`
        @keyframes gooni-modal-overlay-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes gooni-modal-card-in {
          from { opacity: 0; transform: translateY(8px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0)    scale(1);    }
        }
      `}</style>
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: typeof width === "number" ? `min(${width}px, 100%)` : width,
          background: color.card,
          color: color.text,
          borderRadius: 14,
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
          fontFamily: FONT,
          padding: 22,
          maxHeight: "90vh", overflowY: "auto",
          animation: "gooni-modal-card-in 200ms cubic-bezier(0.22, 1, 0.36, 1)",
          boxSizing: "border-box",
        }}
      >
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          marginBottom: 14,
        }}>
          <span style={{
            fontSize: 11,
            color: color.muted,
            letterSpacing: 0.5, textTransform: "uppercase",
            fontWeight: 600,
          }}>
            {title}
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              border: "none", background: "transparent",
              color: color.muted,
              cursor: "pointer", padding: 2, lineHeight: 0,
              borderRadius: radius.sm,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)";
              (e.currentTarget as HTMLButtonElement).style.color = color.text;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = color.muted;
            }}
          >
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>
        <div>{children}</div>
        {footer && (
          <div style={{
            display: "flex", justifyContent: "flex-end", gap: 8,
            marginTop: 18,
            paddingTop: 14,
            borderTop: `0.5px solid ${color.border}`,
          }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
