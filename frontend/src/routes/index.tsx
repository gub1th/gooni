import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { ChatLogView } from "../components/ChatLogView";
import { EvalView } from "../components/eval/EvalView";
import { AllNotesDiscovery } from "../components/notes/AllNotesDiscovery";
import { NoteEditor } from "../components/notes/NoteEditor";
import { NotesList } from "../components/notes/NotesList";
import { FocusDashboard } from "../components/focus/FocusDashboard";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { fetchNote } from "../services/api";

// The FOCUS dashboard is the app's home now — the said-vs-done timeline + rail
// is what "/" lands on. The old waveform/capture home moved to /home (still a
// tap away via the top-right button); the bare second-monitor kiosk lives on at
// /focus. Everything else (log, notes, nav) is hover-summoned glass on top.

type View = "home" | "notes" | "log" | "eval";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    note: typeof search.note === "number" ? search.note : typeof search.note === "string" ? Number(search.note) : undefined,
    conv: typeof search.conv === "number" ? search.conv : typeof search.conv === "string" ? Number(search.conv) : undefined,
    // ?audit=1 → land on the Audit (eval) view.
    audit: search.audit === true || search.audit === "true" || search.audit === "1" || undefined,
    // ?segment=<id> → auto-open that segment's drilldown in the audit view.
    segment: typeof search.segment === "number" ? search.segment : typeof search.segment === "string" ? Number(search.segment) : undefined,
    // ?view=notes|log → force a view that has no other URL signal.
    view:
      search.view === "notes" || search.view === "log"
        ? (search.view as "notes" | "log")
        : undefined,
  }),
  component: LogPage,
});

function LogPage() {
  const { loadNotes, createNote, selectNote } = useNotesContentStore();
  const navigate = useNavigate({ from: "/" });
  const search = Route.useSearch();
  const { activeNoteId } = useNotesContentStore();

  // View is DERIVED from the URL, not stored locally. Single source of
  // truth: search params own the answer, so any navigate() — deep link,
  // browser back — flips the view immediately without a side-channel.
  const view: View =
    search.audit ? "eval" :
    search.note ? "notes" :
    search.view === "notes" ? "notes" :
    search.view === "log" ? "log" :
    "home";

  // ?note=<id> → fetch + seed the note into the store. View derives to
  // "notes" automatically from the URL param. All notes live in one flat
  // "general" bucket since Spaces died in the Slice 6 nuke.
  useEffect(() => {
    if (!search.note) return;
    fetchNote(search.note).then((note) => {
      useNotesContentStore.setState((s) => {
        const existing = s.notes["general"] ?? [];
        const idx = existing.findIndex((n) => n.id === note.id);
        const nextList = idx >= 0
          ? existing.slice().map((n, i) => (i === idx ? note : n))
          : [note, ...existing];
        return {
          notes: { ...s.notes, general: nextList },
          selectedSpaceId: "general",
          activeNoteId: note.id,
        };
      });
      loadNotes("general");
    }).catch(() => {
      navigate({ search: { note: undefined, conv: undefined, audit: undefined, segment: undefined, view: undefined }, replace: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.note]);

  useEffect(() => {
    if (view === "notes") {
      useNotesContentStore.setState({ selectedSpaceId: "general" });
      loadNotes("general");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Cmd+N: new note
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        handleCompose();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  function handleCompose() {
    createNote("general");
    // ?view=notes parks us in the notes shell while the optimistic
    // negative-id createNote resolves; the activeNoteId effect below
    // replaces it with ?note=<id> once the real id lands.
    navigate({ search: { note: undefined, conv: undefined, audit: undefined, segment: undefined, view: "notes" }, replace: true });
  }

  // Store-driven URL sync. When createNote (or any other path) sets a
  // real positive activeNoteId, mirror it into ?note=<id> so refresh /
  // back-button work.
  useEffect(() => {
    if (view === "notes" && activeNoteId && activeNoteId > 0 && search.note !== activeNoteId) {
      navigate({ search: { note: activeNoteId, conv: undefined, audit: undefined, segment: undefined, view: undefined }, replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNoteId, view]);

  // Sidebar + PasswordGate live in __root.tsx's AppShell so they
  // persist across route changes. This route just renders the right-column
  // content into AppShell's <Outlet />.
  return (
    <>
      {view === "home" ? (
        <FocusDashboard />
      ) : view === "log" ? (
        <ChatLogView />
      ) : view === "eval" ? (
        <EvalView
          onOpenNote={(noteId: number) =>
            navigate({ search: { note: noteId, conv: undefined, audit: undefined, segment: undefined, view: undefined }, replace: true })
          }
          initialSegmentId={search.segment ?? null}
        />
      ) : (() => {
        // Notes view. No active note → Confluence-style discovery (big
        // search bar + recent grid). Picking a card sets activeNoteId,
        // which flips to the standard 2-column layout.
        const showDiscovery = activeNoteId == null;
        if (showDiscovery) {
          return (
            <AllNotesDiscovery
              onSelectNote={(id) => selectNote(id)}
              onCompose={handleCompose}
            />
          );
        }
        return (
          <>
            <NotesList />
            <NoteEditor />
          </>
        );
      })()}
    </>
  );
}
