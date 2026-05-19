import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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

  // Initialize view from URL so deep-linking a note doesn't flash the dashboard first.
  const [view, setView] = useState<"notes" | "dashboard" | "chat" | "lists" | "eval">(() =>
    search.audit ? "eval" : search.note ? "notes" : search.conv ? "chat" : search.list ? "lists" : search.view ?? "dashboard"
  );
  const [activeListId, setActiveListId] = useState<number | null>(search.list ?? null);

  // Initial load: restore from URL params
  useEffect(() => {
    fetchSpaces();
    fetchConversations();
    fetchAllLists();
    // Note: search.note / search.conv handling moved to dedicated effect below
    // so navigation TO this page (e.g. from the notes-map "open this note")
    // also takes effect, not just the first mount.
  }, []);

  // React to search.note changes — fires both on initial mount and on
  // subsequent navigations (e.g. clicking a node in the notes map while
  // already on /). Without this, navigate({ to: "/", search: { note } })
  // from elsewhere would silently no-op when the page is already mounted.
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
      setView("notes");
    }).catch(() => {
      setView("dashboard");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.note]);

  // Same pattern for conversation deep-links.
  useEffect(() => {
    if (!search.conv) return;
    selectConversation(search.conv);
    setView("chat");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.conv]);

  // Same pattern for list deep-links. Without this, navigating to
  // `/?list=N` while already on `/` (e.g. clicking the composer "Routed:
  // backlog" pill, or the chat-audit/memories sidebars' onSelectList) only
  // updated the URL — the view stayed wherever it was. Initial mount used
  // search.list via useState, so refresh worked; subsequent navigations
  // didn't.
  useEffect(() => {
    if (!search.list) return;
    setActiveListId(search.list);
    setView("lists");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.list]);

  // ?audit=1 lands directly on the Audit tab.
  useEffect(() => {
    if (search.audit) setView("eval");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.audit]);

  // ?view=notes|chat forces a view that has no other URL signal (All Notes,
  // space row, fresh-chat). Sidebar lives in __root.tsx's AppShell, so it
  // can't call setView directly — it drives the view through this param.
  useEffect(() => {
    if (search.view === "notes" || search.view === "chat") setView(search.view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.view]);

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

  function setViewAndUrl(
    v: "notes" | "dashboard" | "chat" | "lists" | "eval",
    noteId?: number,
    convId?: number,
    listId?: number,
  ) {
    setView(v);
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
    setView("notes");
    selectSpace(spaceId);
    createNote(spaceId);
    navigate({ search: { note: undefined, conv: undefined, list: undefined , audit: undefined, segment: undefined, view: undefined}, replace: true });
  }

  // When active note changes while in notes view, update URL
  const { activeNoteId } = useNotesContentStore();
  useEffect(() => {
    if (view === "notes" && activeNoteId && activeNoteId > 0) {
      navigate({ search: { note: activeNoteId, conv: undefined, list: undefined , audit: undefined, segment: undefined, view: undefined}, replace: true });
    }
  }, [activeNoteId, view]);

  // When active conversation changes while in chat view, update URL
  const { activeId: activeConvId } = useConversationsStore();
  useEffect(() => {
    if (view === "chat" && activeConvId) {
      navigate({ search: { note: undefined, conv: activeConvId, list: undefined , audit: undefined, segment: undefined, view: undefined}, replace: true });
    }
  }, [activeConvId, view]);

  // Sidebar + GooniLayer + PasswordGate live in __root.tsx's AppShell so they
  // persist across route changes. This route just renders the right-column
  // content into AppShell's <Outlet />.
  return (
    <>
        {view === "dashboard" ? (
          <Dashboard
            onOpenNote={() => setView("notes")}
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
