import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { Editor } from "../components/notes/Editor";
import { Sidebar } from "../components/notes/Sidebar";
import { useGoalsStore } from "../stores/useGoalsStore";
import { useNotesStore } from "../stores/notesStore";
import { useWindowWidth } from "../hooks/useWindowWidth";

export const Route = createFileRoute("/")({
  component: NotesPage,
});

function NotesPage() {
  const fetchGoals = useGoalsStore((s) => s.fetch);
  const goals = useGoalsStore((s) => s.goals);
  const selectedSpaceId = useNotesStore((s) => s.selectedSpaceId);
  const selectSpace = useNotesStore((s) => s.selectSpace);
  const loadFeed = useNotesStore((s) => s.loadFeed);
  const windowWidth = useWindowWidth();

  // Breakpoints:
  // >= 1320: full layout (220px side margins, 600px center, right panel)
  // 875–1319: no margins, 600px center, no right panel
  // < 875: no margins, center is flex:1 (shrinks with sidebar)
  const isLarge = windowWidth >= 1320;
  const isMedium = windowWidth >= 875 && windowWidth < 1320;
  const isSmall = windowWidth < 875;

  useEffect(() => {
    fetchGoals();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select first goal if nothing selected OR selected space no longer valid
  useEffect(() => {
    if (goals.length === 0) return;
    const isValid = goals.some((g) => selectedSpaceId === `goal-${g.id}`);
    if (!isValid) {
      const first = goals[0];
      const spaceId = `goal-${first.id}`;
      selectSpace(spaceId);
      loadFeed(spaceId, first.id);
    }
  }, [goals]); // eslint-disable-line react-hooks/exhaustive-deps

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
