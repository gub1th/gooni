import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { JarvisPanel } from "../components/JarvisPanel";
import { NoteEditor } from "../components/notes/NoteEditor";
import { Sidebar } from "../components/notes/Sidebar";
import { useNotesStore } from "../stores/notesStore";
import { useJarvisStore } from "../stores/useJarvisStore";
import { useSpacesStore } from "../stores/useSpacesStore";

export const Route = createFileRoute("/")({
  component: NotesPage,
});

function NotesPage() {
  const fetchSpaces = useSpacesStore((s) => s.fetch);
  const selectedSpaceId = useNotesStore((s) => s.selectedSpaceId);
  const selectSpace = useNotesStore((s) => s.selectSpace);
  const loadFeed = useNotesStore((s) => s.loadFeed);
  const { isOpen: jarvisOpen } = useJarvisStore();

  useEffect(() => {
    fetchSpaces();
  }, []);

  useEffect(() => {
    // Auto-select General if nothing selected
    if (selectedSpaceId === null) {
      selectSpace("general");
      loadFeed("general");
    }
  }, [selectedSpaceId, selectSpace, loadFeed]);

  useEffect(() => {
    // Load notes for the selected space
    if (selectedSpaceId) {
      // notes.loadNotes(selectedSpaceId);
    }
  }, [selectedSpaceId]);

  return (
    <div style={{ display: "flex", height: "100vh", backgroundColor: "#FFFFFF" }}>
      {/* Sidebar */}
      <div style={{ width: 275, flexShrink: 0 }}>
        <Sidebar />
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
        <NoteEditor />

        {/* Jarvis Panel - overlay on large screens, sidebar on small */}
        {jarvisOpen && (
          <div style={{
            position: "absolute",
            right: 0,
            top: 0,
            width: 300,
            height: "100vh",
            background: "#FFFFFF",
            borderLeft: "1px solid rgba(0,0,0,0.08)",
            boxShadow: "-4px 0px 12px rgba(0,0,0,0.1)",
          }}>
            <JarvisPanel />
          </div>
        )}
      </div>
    </div>
  );
}
