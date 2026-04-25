import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ChatView } from "../components/ChatView";
import { ChatLauncher } from "../components/ChatLauncher";
import { Dashboard } from "../components/Dashboard";
import { GooniMascot } from "../components/GooniMascot";
import { GooniPanel } from "../components/GooniPanel";
import { NoteEditor } from "../components/notes/NoteEditor";
import { NotesList } from "../components/notes/NotesList";
import { Sidebar } from "../components/notes/Sidebar";
import { PasswordGate } from "../components/PasswordGate";
import { useWindowWidth } from "../hooks/useWindowWidth";
import { useGooniActivatedStore } from "../stores/useGooniActivatedStore";
import { useGooniStore } from "../stores/useGooniStore";
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
  const isGooniOpen = useGooniStore((s) => s.isOpen);
  const gooniActivated = useGooniActivatedStore((s) => s.activated);
  const windowWidth = useWindowWidth();
  const { fetchConversations, newChat, selectConversation } = useConversationsStore();
  const navigate = useNavigate({ from: "/" });
  const search = Route.useSearch();
  // Bounds the mascot walks within. Refs the right-side content area so the
  // mascot doesn't wander over the sidebar — applies to every view (notes,
  // dashboard, chat). Mascot was previously dashboard-only.
  const pageRef = useRef<HTMLDivElement>(null);

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

    if (search.note) {
      fetchNote(search.note).then((note) => {
        const spaceId = note.space_id == null ? "general" : String(note.space_id);
        selectSpace(spaceId);
        selectNote(note.id); // set eagerly so editor doesn't show a different note while notes load
        loadNotes(spaceId);
      }).catch(() => {
        setView("dashboard");
      });
    } else if (search.conv) {
      selectConversation(search.conv);
    }
  }, []);

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

  const isSmall = windowWidth < 1100;

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

      {/* Right-side content area, ref'd so the mascot can walk within it on
          every view — not just the dashboard. Excludes the sidebar so the
          mascot stays out of the nav rail. */}
      <div ref={pageRef} style={{ flex: 1, display: "flex", minWidth: 0, position: "relative", overflow: "hidden" }}>
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

      {/* Mascot mounts globally now (was dashboard-only). Bounds tracked via
          pageRef so it walks across notes / dashboard / chat without overlap
          into the sidebar. The dashboard's own mount has been removed. */}
      {gooniActivated && <GooniMascot dashboardRef={pageRef} />}

      {/* Floating Gooni panel — anchored above the FAB, visible on every view.
          Was previously embedded only in the notes view (and collided with the
          FAB). Now position-fixed bottom-right so it never fights the FAB. */}
      {isGooniOpen && (
        <div
          style={{
            position: "fixed",
            bottom: 110,            // FAB margin (24) + FAB size (72) + gap (14)
            right: 24,
            width: isSmall ? "calc(100vw - 48px)" : 380,
            maxWidth: 420,
            height: isSmall ? "calc(100vh - 130px)" : 560,
            maxHeight: "calc(100vh - 130px)",
            background: "#FFFFFF",
            borderRadius: 18,
            boxShadow:
              "0 24px 60px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04)",
            overflow: "hidden",
            zIndex: 999,
            display: "flex",
          }}
        >
          <GooniPanel floating />
        </div>
      )}

      {/* Floating chat launcher — bottom-right FAB. Click toggles GooniPanel.
          Replaces the old in-panel header + close button. Mascot's drop zone
          and docked idle position anchor to this launcher. */}
      <ChatLauncher />
    </div>
    </PasswordGate>
  );
}
