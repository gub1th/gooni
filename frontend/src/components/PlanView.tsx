import { useEffect, useState } from "react";
import { fetchNote, type ApiNote } from "../services/api";
import { useConversationsStore } from "../stores/useConversationsStore";
import { GooniPanel } from "./GooniPanel";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";

interface Props {
  noteId: number;
  onExit: () => void;
}

// Note-on-the-left, Gooni-on-the-right planning surface.
// Routed in via the "💬 Plan this" pill on the dashboard. The note
// stays visible while Gooni asks clarifying questions and sketches a
// plan; on finalize, Gooni emits a <plan>...</plan> block which the
// chat renderer turns into a "Save to note" card (lands in §3.D).
export function PlanView({ noteId, onExit }: Props) {
  const [note, setNote] = useState<ApiNote | null>(null);
  const [loadError, setLoadError] = useState(false);
  const planNote = useConversationsStore((s) => s.planNote);

  useEffect(() => {
    let cancelled = false;
    fetchNote(noteId).then((n) => {
      if (cancelled) return;
      setNote(n);
      // Auto-engage plan mode the first time we mount with this note.
      // Subsequent renders skip — `messages.length === 0` is the guard.
      if (useConversationsStore.getState().messages.length === 0) {
        planNote({ title: n.title, content: n.content }).catch(console.error);
      }
    }).catch(() => setLoadError(true));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  return (
    <div style={{
      flex: 1, display: "flex", height: "100%",
      background: "#FAFAFA", fontFamily: FONT,
      animation: "gooni-plan-fade-in 280ms cubic-bezier(0.22, 1, 0.36, 1)",
    }}>
      <style>{`
        @keyframes gooni-plan-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* Left: note viewer (read-only for v1). Daniel sees what he's
          planning while Gooni writes the plan. */}
      <div style={{
        flex: 1, minWidth: 0, overflowY: "auto",
        padding: "32px 48px",
        display: "flex", flexDirection: "column", gap: 12,
      }}>
        <button
          onClick={onExit}
          style={{
            alignSelf: "flex-start",
            fontSize: 12, color: "#6B6B70",
            background: "transparent", border: "none",
            padding: "4px 0", cursor: "pointer", fontFamily: FONT,
            marginBottom: 4,
          }}
          aria-label="Back to dashboard"
        >← back</button>

        {loadError ? (
          <p style={{ color: "#C7C7CC" }}>Couldn't load this note.</p>
        ) : note ? (
          <>
            <h1 style={{
              fontSize: 26, fontWeight: 700, color: "#1C1C1E",
              margin: 0, lineHeight: 1.2,
            }}>{note.title?.trim() || "Untitled"}</h1>
            <div
              style={{
                fontSize: 14.5, color: "#3A3A3C", lineHeight: 1.6,
                fontFamily: FONT,
              }}
              // Note bodies are TipTap HTML — already trusted, written by Daniel.
              dangerouslySetInnerHTML={{ __html: note.content ?? "" }}
            />
          </>
        ) : (
          <p style={{ color: "#C7C7CC" }}>Loading…</p>
        )}
      </div>

      {/* Right: docked Gooni chat. Drag-to-resize edge already lives in
          GooniPanel. Width persists via useGooniStore. */}
      <GooniPanel
        planContext={note ? {
          noteId: note.id,
          noteContent: note.content ?? "",
          onSaved: () => {
            // Refetch so the left-side viewer shows the appended plan.
            fetchNote(noteId).then(setNote).catch(console.error);
          },
        } : undefined}
      />
    </div>
  );
}
