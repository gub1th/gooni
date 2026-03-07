import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { Editor } from "../components/notes/Editor";
import { Sidebar } from "../components/notes/Sidebar";
import { useWindowWidth } from "../hooks/useWindowWidth";
import { useNotesStore } from "../stores/notesStore";
import { useSpacesStore } from "../stores/useSpacesStore";

export const Route = createFileRoute("/")({
  component: NotesPage,
});

function NotesPage() {
  const fetchSpaces = useSpacesStore((s) => s.fetch);
  const selectedSpaceId = useNotesStore((s) => s.selectedSpaceId);
  const selectSpace = useNotesStore((s) => s.selectSpace);
  const loadFeed = useNotesStore((s) => s.loadFeed);
  const windowWidth = useWindowWidth();

  // Breakpoints:
  // >= 1320: full layout (220px side margins, 600px center, right panel)
  // 875–1319: no margins, 600px center, no right panel
  // < 875: no margins, center is flex:1 (shrinks with sidebar)
  const isLarge = windowWidth >= 1320;
  const isSmall = windowWidth < 875;

  useEffect(() => {
    fetchSpaces();
  }, []);

  // Auto-select General if nothing selected
  useEffect(() => {
    if (selectedSpaceId === null) {
      selectSpace("general");
      loadFeed("general");
    }
  }, [selectedSpaceId, selectSpace, loadFeed]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        height: "100vh",
        overflow: "hidden",
        background: "#FFFFFF",
        marginLeft: isLarge ? 220 : 0,
        marginRight: isLarge ? 220 : 0,
      }}
    >
      <Sidebar />
      <div
        style={{
          width: isSmall ? undefined : 600,
          minWidth: isSmall ? 0 : 600,
          flex: isSmall ? 1 : undefined,
          flexShrink: isSmall ? 1 : 0,
          height: "100vh",
          display: "flex",
        }}
      >
        <Editor />
      </div>
      {isLarge && (
        <div
          style={{
            flex: 1,
            height: "100vh",
            borderLeft: "1px solid rgba(0,0,0,0.08)",
            background: "#FFFFFF",
          }}
        />
      )}
    </div>
  );
}
