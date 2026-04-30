import { useEffect, useState } from "react";
import { fetchNote, type ApiNote } from "../services/api";
import { useConversationsStore } from "../stores/useConversationsStore";
import { useGooniStore } from "../stores/useGooniStore";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { GooniPanel } from "./GooniPanel";
import { NoteEditor } from "./notes/NoteEditor";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

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
  const setMascotSuppressed = useGooniStore((s) => s.setMascotSuppressed);
  const { selectSpace, selectNote, loadNotes } = useNotesContentStore();

  useEffect(() => {
    let cancelled = false;
    setMascotSuppressed(true);
    fetchNote(noteId).then((n) => {
      if (cancelled) return;
      setNote(n);
      // Push the note into the editor's store so NoteEditor renders it
      // editably (instead of the prior dangerouslySetInnerHTML viewer).
      const sid = n.space_id == null ? "general" : String(n.space_id);
      selectSpace(sid);
      loadNotes(sid).catch(() => {});
      selectNote(n.id);
      // Auto-engage plan mode the first time we mount with this note.
      // Subsequent renders skip — `messages.length === 0` is the guard.
      if (useConversationsStore.getState().messages.length === 0) {
        planNote({ title: n.title, content: n.content }).catch(console.error);
      }
    }).catch(() => setLoadError(true));
    return () => {
      cancelled = true;
      setMascotSuppressed(false);
    };
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

      {/* Left: editable NoteEditor — Daniel can keep writing while Gooni
          sketches a plan in the right panel. Same component as the regular
          editor, so all the autosave / classify / image-paste behaviour
          comes along for free. */}
      <div style={{
        flex: 1, minWidth: 0, display: "flex", flexDirection: "column",
        position: "relative",
      }}>
        <button
          onClick={onExit}
          style={{
            alignSelf: "flex-start",
            fontSize: 12, color: "#6B6B70",
            background: "transparent", border: "none",
            padding: "12px 0 4px 24px", cursor: "pointer", fontFamily: FONT,
          }}
          aria-label="Back to dashboard"
        >← back</button>
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {loadError ? (
            <p style={{ color: "#C7C7CC", padding: 24 }}>Couldn't load this note.</p>
          ) : note ? (
            <NoteEditor />
          ) : (
            <p style={{ color: "#C7C7CC", padding: 24 }}>Loading…</p>
          )}
        </div>
      </div>

      {/* Right: docked Gooni chat. Drag-to-resize edge already lives in
          GooniPanel. Width persists via useGooniStore. */}
      <GooniPanel
        dockedWidth={420}
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
