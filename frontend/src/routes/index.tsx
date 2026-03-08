import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { JarvisPanel } from "../components/JarvisPanel";
import { Sidebar } from "../components/notes/Sidebar";
import { NotesList } from "../components/notes/NotesList";
import { NoteEditor } from "../components/notes/NoteEditor";
import { useWindowWidth } from "../hooks/useWindowWidth";
import { useSpacesStore } from "../stores/useSpacesStore";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { useJarvisStore } from "../stores/useJarvisStore";

export const Route = createFileRoute("/")({
  component: NotesPage,
});

// Sidebar auto-collapses below this width
const SIDEBAR_BREAKPOINT = 768;

function NotesPage() {
  const fetchSpaces = useSpacesStore((s) => s.fetch);
  const { selectedSpaceId, selectSpace, loadNotes } = useNotesContentStore();
  const isJarvisOpen = useJarvisStore((s) => s.isOpen);
  const windowWidth = useWindowWidth();

  // Start open on wide screens, closed on narrow
  const [sidebarOpen, setSidebarOpen] = useState(windowWidth >= SIDEBAR_BREAKPOINT);

  // Auto-collapse sidebar when window narrows past breakpoint
  useEffect(() => {
    setSidebarOpen(windowWidth >= SIDEBAR_BREAKPOINT);
  }, [windowWidth >= SIDEBAR_BREAKPOINT]);

  useEffect(() => {
    fetchSpaces();
  }, []);

  // On mount: load notes for whatever space is already selected (or default to general)
  useEffect(() => {
    const spaceId = selectedSpaceId ?? "general";
    if (!selectedSpaceId) selectSpace("general");
    loadNotes(spaceId);
  }, []);

  // Jarvis overlays on small screens
  const isSmall = windowWidth < 1100;

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
      {/* Sidebar — conditionally rendered based on sidebarOpen */}
      {sidebarOpen && <Sidebar />}

      <NotesList
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
      />

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
    </div>
  );
}
