import { useEffect } from "react";
import { FONT, frost, z } from "../../ui";
import { getWidget } from "./registry";
import { useWidgetOverlayStore } from "../../stores/useWidgetOverlayStore";

// Global host for the full-screen widget panels. Mounted once in the AppShell
// so any widget's Panel can be summoned from either the home compact's expand
// button or the app nav, over any (non-immersive) view. Scrim-click or Esc
// closes. Sits above the nav but below real modals.
export function WidgetOverlays() {
  const openId = useWidgetOverlayStore((s) => s.openId);
  const view = useWidgetOverlayStore((s) => s.view);
  const close = useWidgetOverlayStore((s) => s.close);

  useEffect(() => {
    if (!openId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, close]);

  const def = getWidget(openId);
  if (!def || !def.Panel) return null;
  const Panel = def.Panel;

  return (
    <div
      onClick={close}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: z.overlay + 4,
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(3px)",
        WebkitBackdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: FONT,
        animation: "widget-overlay-fade 160ms ease",
      }}
    >
      <style>{`
        @keyframes widget-overlay-fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes widget-panel-pop {
          from { opacity: 0; transform: scale(0.985) translateY(6px) }
          to   { opacity: 1; transform: scale(1) translateY(0) }
        }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 780,
          maxWidth: "calc(100vw - 32px)",
          height: 588,
          maxHeight: "calc(100vh - 72px)",
          borderRadius: 18,
          overflow: "hidden",
          border: "1px solid rgba(244,245,244,0.13)",
          boxShadow: "0 30px 90px rgba(0,0,0,0.6)",
          ...frost.sheet,
          color: "#F4F5F4",
          display: "flex",
          flexDirection: "column",
          animation: "widget-panel-pop 200ms cubic-bezier(0.22,1,0.36,1)",
        }}
      >
        <Panel onClose={close} initialView={view} />
      </div>
    </div>
  );
}
