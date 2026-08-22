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
import { LogDots } from "../components/ambient/LogDots";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { fetchNote } from "../services/api";

// `/` is THE home: the ambient wave in a Momentum-like layout — wave at true
// centre, one big line under it, TODAY and the task list below that. It ended
// the three-competing-homes era (ambient home → "Focus is home" → the B4
// dashboard); `/home` and both dashboards are deleted, not parked.
//
// Everything else on this route (notes, log, audit) is a summoned sheet over
// the same void, derived from the URL.

type View = "home" | "notes" | "log" | "eval" | "memories" | "calendar" | "trackables";

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

/**
 * A boolean search flag, as it can actually arrive.
 *
 * The router JSON-parses search values, so `?audit=1` reaches here as the
 * NUMBER 1 — and every one of these flags was tested against the STRING "1",
 * which meant the documented deep links (`?audit=1`, `?trackables=1`,
 * `?calendar=1`) parsed to undefined and the router immediately rewrote the URL
 * back to a bare `/`. Silent: typing the URL in the docs simply dropped you on
 * the home. One reader for all three, so they cannot disagree again.
 */
function flag(raw: unknown): true | undefined {
  if (raw === true || raw === 1) return true;
  if (typeof raw === "string") {
    const v = raw.toLowerCase();
    if (v === "true" || v === "1" || v === "yes") return true;
  }
  return undefined;
}

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    note: typeof search.note === "number" ? search.note : typeof search.note === "string" ? Number(search.note) : undefined,
    conv: typeof search.conv === "number" ? search.conv : typeof search.conv === "string" ? Number(search.conv) : undefined,
    // ?audit=1 → land on the Audit (eval) view.
    audit: flag(search.audit),
    // ?segment=<id> → auto-open that segment's drilldown in the audit view.
    segment: typeof search.segment === "number" ? search.segment : typeof search.segment === "string" ? Number(search.segment) : undefined,
    // ?view=notes|log|memories → force a view that has no other URL signal.
    // Settings is NOT here: it is a modal over whatever page you are on, so it
    // has no URL of its own by design (pass 9).
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
    trackables: flag(search.trackables),
    calendar: flag(search.calendar),
  }),
  component: LogPage,
});

function LogPage() {
  // Per-field selectors, not two whole-store destructures. Destructuring
  // subscribes to every store write; this component only needs three stable
  // actions and one id.
  const loadNotes = useNotesContentStore((s) => s.loadNotes);
  const createNote = useNotesContentStore((s) => s.createNote);
  const selectNote = useNotesContentStore((s) => s.selectNote);
  const activeNoteId = useNotesContentStore((s) => s.activeNoteId);
  const navigate = useNavigate({ from: "/" });
  const search = Route.useSearch();

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
    search.trackables ? "trackables" :
    "home";

  // ?note=<id> → fetch + seed the note into the store. View derives to
  // "notes" automatically from the URL param. All notes live in one flat
  // "general" bucket since Spaces died in the Slice 6 nuke.
  useEffect(() => {
    if (!search.note) return;
    fetchNote(search.note).then((note) => {
      useNotesContentStore.setState((s) => {
        const idx = s.notes.findIndex((n) => n.id === note.id);
        const next = idx >= 0
          ? s.notes.map((n, i) => (i === idx ? note : n))
          : [note, ...s.notes];
        return { notes: next, activeNoteId: note.id };
      });
      loadNotes();
    }).catch(() => {
      navigate({ search: { note: undefined, conv: undefined, audit: undefined, segment: undefined, view: undefined, trackables: undefined }, replace: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.note]);

  useEffect(() => {
    if (view === "notes") {
      loadNotes();
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
    createNote();
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
          style={{
            pointerEvents: view === "home" ? undefined : "none",
            // NO TRANSFORM HERE. EVER. Not an identity one, not a 12px nudge.
            //
            // AmbientHome's stage root is `position: fixed; inset: 0`, and ANY
            // transform on an ancestor makes that ancestor the containing block
            // for its fixed descendants, per CSS. This wrapper's only child is
            // then out of flow, so the wrapper itself lays out as a zero-height
            // box at the end of the document — measured live while a surface was
            // open: wrapper rect `[12, 2029, 1200x0]`, and the stage inside it
            // inheriting exactly that. The home was not merely dimmed behind the
            // panel, it was COLLAPSED AND SCROLLED OFF THE BOTTOM.
            //
            // That was the whole of "the panel just disappears instead of
            // revealing the home": the exit slide worked, but there was nothing
            // underneath it to reveal. The nudge this replaced was added to make
            // the return read as an arrival; it cost the arrival its subject.
            // The reveal comes from SurfacePanel sliding OUT to the right over a
            // home that stayed exactly where it was — which is the stronger read
            // anyway, because the home is the anchor and anchors do not move.
            //
            // If a future pass wants the home itself to move, it must animate a
            // descendant INSIDE AmbientHome that has no fixed children, never
            // this wrapper.
          }}
        >
          <AmbientHome
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
      ) : view === "trackables" ? (
        <LogDots
          mode="matrix"
          embedded
          onClose={() => navigate({ search: { ...search, trackables: undefined }, replace: true })}
        />
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
