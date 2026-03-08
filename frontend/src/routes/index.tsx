import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { JarvisPanel } from "../components/JarvisPanel";
import { NoteEditor } from "../components/notes/NoteEditor";
import { Sidebar } from "../components/notes/Sidebar";
import { useWindowWidth } from "../hooks/useWindowWidth";
import { useNotesStore } from "../stores/notesStore";
import { useJarvisStore } from "../stores/useJarvisStore";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { useSpacesStore } from "../stores/useSpacesStore";

export const Route = createFileRoute("/")({ component: NotesPage });

function NotesPage() {
  const fetchSpaces = useSpacesStore((s) => s.fetch);
  const selectedSpaceId = useNotesStore((s) => s.selectedSpaceId);
  const selectSpace = useNotesStore((s) => s.selectSpace);
  const loadFeed = useNotesStore((s) => s.loadFeed);
  const loadNotes = useNotesContentStore((s) => s.loadNotes);
  const selectNote = useNotesContentStore((s) => s.selectNote);
  const jarvisOpen = useJarvisStore((s) => s.isOpen);
  const width = useWindowWidth();

  useEffect(() => {
    fetchSpaces();
  }, [fetchSpaces]);

  useEffect(() => {
    if (selectedSpaceId === null) selectSpace("general");
  }, [selectedSpaceId, selectSpace]);

  useEffect(() => {
    const spaceId = selectedSpaceId || "general";
    loadFeed(spaceId);
    loadNotes(spaceId);
    selectNote(null);
  }, [selectedSpaceId, loadFeed, loadNotes, selectNote]);

  const mobileJarvis = width < 1320;

  return (
    <div style={{ display: "flex", height: "100vh", background: "#fff" }}>
      <Sidebar />
      <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
        <NoteEditor />
        {jarvisOpen && (
          <div
            style={
              mobileJarvis
                ? { position: "absolute", right: 0, top: 0, height: "100%", zIndex: 50, boxShadow: "-8px 0 20px rgba(0,0,0,0.16)" }
                : { position: "absolute", right: 0, top: 0, height: "100%" }
            }
          >
            <JarvisPanel />
          </div>
        )}
      </div>
    </div>
  );
}
