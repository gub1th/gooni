import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { ChatView } from "../components/ChatView";
import { Dashboard } from "../components/Dashboard";
import { EvalView } from "../components/eval/EvalView";
import { BacklogBoard } from "../components/lists/BacklogBoard";
import { ListView } from "../components/lists/ListView";
import { AllNotesDiscovery } from "../components/notes/AllNotesDiscovery";
import { NoteEditor } from "../components/notes/NoteEditor";
import { NotesList } from "../components/notes/NotesList";
import { useListsStore } from "../stores/useListsStore";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { useSpacesStore } from "../stores/useSpacesStore";
import { useConversationsStore } from "../stores/useConversationsStore";
import { fetchNote } from "../services/api";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    note: typeof search.note === "number" ? search.note : typeof search.note === "string" ? Number(search.note) : undefined,
    conv: typeof search.conv === "number" ? search.conv : typeof search.conv === "string" ? Number(search.conv) : undefined,
    list: typeof search.list === "number" ? search.list : typeof search.list === "string" ? Number(search.list) : undefined,
    // ?audit=1 → land on the Audit (eval) view. Lets the Sidebar Audit
    // button navigate from any route (including /memories, /chat-audit)
    // without each route having to wire an onOpenEval prop.
    audit: search.audit === true || search.audit === "true" || search.audit === "1" || undefined,
    // ?segment=<id> → auto-open that segment's drilldown when the audit
    // view mounts. Used by the Ops eval section's "open full" deeplink.
    segment: typeof search.segment === "number" ? search.segment : typeof search.segment === "string" ? Number(search.segment) : undefined,
    // ?view=notes|chat → force a view that has no other URL signal.
    // Sidebar uses this to drive All Notes / space-row / new-chat clicks
    // now that it lives in __root's AppShell and can't call setView().
    view: search.view === "notes" || search.view === "chat" ? (search.view as "notes" | "chat") : undefined,
  }),
  component: NotesPage,
});

function NotesPage() {
  const fetchSpaces = useSpacesStore((s) => s.fetch);
  const { selectedSpaceId, selectSpace, loadNotes, createNote, selectNote } = useNotesContentStore();
  const { fetchConversations, selectConversation } = useConversationsStore();
  const fetchAllLists = useListsStore((s) => s.fetchAll);
  const allLists = useListsStore((s) => s.lists);
  const navigate = useNavigate({ from: "/" });
  const search = Route.useSearch();
  const { activeNoteId } = useNotesContentStore();

  // View is DERIVED from the URL, not stored locally. Single source of
  // truth: search params own the answer, so any navigate() — Gooni-logo
  // click, deep link, browser back — flips the view immediately without
  // a side-channel.
  //
  // The compose path is the one subtlety: createNote stamps a negative
  // temp activeNoteId (-Date.now()) BEFORE the URL knows about it.
  // handleCompose writes ?view=notes to the URL so the view derivation
  // reads "notes" through that gap; the effect further down replaces
  // ?view=notes with ?note=<id> once the real positive id lands.
  const view: "notes" | "dashboard" | "chat" | "lists" | "eval" =
    search.audit ? "eval" :
    search.note ? "notes" :
    search.conv ? "chat" :
    search.list ? "lists" :
    search.view === "notes" ? "notes" :
    search.view === "chat" ? "chat" :
    "dashboard";

  const activeListId: number | null = search.list ?? null;

  // Initial load: prefetch core stores. Search-param effects below own
  // the per-param fetches (fetchNote, selectConversation, etc.) so they
  // re-fire on subsequent in-page navigations, not just on first mount.
  useEffect(() => {
    fetchSpaces();
    fetchConversations();
    fetchAllLists();
  }, []);

  // ?note=<id> → fetch + seed the note into the store. View derives to
  // "notes" automatically from the URL param; this effect handles the
  // side effects (fetch, store seed, space switch).
  //
  // All Zustand mutations land in ONE setState so no intermediate render
  // observes `activeNoteId === null` between the selectSpace call (which
  // internally clears activeNoteId via selectNote(null)) and the followup
  // selectNote(note.id). The intermediate-null state used to cause the
  // brain-modal flow to land on the All-Notes discovery view instead of
  // the editor, because React would observe the cleared activeNoteId
  // before the re-set landed.
  useEffect(() => {
    if (!search.note) return;
    fetchNote(search.note).then((note) => {
      const noteSpaceId = note.space_id == null ? "general" : String(note.space_id);
      // Don't yank the user out of "All Notes" just because they clicked a
      // note that lives in a specific space. If selectedSpaceId is "general"
      // (or unset), keep them there so the second column doesn't reflow.
      // Otherwise, follow the note into its space — that's the deep-link
      // case (notes-map / search), where the user expects to land in
      // context.
      const current = useNotesContentStore.getState().selectedSpaceId;
      const stayOnAllNotes = current == null || current === "general";
      const targetSpace = stayOnAllNotes ? "general" : noteSpaceId;

      useNotesContentStore.setState((s) => {
        const existing = s.notes[targetSpace] ?? [];
        const idx = existing.findIndex((n) => n.id === note.id);
        // Seed/refresh the note in the target space's list so NoteEditor's
        // `notes[spaceId].find(...)` resolves on the very next render.
        const nextList = idx >= 0
          ? existing.slice().map((n, i) => (i === idx ? note : n))
          : [note, ...existing];
        return {
          notes: { ...s.notes, [targetSpace]: nextList },
          selectedSpaceId: targetSpace,
          activeNoteId: note.id,
        };
      });
      loadNotes(targetSpace);
    }).catch(() => {
      // Bad note id — strip it from the URL so view falls back to dashboard.
      navigate({ search: { note: undefined, conv: undefined, list: undefined, audit: undefined, segment: undefined, view: undefined }, replace: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.note]);

  // ?conv=<id> → select the conversation. View derives to "chat".
  useEffect(() => {
    if (!search.conv) return;
    selectConversation(search.conv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.conv]);

  useEffect(() => {
    if (view === "notes") {
      const spaceId = selectedSpaceId ?? "general";
      // Setting selectedSpaceId via raw setState here instead of selectSpace()
      // because selectSpace internally calls selectNote(null), which would
      // wipe out a just-set activeNoteId from the search.note deep-link
      // effect (e.g. brain-map node click). loadNotes still runs so the
      // list refreshes.
      if (!selectedSpaceId) {
        useNotesContentStore.setState({ selectedSpaceId: "general" });
      }
      loadNotes(spaceId);
    }
  }, [view]);

  // (Auto-select on space entry was removed — it caused confusing behavior when the
  //  most-recent note lived in both a specific space and All Notes. The editor now
  //  shows an empty state, and the user picks a note from the rail.)

  useEffect(() => {
    if (view !== "notes" && selectedSpaceId) {
      selectSpace(null);
    }
  }, [view, selectedSpaceId]);

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
  }, [selectedSpaceId, view]);

  // G3.9 loop-close: chat action chip → focus the corresponding todo on
  // the dashboard. If view is already dashboard, TodoList catches the
  // event directly. Otherwise we flip view, then re-fire the event on a
  // microtask delay so the freshly-mounted TodoList listener catches it.
  useEffect(() => {
    function onFocusTodo(e: Event) {
      const ev = e as CustomEvent<{ todoId: number }>;
      const todoId = ev.detail?.todoId;
      if (typeof todoId !== "number") return;
      if (view !== "dashboard") {
        setViewAndUrl("dashboard");
        // Re-fire so the now-mounted TodoList catches it.
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent("gooni:focus-todo", { detail: { todoId } }));
        }, 120);
      }
      // If already on dashboard, TodoList's own listener will handle
      // scroll + flash; no view change needed.
    }
    window.addEventListener("gooni:focus-todo", onFocusTodo);
    return () => window.removeEventListener("gooni:focus-todo", onFocusTodo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  function setViewAndUrl(
    v: "notes" | "dashboard" | "chat" | "lists" | "eval",
    noteId?: number,
    convId?: number,
    listId?: number,
  ) {
    if (v === "notes" && noteId) {
      navigate({ search: { note: noteId, conv: undefined, list: undefined , audit: undefined, segment: undefined, view: undefined}, replace: true });
    } else if (v === "chat" && convId) {
      navigate({ search: { note: undefined, conv: convId, list: undefined , audit: undefined, segment: undefined, view: undefined}, replace: true });
    } else if (v === "lists" && listId) {
      navigate({ search: { note: undefined, conv: undefined, list: listId , audit: undefined, segment: undefined, view: undefined}, replace: true });
    } else {
      navigate({ search: { note: undefined, conv: undefined, list: undefined , audit: undefined, segment: undefined, view: undefined}, replace: true });
    }
  }

  function handleCompose() {
    const spaceId = selectedSpaceId ?? "general";
    selectSpace(spaceId);
    createNote(spaceId);
    // ?view=notes parks us in the notes shell while the optimistic
    // negative-id createNote resolves. The activeNoteId effect below
    // replaces ?view=notes with ?note=<id> once the real id lands.
    navigate({ search: { note: undefined, conv: undefined, list: undefined, audit: undefined, segment: undefined, view: "notes" }, replace: true });
  }

  // Store-driven URL sync. When createNote (or any other path) sets a
  // real positive activeNoteId, mirror it into ?note=<id> so refresh /
  // back-button work and view derivation lands on "notes" via search.note.
  useEffect(() => {
    if (view === "notes" && activeNoteId && activeNoteId > 0 && search.note !== activeNoteId) {
      navigate({ search: { note: activeNoteId, conv: undefined, list: undefined , audit: undefined, segment: undefined, view: undefined}, replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNoteId, view]);

  // Mirror active conversation id into ?conv=<id> for refresh/back-button.
  const { activeId: activeConvId } = useConversationsStore();
  useEffect(() => {
    if (view === "chat" && activeConvId && search.conv !== activeConvId) {
      navigate({ search: { note: undefined, conv: activeConvId, list: undefined , audit: undefined, segment: undefined, view: undefined}, replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvId, view]);

  // Sidebar + GooniLayer + PasswordGate live in __root.tsx's AppShell so they
  // persist across route changes. This route just renders the right-column
  // content into AppShell's <Outlet />.
  return (
    <>
        {view === "dashboard" ? (
          <Dashboard
            onOpenNote={() => navigate({ search: { note: undefined, conv: undefined, list: undefined, audit: undefined, segment: undefined, view: "notes" }, replace: true })}
          />
        ) : view === "chat" ? (
          <ChatView />
        ) : view === "lists" && activeListId != null ? (() => {
          // Backlog gets the Jira-style 3-column board with drag + modal.
          // Other list types stay on the original flat ListView. Decision
          // made here (instead of inside ListView) so we don't risk a
          // conditional-hook order violation by short-circuiting the
          // ListView render before its useState/useRef declarations.
          const list = allLists.find((l) => l.id === activeListId);
          if (list?.type === "backlog") {
            return (
              <BacklogBoard
                listId={activeListId}
                onOpenSourceNote={(noteId) => setViewAndUrl("notes", noteId)}
              />
            );
          }
          return (
            <ListView
              listId={activeListId}
              onOpenSourceNote={(noteId) => setViewAndUrl("notes", noteId)}
            />
          );
        })() : view === "eval" ? (
          <EvalView
            onOpenNote={(noteId) => setViewAndUrl("notes", noteId)}
            initialSegmentId={search.segment ?? null}
          />
        ) : (() => {
          // Notes view. When the user is in All Notes (no specific space
          // chosen) AND has no active note, swap the standard 2-column
          // (NotesList + NoteEditor empty state) for a Confluence-style
          // discovery: big search bar + recent notes grid. Picking a card
          // sets activeNoteId — which flips us back to the standard layout
          // since `activeNoteId != null` falls through to the else branch.
          const inAllNotes = selectedSpaceId == null || selectedSpaceId === "general";
          const showDiscovery = inAllNotes && activeNoteId == null;
          if (showDiscovery) {
            return (
              <AllNotesDiscovery
                onSelectNote={(id) => {
                  // Mirror the search.note effect path: seed the note into
                  // the store + select it. The URL effect on activeNoteId
                  // keeps `?note=` in sync.
                  selectNote(id);
                }}
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
