import { useState } from "react";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useDraftVersionStore } from "../../stores/useDraftVersionStore";
import { patchNote, type ApiNote } from "../../services/api";

// Floating Publish button. Sits bottom-right, just to the LEFT of the
// Gooni chat-launcher, so the Publish CTA reads as the primary editor
// action and Gooni becomes a sibling orb instead of the dominant one
// (per note 246's UX direction).
//
// Visibility — only mounted from index.tsx when:
//   - view === "notes"
//   - an active note is selected and saved (id > 0)
// so it never floats over views that don't have a note context (chat,
// dashboard, lists, etc.).

const SIZE = 72;
const GOONI_ORB_SIZE = 80;
const GOONI_RIGHT_MARGIN = 24;
// Sit on the same baseline as the Gooni orb, gap of 16px between them.
// Centred vertically against the Gooni orb so they read as a pair.
const RIGHT = GOONI_RIGHT_MARGIN + GOONI_ORB_SIZE + 16;
const BOTTOM = GOONI_RIGHT_MARGIN + (GOONI_ORB_SIZE - SIZE) / 2;

interface FloatingPublishButtonProps {
  noteId: number;
}

export function FloatingPublishButton({ noteId }: FloatingPublishButtonProps) {
  const notes = useNotesContentStore((s) => s.notes);
  const bumpDrafts = useDraftVersionStore((s) => s.bump);
  const [hover, setHover] = useState(false);
  const [press, setPress] = useState(false);

  // Find the active note across cached spaces. The store keys notes by
  // space id ("general" + numeric ids), and `activeNoteId` doesn't carry
  // the space — flat scan is fine, the cache is small.
  let active: ApiNote | undefined;
  for (const list of Object.values(notes)) {
    const found = list.find((n) => n.id === noteId);
    if (found) { active = found; break; }
  }
  if (!active) return null;
  const isPublic = !!active.is_public;

  function handleClick() {
    if (!active) return;
    const next = !isPublic;
    // Optimistic flip in the store so the orb re-renders immediately.
    useNotesContentStore.setState((s) => {
      const updated: Record<string, ApiNote[]> = {};
      for (const [k, list] of Object.entries(s.notes)) {
        updated[k] = list.map((n) =>
          n.id === noteId
            ? { ...n, is_public: next, is_draft: next ? false : n.is_draft }
            : n,
        );
      }
      return { notes: updated };
    });
    if (next && active.is_draft) bumpDrafts();
    patchNote(noteId, { is_public: next }).catch(() => {
      // Rollback on failure
      useNotesContentStore.setState((s) => {
        const updated: Record<string, ApiNote[]> = {};
        for (const [k, list] of Object.entries(s.notes)) {
          updated[k] = list.map((n) =>
            n.id === noteId ? { ...n, is_public: !next } : n,
          );
        }
        return { notes: updated };
      });
    });
  }

  const scale = press ? 0.94 : hover ? 1.06 : 1;
  // Two visual states. Unpublished = bold "Publish" CTA in dark; published
  // = soft green confirmation. Both keep the same orb shape so the slot is
  // visually stable as Daniel toggles it.
  const bg = isPublic
    ? "linear-gradient(135deg, #34C759 0%, #1F9E45 100%)"
    : "linear-gradient(135deg, #1F2937 0%, #0F172A 100%)";
  const fg = "#FFFFFF";
  const ring = isPublic ? "rgba(52,199,89,0.32)" : "rgba(15,23,42,0.32)";

  return (
    <>
      <style>{`
        @keyframes gooni-publish-pulse {
          0%, 100% { box-shadow: 0 0 0 0 ${ring}; }
          50%      { box-shadow: 0 0 0 8px ${ring.replace(/0\.32\)/, "0)")}; }
        }
      `}</style>
      <button
        onClick={handleClick}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => { setHover(false); setPress(false); }}
        onPointerDown={() => setPress(true)}
        onPointerUp={() => setPress(false)}
        title={isPublic ? "Unpublish from portfolio" : "Publish to portfolio"}
        aria-label={isPublic ? "Unpublish note" : "Publish note"}
        style={{
          position: "fixed",
          bottom: BOTTOM,
          right: RIGHT,
          width: SIZE,
          height: SIZE,
          borderRadius: "50%",
          background: bg,
          color: fg,
          border: "none",
          cursor: "pointer",
          zIndex: 999,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
          transform: `scale(${scale})`,
          transition: "transform 0.15s ease, background 0.2s ease",
          animation: "gooni-publish-pulse 3.6s ease-in-out infinite",
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
          boxShadow: "0 6px 20px rgba(15,23,42,0.18), 0 1px 2px rgba(15,23,42,0.18)",
          outline: "none",
        }}
      >
        <svg
          width={22}
          height={22}
          viewBox="0 0 24 24"
          fill="none"
          stroke={fg}
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a13.5 13.5 0 0 1 0 18" />
          <path d="M12 3a13.5 13.5 0 0 0 0 18" />
        </svg>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.2 }}>
          {isPublic ? "Live" : "Publish"}
        </span>
      </button>
    </>
  );
}
