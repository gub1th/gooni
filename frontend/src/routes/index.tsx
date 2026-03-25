import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Dashboard } from "../components/Dashboard";
import { GooniPanel } from "../components/GooniPanel";
import { NoteEditor } from "../components/notes/NoteEditor";
import { NotesList } from "../components/notes/NotesList";
import { Sidebar } from "../components/notes/Sidebar";
import { useWindowWidth } from "../hooks/useWindowWidth";
import { useGooniStore } from "../stores/useGooniStore";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { useSpacesStore } from "../stores/useSpacesStore";
import { useConversationsStore } from "../stores/useConversationsStore";

export const Route = createFileRoute("/")({
  component: NotesPage,
});

// Sidebar auto-collapses below this width
const SIDEBAR_BREAKPOINT = 768;

function NotesPage() {
  const fetchSpaces = useSpacesStore((s) => s.fetch);
  const { selectedSpaceId, selectSpace, loadNotes, createNote } = useNotesContentStore();
  const isGooniOpen = useGooniStore((s) => s.isOpen);
  const windowWidth = useWindowWidth();
  const { fetchConversations, newChat } = useConversationsStore();

  const [view, setView] = useState<"notes" | "dashboard">("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(windowWidth >= SIDEBAR_BREAKPOINT);

  useEffect(() => {
    setSidebarOpen(windowWidth >= SIDEBAR_BREAKPOINT);
  }, [windowWidth >= SIDEBAR_BREAKPOINT]);

  useEffect(() => {
    fetchSpaces();
    fetchConversations();
  }, []);

  useEffect(() => {
    // Only select a space when we're in notes view, not dashboard
    if (view === "notes") {
      const spaceId = selectedSpaceId ?? "general";
      if (!selectedSpaceId) selectSpace("general");
      loadNotes(spaceId);
    }
  }, [view]);

  // Clear selected space when switching to dashboard
  useEffect(() => {
    if (view === "dashboard" && selectedSpaceId) {
      selectSpace(null);
    }
  }, [view, selectedSpaceId]);
  const isSmall = windowWidth < 1100;

  function handleNewChat() {
    newChat();
    setView("dashboard");
  }

  function handleCompose() {
    const spaceId = selectedSpaceId ?? "general";
    setView("notes");
    selectSpace(spaceId);
    // loadNotes is called by the view-change effect — don't double-call it.
    // createNote adds an optimistic entry immediately; the store handles any race with loadNotes.
    createNote(spaceId);
  }

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        background: "#FFFFFF",
        position: "relative",
      }}
    >
      {sidebarOpen && (
        <Sidebar
          isDashboard={view === "dashboard"}
          showCompose={view !== "notes"}
          onLogoClick={handleNewChat}
          onSpaceSelect={() => setView("notes")}
          onCompose={handleCompose}
          onNewChat={handleNewChat}
          onConversationSelect={() => setView("dashboard")}
        />
      )}

      {view === "dashboard" ? (
        <Dashboard />
      ) : (
        <>
          <NotesList />

          <NoteEditor />

          {isGooniOpen && (
            isSmall ? (
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: 0,
                  height: "100%",
                  zIndex: 50,
                  boxShadow: "-4px 0 20px rgba(0,0,0,0.12)",
                }}
              >
                <GooniPanel />
              </div>
            ) : (
              <GooniPanel />
            )
          )}
        </>
      )}
    </div>
  );
}
