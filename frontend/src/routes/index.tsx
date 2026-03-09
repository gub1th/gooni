import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Dashboard } from "../components/Dashboard";
import { JarvisPanel } from "../components/JarvisPanel";
import { NoteEditor } from "../components/notes/NoteEditor";
import { NotesList } from "../components/notes/NotesList";
import { Sidebar } from "../components/notes/Sidebar";
import { useWindowWidth } from "../hooks/useWindowWidth";
import { useJarvisStore } from "../stores/useJarvisStore";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { useSpacesStore } from "../stores/useSpacesStore";
import { LoginScreen } from "../components/LoginScreen";

// Simple password protection
const APP_PASSWORD = import.meta.env.VITE_APP_PASSWORD || "gooni2026";

export const Route = createFileRoute("/")({
  component: NotesPage,
});

// Sidebar auto-collapses below this width
const SIDEBAR_BREAKPOINT = 768;

function NotesPage() {
  const fetchSpaces = useSpacesStore((s) => s.fetch);
  const { selectedSpaceId, selectSpace, loadNotes, selectNote } = useNotesContentStore();
  const isJarvisOpen = useJarvisStore((s) => s.isOpen);
  const windowWidth = useWindowWidth();

  const [view, setView] = useState<"notes" | "dashboard">("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(windowWidth >= SIDEBAR_BREAKPOINT);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    setSidebarOpen(windowWidth >= SIDEBAR_BREAKPOINT);
  }, [windowWidth >= SIDEBAR_BREAKPOINT]);

  useEffect(() => {
    fetchSpaces();
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

  async function handleGoToNote(noteId: number, spaceId: string) {
    selectSpace(spaceId);
    await loadNotes(spaceId);
    selectNote(noteId);
    setView("notes");
  }

  // Handle login
  function handleLogin(password: string): boolean {
    if (password === APP_PASSWORD) {
      setIsLoggedIn(true);
      return true;
    }
    return false;
  }

  // Show login screen if not authenticated
  if (!isLoggedIn) {
    return <LoginScreen onLogin={handleLogin} />;
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
          onLogoClick={() => setView((v) => (v === "dashboard" ? "notes" : "dashboard"))}
          onSpaceSelect={() => setView("notes")}
        />
      )}

      {view === "dashboard" ? (
        <Dashboard onGoToNote={handleGoToNote} />
      ) : (
        <>
          <NotesList />

          <NoteEditor />

          {isJarvisOpen && (
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
                <JarvisPanel />
              </div>
            ) : (
              <JarvisPanel />
            )
          )}
        </>
      )}
    </div>
  );
}
