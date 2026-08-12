import { useEffect } from "react";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { FONT, frostInk, z } from "../../ui";
import { SettingsView } from "./SettingsView";

// The shell around `SettingsView`: a modal that opens over ANY page.
//
// Pass 8 made settings a slide-in surface for consistency with the other
// destinations; pass 9 reverts that, because the consistency was on the wrong
// axis. Settings is not a place you go, it is a panel you open over wherever you
// already are — which is why it never belonged in the left-hand nav, and why
// having to leave the page you were configuring (the theme switch, most
// obviously) was backwards.
//
// PORTALED to the body so it escapes the shell's rail lane and header padding —
// a modal over "any page" cannot be a child of one page's layout.
//
// NO DROP SHADOW, deliberately: the 2026-08-02 pass stripped blooms from every
// floating thing in this app because they made the void read heavy. The scrim
// separates it from the page and a hairline draws its edge; that is enough.

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Stopped here so the shell's own Escape handler does not ALSO fire and
      // dismiss the surface underneath — closing the modal is the whole gesture.
      e.stopPropagation();
      onClose();
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      onClick={onClose}
      role="dialog"
      aria-modal
      aria-label="Settings"
      style={{
        position: "fixed", inset: 0, zIndex: z.modalScrim,
        // a scrim must DIM, so it stays a literal black rather than a themed
        // tint — the one place `--gooni-tint` would be wrong
        background: "rgba(0,0,0,0.42)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: FONT,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          width: 760, maxWidth: "calc(100vw - 48px)",
          height: 560, maxHeight: "calc(100vh - 96px)",
          display: "flex", overflow: "hidden",
          borderRadius: 16,
          // OPAQUE, not `frost.sheet`. A frosted tint is right for chrome
          // floating on the void, but this floats over a full page — in light
          // mode the memories table read straight through it and the modal's own
          // body text washed out. Blur still softens the edge.
          background: frostInk.card,
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          border: `1px solid ${frostInk.hairline}`,
        }}
      >
        <SettingsView />
        <button
          onClick={onClose}
          aria-label="Close settings"
          style={{
            position: "absolute", top: 12, right: 12, zIndex: 1,
            width: 26, height: 26, padding: 0, borderRadius: 999,
            border: "none", background: "transparent", cursor: "pointer",
            display: "grid", placeItems: "center", color: frostInk.faint,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = frostInk.text; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = frostInk.faint; }}
        >
          <X size={15} strokeWidth={1.9} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
