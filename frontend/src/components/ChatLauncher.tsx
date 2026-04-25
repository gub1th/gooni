import { useEffect, useRef } from "react";
import { useGooniStore } from "../stores/useGooniStore";
import { useChatLauncherRectStore } from "../stores/useChatLauncherRectStore";

// Floating chat-launcher (FAB) — bottom-right, fixed. Replaces the in-panel
// header bar + close button. Click toggles GooniPanel. The launcher's rect
// is published into useChatLauncherRectStore so the GooniMascot can anchor
// its "docked" idle position + drop zone here instead of the old sidebar
// seam. Visually the mascot peeks out of the launcher when docked.

const SIZE = 72;
const MARGIN = 24;

export function ChatLauncher() {
  const isOpen = useGooniStore((s) => s.isOpen);
  const toggle = useGooniStore((s) => s.toggle);
  const setRect = useChatLauncherRectStore((s) => s.setRect);
  const ref = useRef<HTMLButtonElement>(null);

  // Publish the FAB rect on mount + every resize + scroll. The mascot reads
  // this to anchor itself. Cleared on unmount so the mascot falls back to
  // its default behavior if the launcher ever isn't rendered.
  useEffect(() => {
    function publish() {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
    }
    publish();
    window.addEventListener("resize", publish);
    window.addEventListener("scroll", publish, true);
    return () => {
      window.removeEventListener("resize", publish);
      window.removeEventListener("scroll", publish, true);
      setRect(null);
    };
  }, [setRect]);

  return (
    <button
      ref={ref}
      onClick={toggle}
      title={isOpen ? "Close chat" : "Open chat"}
      aria-label={isOpen ? "Close Gooni chat" : "Open Gooni chat"}
      style={{
        position: "fixed",
        bottom: MARGIN,
        right: MARGIN,
        width: SIZE,
        height: SIZE,
        borderRadius: "50%",
        // Subtle dark surface — mascot sits over this. Gradient adds depth
        // without competing with whatever color the mascot face uses.
        background:
          "linear-gradient(145deg, #1C1C1E 0%, #2C2C2E 60%, #1C1C1E 100%)",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow:
          "0 8px 24px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.12)",
        cursor: "pointer",
        // High z so it floats above page content but below modals.
        zIndex: 1000,
        // Center any inline content (defaults — mascot positions itself
        // separately via its own absolute mount).
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        transition: "transform 0.15s ease, box-shadow 0.15s ease",
        // Pressed state cue
        outline: "none",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "scale(1.04)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)";
      }}
      onMouseDown={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "scale(0.96)";
      }}
      onMouseUp={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "scale(1.04)";
      }}
    >
      {/* Inner glow ring — matches Mem0's launcher feel without being a
          visual cue that the user must click here vs drag.
          (Mascot, when docked, overlays this center.) */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          inset: 6,
          borderRadius: "50%",
          background:
            "radial-gradient(circle at 50% 35%, rgba(255,255,255,0.08), rgba(255,255,255,0) 70%)",
          pointerEvents: "none",
        }}
      />
    </button>
  );
}
