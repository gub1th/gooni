import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChatView } from "../components/ChatView";
import { Dashboard } from "../components/Dashboard";
import { EvalView } from "../components/eval/EvalView";
import { StatsView } from "../components/StatsView";
import { GooniLayer } from "../components/GooniLayer";
import { BacklogBoard } from "../components/lists/BacklogBoard";
import { ListView } from "../components/lists/ListView";
import { AllNotesDiscovery } from "../components/notes/AllNotesDiscovery";
import { NoteEditor } from "../components/notes/NoteEditor";
import { FloatingPublishButton } from "../components/notes/FloatingPublishButton";
import { NotesList } from "../components/notes/NotesList";
import { PlanView } from "../components/PlanView";
import { Sidebar } from "../components/notes/Sidebar";
import { PasswordGate } from "../components/PasswordGate";
import { useWindowWidth } from "../hooks/useWindowWidth";
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
  }),
  component: NotesPage,
});

// Sidebar auto-collapses below this width
const SIDEBAR_BREAKPOINT = 768;

function NotesPage() {
  const fetchSpaces = useSpacesStore((s) => s.fetch);
  const { selectedSpaceId, selectSpace, loadNotes, createNote, selectNote } = useNotesContentStore();
  const windowWidth = useWindowWidth();
  const { fetchConversations, newChat, selectConversation } = useConversationsStore();
  const fetchAllLists = useListsStore((s) => s.fetchAll);
  const allLists = useListsStore((s) => s.lists);
  const navigate = useNavigate({ from: "/" });
  const search = Route.useSearch();

  // Initialize view from URL so deep-linking a note doesn't flash the dashboard first.
  const [view, setView] = useState<"notes" | "dashboard" | "chat" | "lists" | "plan" | "eval" | "stats">(() =>
    search.audit ? "eval" : search.note ? "notes" : search.conv ? "chat" : search.list ? "lists" : "dashboard"
  );
  const [activeListId, setActiveListId] = useState<number | null>(search.list ?? null);
  // Note currently being planned (set by Dashboard's "💬 Plan this" pill).
  // Lives in route state so the Plan view can mount/unmount cleanly without
  // polluting the conversations store with a "current planning target" field.
  const [planNoteId, setPlanNoteId] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(windowWidth >= SIDEBAR_BREAKPOINT);

  useEffect(() => {
    setSidebarOpen(windowWidth >= SIDEBAR_BREAKPOINT);
  }, [windowWidth >= SIDEBAR_BREAKPOINT]);

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
      if (!stayOnAllNotes && current !== noteSpaceId) {
        selectSpace(noteSpaceId);
      } else if (current == null) {
        selectSpace("general");
      }
      // Seed the fetched note into the store so NoteEditor finds it on the
      // very next render. Without this, selectNote sets activeNoteId but the
      // editor's lookup `notes[spaceId].find(n => n.id === activeNoteId)`
      // returns undefined until loadNotes resolves — leaving Daniel staring
      // at an empty "All Notes" screen for the duration of that fetch.
      //
      // If the note is already in the list (the common click-from-rail
      // case), update it in place to preserve sort position. Prepending it
      // unconditionally caused a visible "jump to top, snap back" on every
      // click as loadNotes restored the original order milliseconds later.
      useNotesContentStore.setState((s) => {
        const existing = s.notes[targetSpace] ?? [];
        const idx = existing.findIndex((n) => n.id === note.id);
        if (idx >= 0) {
          const next = existing.slice();
          next[idx] = note;
          return { notes: { ...s.notes, [targetSpace]: next } };
        }
        // Not in this list yet — prepend so the editor finds it immediately;
        // loadNotes will reconcile order on its next pass.
        return { notes: { ...s.notes, [targetSpace]: [note, ...existing] } };
      });
      selectNote(note.id);
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

  useEffect(() => {
    if (view === "notes") {
      const spaceId = selectedSpaceId ?? "general";
      if (!selectedSpaceId) selectSpace("general");
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
    v: "notes" | "dashboard" | "chat" | "lists" | "plan" | "eval" | "stats",
    noteId?: number,
    convId?: number,
    listId?: number,
  ) {
    setView(v);
    if (v === "notes" && noteId) {
      navigate({ search: { note: noteId, conv: undefined, list: undefined , audit: undefined}, replace: true });
    } else if (v === "chat" && convId) {
      navigate({ search: { note: undefined, conv: convId, list: undefined , audit: undefined}, replace: true });
    } else if (v === "lists" && listId) {
      navigate({ search: { note: undefined, conv: undefined, list: listId , audit: undefined}, replace: true });
    } else {
      navigate({ search: { note: undefined, conv: undefined, list: undefined , audit: undefined}, replace: true });
    }
  }

  function handleSelectList(id: number) {
    setActiveListId(id);
    setViewAndUrl("lists", undefined, undefined, id);
  }

  function handleNewChat() {
    newChat();
    setViewAndUrl("chat");
  }

  function handleCompose() {
    const spaceId = selectedSpaceId ?? "general";
    setView("notes");
    selectSpace(spaceId);
    createNote(spaceId);
    navigate({ search: { note: undefined, conv: undefined, list: undefined , audit: undefined}, replace: true });
  }

  // When active note changes while in notes view, update URL
  const { activeNoteId } = useNotesContentStore();
  useEffect(() => {
    if (view === "notes" && activeNoteId && activeNoteId > 0) {
      navigate({ search: { note: activeNoteId, conv: undefined, list: undefined , audit: undefined}, replace: true });
    }
  }, [activeNoteId, view]);

  // When active conversation changes while in chat view, update URL
  const { activeId: activeConvId } = useConversationsStore();
  useEffect(() => {
    if (view === "chat" && activeConvId) {
      navigate({ search: { note: undefined, conv: activeConvId, list: undefined , audit: undefined}, replace: true });
    }
  }, [activeConvId, view]);

  return (
    <PasswordGate>
    <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: "var(--gooni-bg, #FFFFFF)", position: "relative" }}>
      {sidebarOpen && (
        <Sidebar
          isDashboard={view === "dashboard"}
          isNotes={view === "notes"}
          isChat={view === "chat"}
          isLists={view === "lists"}
          isEval={view === "eval"}
          isStats={view === "stats"}
          activeListId={view === "lists" ? activeListId : null}
          showCompose={view !== "notes"}
          onLogoClick={() => setViewAndUrl("dashboard")}
          onSpaceSelect={() => setView("notes")}
          onCompose={handleCompose}
          onNewChat={handleNewChat}
          onSelectList={handleSelectList}
          onOpenEval={() => setViewAndUrl("eval")}
          onOpenStats={() => setView("stats")}
        />
      )}

      <div style={{ flex: 1, display: "flex", minWidth: 0, position: "relative", overflow: "hidden" }}>
        {view === "dashboard" ? (
          <Dashboard
            onOpenNote={() => setView("notes")}
            onOpenStats={() => setView("stats")}
          />
        ) : view === "chat" ? (
          <ChatView />
        ) : view === "plan" && planNoteId != null ? (
          <PlanView
            noteId={planNoteId}
            onExit={() => { setPlanNoteId(null); setView("dashboard"); }}
          />
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
          <EvalView onOpenNote={(noteId) => setViewAndUrl("notes", noteId)} />
        ) : view === "stats" ? (
          <StatsView />
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
      </div>

      {/* Floating Publish CTA — only on the notes view with a saved note,
          so it never floats over chat / dashboard / lists. Sits to the left
          of the Gooni orb (mounted by GooniLayer below) so the pair reads
          as "primary action + assistant", with Publish as the primary. */}
      {view === "notes" && activeNoteId && activeNoteId > 0 && (
        <FloatingPublishButton noteId={activeNoteId} />
      )}

      {/* FAB + floating panel + mascot all live in GooniLayer so /memories and
          any other authed route get the same chat affordance for free. */}
      <GooniLayer />
    </div>
    </PasswordGate>
  );
}
