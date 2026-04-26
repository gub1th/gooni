import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChatView } from "../components/ChatView";
import { Dashboard } from "../components/Dashboard";
import { GooniLayer } from "../components/GooniLayer";
import { NoteEditor } from "../components/notes/NoteEditor";
import { NotesList } from "../components/notes/NotesList";
import { Sidebar } from "../components/notes/Sidebar";
import { PasswordGate } from "../components/PasswordGate";
import { useWindowWidth } from "../hooks/useWindowWidth";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { useSpacesStore } from "../stores/useSpacesStore";
import { useConversationsStore } from "../stores/useConversationsStore";
import { fetchNote } from "../services/api";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    note: typeof search.note === "number" ? search.note : typeof search.note === "string" ? Number(search.note) : undefined,
    conv: typeof search.conv === "number" ? search.conv : typeof search.conv === "string" ? Number(search.conv) : undefined,
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
  const navigate = useNavigate({ from: "/" });
  const search = Route.useSearch();

  // Initialize view from URL so deep-linking a note doesn't flash the dashboard first.
  const [view, setView] = useState<"notes" | "dashboard" | "chat">(() =>
    search.note ? "notes" : search.conv ? "chat" : "dashboard"
  );
  const [sidebarOpen, setSidebarOpen] = useState(windowWidth >= SIDEBAR_BREAKPOINT);

  useEffect(() => {
    setSidebarOpen(windowWidth >= SIDEBAR_BREAKPOINT);
  }, [windowWidth >= SIDEBAR_BREAKPOINT]);

  // Initial load: restore from URL params
  useEffect(() => {
    fetchSpaces();
    fetchConversations();
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
      const spaceId = note.space_id == null ? "general" : String(note.space_id);
      selectSpace(spaceId);
      selectNote(note.id);
      loadNotes(spaceId);
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

  function setViewAndUrl(v: "notes" | "dashboard" | "chat", noteId?: number, convId?: number) {
    setView(v);
    if (v === "notes" && noteId) {
      navigate({ search: { note: noteId, conv: undefined }, replace: true });
    } else if (v === "chat" && convId) {
      navigate({ search: { note: undefined, conv: convId }, replace: true });
    } else {
      navigate({ search: { note: undefined, conv: undefined }, replace: true });
    }
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
    navigate({ search: { note: undefined, conv: undefined }, replace: true });
  }

  // When active note changes while in notes view, update URL
  const { activeNoteId } = useNotesContentStore();
  useEffect(() => {
    if (view === "notes" && activeNoteId && activeNoteId > 0) {
      navigate({ search: { note: activeNoteId, conv: undefined }, replace: true });
    }
  }, [activeNoteId, view]);

  // When active conversation changes while in chat view, update URL
  const { activeId: activeConvId } = useConversationsStore();
  useEffect(() => {
    if (view === "chat" && activeConvId) {
      navigate({ search: { note: undefined, conv: activeConvId }, replace: true });
    }
  }, [activeConvId, view]);

  return (
    <PasswordGate>
    <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: "#FFFFFF", position: "relative" }}>
      {sidebarOpen && (
        <Sidebar
          isDashboard={view === "dashboard"}
          isNotes={view === "notes"}
          isChat={view === "chat"}
          showCompose={view !== "notes"}
          onLogoClick={() => setViewAndUrl("dashboard")}
          onSpaceSelect={() => setView("notes")}
          onCompose={handleCompose}
          onNewChat={handleNewChat}
        />
      )}

      <div style={{ flex: 1, display: "flex", minWidth: 0, position: "relative", overflow: "hidden" }}>
        {view === "dashboard" ? (
          <Dashboard onOpenNote={() => setView("notes")} />
        ) : view === "chat" ? (
          <ChatView />
        ) : (
          <>
            <NotesList />
            <NoteEditor />
          </>
        )}
      </div>

      {/* FAB + floating panel + mascot all live in GooniLayer so /memories and
          any other authed route get the same chat affordance for free. */}
      <GooniLayer />
    </div>
    </PasswordGate>
  );
}
