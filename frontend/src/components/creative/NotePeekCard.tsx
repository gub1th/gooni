import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PublicNote } from "../../services/api";

// Bottom-anchored peek bar — slides up from the bottom of the viewport
// when the player lands on a note-tile, slides back down on leave.
// Click anywhere on the card → triggers onSelect → existing
// NoteReaderOverlay opens (fullscreen reader). This keeps the 3D scene
// uncovered while the peek text reads at real DOM sizes, not tiny
// drei <Html> sizes that vanish at distance.
//
// Rendered via portal to document.body so it sits outside the R3F
// Canvas tree and shows above all 3D content without z-index fights.

const FONT = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
const DISPLAY = "'Iowan Old Style', 'Hoefler Text', Georgia, 'Times New Roman', serif";

const EXCERPT_MAX = 240;

function trimExcerpt(s: string): string {
  if (s.length <= EXCERPT_MAX) return s;
  return s.slice(0, EXCERPT_MAX).trimEnd() + "…";
}

type Props = {
  note: PublicNote | null;
  onExpand: (note: PublicNote) => void;
  onDismiss?: () => void;
};

// Cross-fade + slide animation. We render the card whenever `note` is
// non-null, AND keep it mounted for a beat on the way down so the
// exit animation can play. `displayed` is the note actually drawn;
// `visible` drives the transform.
export function NotePeekCard({ note, onExpand, onDismiss }: Props) {
  const [displayed, setDisplayed] = useState<PublicNote | null>(note);
  const [visible, setVisible] = useState<boolean>(note !== null);

  useEffect(() => {
    if (note) {
      setDisplayed(note);
      // Allow the dom node to mount with translateY(100%) before flipping
      // to translateY(0) so the slide animates instead of snapping.
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
      const t = setTimeout(() => setDisplayed(null), 320);
      return () => clearTimeout(t);
    }
  }, [note]);

  // Esc dismisses peek (keyboard parity with "step off to dismiss").
  useEffect(() => {
    if (!note || !onDismiss) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onDismiss?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [note, onDismiss]);

  if (typeof document === "undefined" || !displayed) return null;

  const isPinned = Boolean(displayed.is_public_pinned);
  const title = displayed.title?.trim() || "untitled";
  const excerpt = trimExcerpt(displayed.excerpt || "");
  const spaceName = displayed.space_name;
  const readMin = displayed.read_time_minutes;

  // Accent matches coin palette: gold for regular, violet for pinned
  // (the spawn-anchored "what is Gooni" intro coin).
  const accent = isPinned
    ? "linear-gradient(135deg, #c4a8ff 0%, #7c3aed 100%)"
    : "linear-gradient(135deg, #ffe79a 0%, #ffaa1f 100%)";
  const accentSolid = isPinned ? "#7c3aed" : "#ffaa1f";

  return createPortal(
    <div
      role="region"
      aria-label="Note peek"
      onClick={() => onExpand(displayed)}
      style={{
        position: "fixed",
        left: "50%",
        bottom: 28,
        transform: `translateX(-50%) translateY(${visible ? 0 : 130}%)`,
        width: "min(620px, calc(100vw - 32px))",
        background: "rgba(20,22,28,0.92)",
        color: "#fff",
        borderRadius: 18,
        padding: "16px 20px 14px",
        fontFamily: FONT,
        boxShadow: "0 18px 42px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.30), 0 0 0 1px rgba(255,255,255,0.10) inset",
        backdropFilter: "blur(14px) saturate(170%)",
        WebkitBackdropFilter: "blur(14px) saturate(170%)",
        cursor: "pointer",
        // Sits above drei <Html> nametags (which render in zIndexRange
        // [40, 50]) so avatar names don't pierce the peek card.
        zIndex: 100,
        opacity: visible ? 1 : 0,
        transition: "transform 320ms cubic-bezier(0.20, 0.84, 0.30, 1), opacity 240ms ease",
        userSelect: "none",
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.boxShadow = "0 22px 50px rgba(0,0,0,0.62), 0 2px 6px rgba(0,0,0,0.30), 0 0 0 1px rgba(255,255,255,0.20) inset";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.boxShadow = "0 18px 42px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.30), 0 0 0 1px rgba(255,255,255,0.10) inset";
      }}
    >
      {/* Top accent bar — picks up coin color */}
      <div style={{
        position: "absolute",
        top: 0, left: 18, right: 18,
        height: 3,
        background: accent,
        borderRadius: 999,
      }} />

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{
          fontSize: 10.5,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.10em",
          color: accentSolid,
        }}>
          {isPinned ? "🌟 start here" : "🪙 note"}
        </span>
        {spaceName && (
          <span style={{
            fontSize: 11,
            color: "rgba(255,255,255,0.55)",
            border: "1px solid rgba(255,255,255,0.18)",
            borderRadius: 999,
            padding: "1px 8px",
            fontWeight: 500,
          }}>
            {spaceName}
          </span>
        )}
        {readMin > 0 && (
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
            {readMin} min read
          </span>
        )}
      </div>

      <div style={{
        fontFamily: DISPLAY,
        fontSize: 22,
        lineHeight: 1.2,
        letterSpacing: "-0.01em",
        marginBottom: excerpt ? 8 : 4,
        color: "#fff",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}>
        {title}
      </div>

      {excerpt && (
        <div style={{
          fontSize: 14,
          lineHeight: 1.5,
          color: "rgba(255,255,255,0.78)",
          marginBottom: 10,
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}>
          {excerpt}
        </div>
      )}

      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: 12.5,
        color: "rgba(255,255,255,0.55)",
      }}>
        <span style={{ fontStyle: "italic" }}>
          step off the tile to dismiss
        </span>
        <span style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontWeight: 600,
          color: accentSolid,
        }}>
          tap to read <span style={{ fontSize: 14, lineHeight: 1 }}>→</span>
        </span>
      </div>
    </div>,
    document.body,
  );
}
