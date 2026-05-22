import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { publicNoteQueryOptions } from "../../utils/publicQueries";
import { sanitizeHtml } from "../../utils/sanitize";
import { displayTitle } from "../../utils/notePreview";

const FONT = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
const DISPLAY = "'Iowan Old Style', 'Hoefler Text', Georgia, 'Times New Roman', serif";

type Props = {
  noteId: number | null;
  onClose: () => void;
};

// Slide-up reader sheet. Backdrop blurs the canvas; sheet docks bottom
// w/ rounded top corners. Esc / close button / backdrop-click closes.
export function NoteReaderOverlay({ noteId, onClose }: Props) {
  const { data, isLoading } = useQuery({
    ...publicNoteQueryOptions(noteId ?? 0),
    enabled: noteId !== null,
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (noteId !== null) {
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }
    return undefined;
  }, [noteId, onClose]);

  if (noteId === null) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20, 24, 34, 0.32)",
        backdropFilter: "blur(8px)",
        // Above drei <Html> nametag band ([40, 50]) and the peek card
        // (100). Avatar nametags otherwise pierce the modal scrim.
        zIndex: 110,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        animation: "creative-overlay-fade 220ms ease-out",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, 100%)",
          height: "82vh",
          background: "#fdfaf3",
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          boxShadow: "0 -20px 60px rgba(0,0,0,0.22)",
          overflowY: "auto",
          padding: "32px 36px 80px",
          fontFamily: FONT,
          color: "#1a1a1a",
          animation: "creative-overlay-rise 320ms cubic-bezier(0.18, 0.89, 0.32, 1.18)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <span style={{ fontSize: 12, color: "#aaa", letterSpacing: "0.08em", textTransform: "uppercase" }}>
            from gooni
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "1px solid rgba(0,0,0,0.12)",
              color: "#666",
              borderRadius: 999,
              width: 32,
              height: 32,
              cursor: "pointer",
              fontSize: 16,
            }}
          >
            ×
          </button>
        </div>

        {isLoading || !data ? (
          <p style={{ color: "#aaa", fontSize: 15 }}>loading…</p>
        ) : (
          <>
            {data.space_name && (
              <span style={{
                fontSize: 11.5,
                color: "#888",
                border: "1px solid rgba(0,0,0,0.15)",
                borderRadius: 12,
                padding: "2px 8px",
                marginBottom: 12,
                display: "inline-block",
              }}>
                {data.space_name}
              </span>
            )}
            <h1 style={{
              fontFamily: DISPLAY,
              fontSize: 34,
              fontWeight: 600,
              letterSpacing: "-0.6px",
              margin: "8px 0 24px",
              lineHeight: 1.18,
            }}>
              {displayTitle(data)}
            </h1>
            <div
              className="creative-note-body"
              style={{ fontSize: 16, lineHeight: 1.75, color: "#222" }}
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(data.content ?? "") }}
            />
          </>
        )}
      </div>
      <style>{`
        @keyframes creative-overlay-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes creative-overlay-rise {
          from { transform: translateY(40px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        .creative-note-body img {
          max-width: 100%;
          height: auto;
          border-radius: 8px;
          margin: 12px 0;
        }
      `}</style>
    </div>
  );
}
