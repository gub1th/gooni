import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PublicNote } from "../../services/api";
import { FONT } from "../../ui";

// Bottom-anchored peek bar — slides up from the bottom of the viewport
// when the player lands on a note-tile, slides back down on leave.
// Click anywhere on the card → triggers onSelect → existing
// NoteReaderOverlay opens (fullscreen reader). This keeps the 3D scene
// uncovered while the peek text reads at real DOM sizes, not tiny
// drei <Html> sizes that vanish at distance.
//
// Rendered via portal to document.body so it sits outside the R3F
// Canvas tree and shows above all 3D content without z-index fights.

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

  // Dark frosted skin — matches the "view cv" pill language (dark surface,
  // glowing-green accent, muted-gray text) so the callouts feel on-brand
  // instead of the old cream retro box.
  const INK = "rgba(242,239,232,0.92)";
  const DIM = "rgba(242,239,232,0.60)";
  const LINE = "rgba(242,239,232,0.14)";
  const GREEN = "#4ADE80";

  return createPortal(
    <div
      role="region"
      aria-label="Note peek"
      onClick={() => onExpand(displayed)}
      style={{
        position: "fixed",
        left: "50%",
        bottom: 34,
        transform: `translateX(-50%) translateY(${visible ? 0 : 130}%)`,
        width: "min(620px, calc(100vw - 40px))",
        background: "rgba(16,20,18,0.82)",
        backdropFilter: "blur(20px) saturate(140%)",
        WebkitBackdropFilter: "blur(20px) saturate(140%)",
        color: INK,
        border: `1px solid ${LINE}`,
        boxShadow: "0 18px 50px rgba(0,0,0,0.45)",
        borderRadius: 18,
        padding: "16px 22px 15px",
        fontFamily: DISPLAY,
        cursor: "pointer",
        // Sits above drei <Html> nametags (which render in zIndexRange
        // [40, 50]) so avatar names don't pierce the peek card.
        zIndex: 100,
        opacity: visible ? 1 : 0,
        transition: "transform 320ms cubic-bezier(0.20, 0.84, 0.30, 1), opacity 240ms ease",
        userSelect: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          color: GREEN,
          fontFamily: FONT,
        }}>
          {isPinned ? "🌟 start here" : "🪙 note"}
        </span>
        {spaceName && (
          <span style={{
            fontSize: 11,
            color: DIM,
            border: `1px solid ${LINE}`,
            borderRadius: 999,
            padding: "1px 8px",
            fontWeight: 500,
            fontFamily: FONT,
          }}>
            {spaceName}
          </span>
        )}
        {readMin > 0 && (
          <span style={{ fontSize: 11, color: DIM, fontFamily: FONT }}>
            {readMin} min read
          </span>
        )}
      </div>

      <div style={{
        fontFamily: DISPLAY,
        fontSize: 23,
        lineHeight: 1.2,
        letterSpacing: "-0.01em",
        marginBottom: excerpt ? 8 : 4,
        color: INK,
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
          color: "rgba(242,239,232,0.72)",
          marginBottom: 10,
          fontFamily: FONT,
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
        color: DIM,
        fontFamily: FONT,
        borderTop: `1px solid ${LINE}`,
        paddingTop: 10,
      }}>
        <span style={{ fontStyle: "italic" }}>
          step off the tile to dismiss
        </span>
        <span style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontWeight: 700,
          color: GREEN,
        }}>
          tap to read <span style={{ fontSize: 14, lineHeight: 1 }}>→</span>
        </span>
      </div>
    </div>,
    document.body,
  );
}
