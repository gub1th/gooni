import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createPortal } from "react-dom";
import { useEffect } from "react";
import { ChatLogView } from "../components/ChatLogView";
import { EvalView } from "../components/eval/EvalView";
import { AllNotesDiscovery } from "../components/notes/AllNotesDiscovery";
import { NoteEditor } from "../components/notes/NoteEditor";
import { NotesList } from "../components/notes/NotesList";
import { AmbientHome } from "../components/ambient/AmbientHome";
import { MemoriesView } from "../components/memories/MemoriesView";
import { CalendarPanel } from "../components/ambient/CalendarPanel";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { fetchNote } from "../services/api";

// `/` is THE home: the ambient wave in a Momentum-like layout — wave at true
// centre, one big line under it, TODAY and the task list below that. It ended
// the three-competing-homes era (ambient home → "Focus is home" → the B4
// dashboard); `/home` and both dashboards are deleted, not parked.
//
// Everything else on this route (notes, log, audit) is a summoned sheet over
// the same void, derived from the URL.

type View = "home" | "notes" | "log" | "eval" | "memories" | "calendar";

// Every key is OPTIONAL on purpose. TanStack replaces the whole search object
// on an object-form navigate, so optionality changes nothing at runtime — but
// required keys would mean every one of the ~15 call sites across the app has
// to spell out `trackables: undefined` the day a param is added, and one missed
// site is a type error in a file that has nothing to do with the feature.
interface HomeSearch {
  note?: number;
  conv?: number;
  audit?: true;
  segment?: number;
  view?: "notes" | "log" | "memories";
  /** deep-link a single memory row — scroll + flash it (?view=memories only) */
  focus?: number;
  /** the log matrix over the home */
  trackables?: true;
  /** the week-grid calendar — a surface of its own, not an overlay on the home */
  calendar?: true;
}

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    note: typeof search.note === "number" ? search.note : typeof search.note === "string" ? Number(search.note) : undefined,
    conv: typeof search.conv === "number" ? search.conv : typeof search.conv === "string" ? Number(search.conv) : undefined,
    // ?audit=1 → land on the Audit (eval) view.
    audit: search.audit === true || search.audit === "true" || search.audit === "1" || undefined,
    // ?segment=<id> → auto-open that segment's drilldown in the audit view.
    segment: typeof search.segment === "number" ? search.segment : typeof search.segment === "string" ? Number(search.segment) : undefined,
    // ?view=notes|log|memories → force a view that has no other URL signal.
    view:
      search.view === "notes" || search.view === "log" || search.view === "memories"
        ? (search.view as "notes" | "log" | "memories")
        : undefined,
    // ?focus=<id> → the memories view scrolls that row into view and flashes it.
    focus: typeof search.focus === "number"
      ? search.focus
      : typeof search.focus === "string" && search.focus.length > 0
        ? Number(search.focus) || undefined
        : undefined,
    // ?trackables=1 → the log matrix over the home. URL-driven so the rail can
    // open it from outside the home's own state (the widget-overlay store that
    // used to carry this kind of cross-surface summon is gone).
    trackables:
      search.trackables === true || search.trackables === "true" || search.trackables === "1" || undefined,
    calendar:
      search.calendar === true || search.calendar === "true" || search.calendar === "1" || undefined,
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
    search.view === "memories" ? "memories" :
    search.calendar ? "calendar" :
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
      navigate({ search: { note: undefined, conv: undefined, audit: undefined, segment: undefined, view: undefined, trackables: undefined }, replace: true });
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
    navigate({ search: { note: undefined, conv: undefined, audit: undefined, segment: undefined, view: "notes", trackables: undefined }, replace: true });
  }

  // Store-driven URL sync. When createNote (or any other path) sets a
  // real positive activeNoteId, mirror it into ?note=<id> so refresh /
  // back-button work.
  useEffect(() => {
    if (view === "notes" && activeNoteId && activeNoteId > 0 && search.note !== activeNoteId) {
      navigate({ search: { note: activeNoteId, conv: undefined, audit: undefined, segment: undefined, view: undefined, trackables: undefined }, replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNoteId, view]);

  // Sidebar + PasswordGate live in __root.tsx's AppShell so they
  // persist across route changes. This route just renders the right-column
  // content into AppShell's <Outlet />.
  // The home is ALWAYS mounted. A non-home view is a panel that slides in over
  // it (see SurfacePanel), so the home has to still be there to slide over —
  // swapping it out is what made every surface read as a page stamped on top
  // of nothing. It is inert while covered: `covered` stands its chrome down.
  return (
    <>
      {createPortal(
        <div
          aria-hidden={view !== "home"}
          style={view === "home" ? undefined : { pointerEvents: "none" }}
        >
          <AmbientHome
          trackablesOpen={!!search.trackables}
          onCloseTrackables={() =>
            navigate({ search: { ...search, trackables: undefined }, replace: true })
          }
            covered={view !== "home"}
          />
        </div>,
        // PORTALED to the body on purpose. The home and the non-home views both
        // arrive through the same <Outlet />, so left in place the home would be
        // a CHILD of the slide-in panel — painting its void over the panel's own
        // content, which is exactly what it did. The home is app-level furniture
        // that the panel slides over, not something inside it.
        document.body,
      )}

      {view === "home" ? null : view === "log" ? (
        <ChatLogView />
      ) : view === "memories" ? (
        <MemoriesView focusId={search.focus} />
      ) : view === "calendar" ? (
        <CalendarPanel />
      ) : view === "eval" ? (
        <EvalView
          onOpenNote={(noteId: number) =>
            navigate({ search: { note: noteId, conv: undefined, audit: undefined, segment: undefined, view: undefined, trackables: undefined }, replace: true })
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
