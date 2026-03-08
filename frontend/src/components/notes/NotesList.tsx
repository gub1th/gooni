import { useNotesContentStore } from "../../stores/useNotesContentStore";
import type { ApiNote } from "../../services/api";

function formatDate(iso: string): string {
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isToday) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}

interface NoteRowProps {
  note: ApiNote;
  active: boolean;
  onSelect: () => void;
}

function NoteRow({ note, active, onSelect }: NoteRowProps) {
  const preview = note.content ? stripHtml(note.content).slice(0, 60) : "";
  const title = note.title?.trim() || "New Note";

  return (
    <div
      onClick={onSelect}
      style={{
        padding: "10px 14px",
        borderBottom: "1px solid rgba(0,0,0,0.06)",
        cursor: "pointer",
        background: active ? "rgba(0,0,0,0.07)" : "transparent",
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.04)";
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLDivElement).style.background = "transparent";
      }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: "#1C1C1E",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
          marginBottom: 2,
        }}
      >
        {title}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
        <span
          style={{
            fontSize: 12,
            color: "#8E8E93",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            flexShrink: 0,
          }}
        >
          {formatDate(note.updated_at)}
        </span>
        {preview && (
          <span
            style={{
              fontSize: 12,
              color: "#AEAEB2",
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {preview}
          </span>
        )}
      </div>
    </div>
  );
}

interface NotesListProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function NotesList({ sidebarOpen, onToggleSidebar }: NotesListProps) {
  const { selectedSpaceId, notes, activeNoteId, createNote, selectNote } = useNotesContentStore();

  const spaceId = selectedSpaceId ?? "general";
  const noteList = notes[spaceId] ?? [];

  async function handleCreate() {
    await createNote(spaceId);
  }

  return (
    <div
      style={{
        width: 260,
        minWidth: 260,
        height: "100vh",
        background: "#FAFAFA",
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid rgba(0,0,0,0.08)",
        boxSizing: "border-box",
      }}
    >
      {/* Header — same height as Sidebar header */}
      <div
        style={{
          height: 52,
          padding: "0 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
          borderBottom: "1px solid rgba(0,0,0,0.06)",
          gap: 8,
        }}
      >
        {/* Sidebar toggle */}
        <button
          onClick={onToggleSidebar}
          title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: 15,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#636366",
            padding: 0,
            flexShrink: 0,
            transition: "background 0.1s",
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
        >
          {sidebarOpen ? "⟨" : "⟩"}
        </button>

        <span
          style={{
            flex: 1,
            fontSize: 15,
            fontWeight: 600,
            color: "#1C1C1E",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
          }}
        >
          Notes
        </span>

        <button
          onClick={handleCreate}
          title="New note"
          style={{
            width: 26,
            height: 26,
            borderRadius: "50%",
            background: "rgba(0,0,0,0.06)",
            border: "none",
            cursor: "pointer",
            fontSize: 18,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#1C1C1E",
            padding: 0,
            flexShrink: 0,
            transition: "background 0.1s ease",
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.12)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
        >
          +
        </button>
      </div>

      {/* Note list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {noteList.length === 0 && (
          <div
            style={{
              padding: "32px 14px",
              textAlign: "center",
              color: "#AEAEB2",
              fontSize: 13,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            }}
          >
            No notes yet. Press + to create one.
          </div>
        )}
        {noteList.map((note) => (
          <NoteRow
            key={note.id}
            note={note}
            active={activeNoteId === note.id}
            onSelect={() => selectNote(note.id)}
          />
        ))}
      </div>
    </div>
  );
}
