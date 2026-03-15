import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Dashboard } from "../components/Dashboard";
import { GoalView } from "../components/GoalView";
import { JarvisPanel } from "../components/JarvisPanel";
import { NoteEditor } from "../components/notes/NoteEditor";
import { NotesList } from "../components/notes/NotesList";
import { Sidebar } from "../components/notes/Sidebar";
import { useWindowWidth } from "../hooks/useWindowWidth";
import { useJarvisStore } from "../stores/useJarvisStore";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { useSpacesStore } from "../stores/useSpacesStore";
import { useGoalsStore } from "../stores/useGoalsStore";

export const Route = createFileRoute("/")({
  component: NotesPage,
});

// Sidebar auto-collapses below this width
const SIDEBAR_BREAKPOINT = 768;

function NotesPage() {
  const fetchSpaces = useSpacesStore((s) => s.fetch);
  const fetchGoals = useGoalsStore((s) => s.fetch);
  const { selectedSpaceId, selectSpace, loadNotes, selectNote, createNote } = useNotesContentStore();
  const isJarvisOpen = useJarvisStore((s) => s.isOpen);
  const windowWidth = useWindowWidth();

  const [view, setView] = useState<"notes" | "dashboard" | "goal">("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(windowWidth >= SIDEBAR_BREAKPOINT);

  useEffect(() => {
    setSidebarOpen(windowWidth >= SIDEBAR_BREAKPOINT);
  }, [windowWidth >= SIDEBAR_BREAKPOINT]);

  useEffect(() => {
    fetchSpaces();
    fetchGoals();
  }, []);

  useEffect(() => {
    // Only select a space when we're in notes view, not dashboard or goal
    if (view === "notes") {
      const spaceId = selectedSpaceId ?? "general";
      if (!selectedSpaceId) selectSpace("general");
      loadNotes(spaceId);
    }
  }, [view]);

  // Clear selected space when switching to dashboard or goal
  useEffect(() => {
    if ((view === "dashboard" || view === "goal") && selectedSpaceId) {
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

  async function handleOpenNote(noteId: number, spaceId: string) {
    selectSpace(spaceId);
    await loadNotes(spaceId);
    selectNote(noteId);
    setView("notes");
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
          onLogoClick={() => setView("dashboard")}
          onSpaceSelect={() => setView("notes")}
          onGoalSelect={() => setView("goal")}
          onCompose={handleCompose}
        />
      )}

      {view === "dashboard" ? (
        <Dashboard onGoToNote={handleGoToNote} />
      ) : view === "goal" ? (
        <>
          <GoalView onOpenNote={handleOpenNote} />
          {isJarvisOpen && (
            isSmall ? (
              <div style={{ position: "absolute", right: 0, top: 0, height: "100%", zIndex: 50, boxShadow: "-4px 0 20px rgba(0,0,0,0.12)" }}>
                <JarvisPanel />
              </div>
            ) : (
              <JarvisPanel />
            )
          )}
        </>
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
