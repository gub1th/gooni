import { useEffect, useRef, useState } from "react";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import type { ApiNote } from "../../services/api";

// Module-level drag state so Sidebar can read it without prop drilling
export let draggingNotePayload: { noteId: number; fromSpaceId: string } | null = null;

function formatDate(iso: string | null): string {
  if (!iso) return "";
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

interface ContextMenu {
  x: number;
  y: number;
  noteId: number;
  confirming: boolean;
}

interface NoteRowProps {
  note: ApiNote;
  active: boolean;
  spaceId: string;
  dragging: boolean;
  onSelect: () => void;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
  onContextMenu: (e: React.MouseEvent, noteId: number) => void;
}

function NoteRow({ note, active, spaceId, dragging, onSelect, onDragStart, onDragEnd, onContextMenu }: NoteRowProps) {
  const preview = note.content ? stripHtml(note.content).slice(0, 60) : "";
  const title = note.title?.trim() || "New Note";

  return (
    <div
      draggable={note.id > 0}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", JSON.stringify({ noteId: note.id, fromSpaceId: spaceId }));
        e.dataTransfer.effectAllowed = "move";
        draggingNotePayload = { noteId: note.id, fromSpaceId: spaceId };
        onDragStart(note.id);
      }}
      onDragEnd={() => {
        draggingNotePayload = null;
        onDragEnd();
      }}
      onClick={onSelect}
      onContextMenu={(e) => onContextMenu(e, note.id)}
      style={{
        padding: "10px 14px",
        borderBottom: "1px solid rgba(0,0,0,0.06)",
        cursor: note.id > 0 ? "grab" : "pointer",
        background: active ? "rgba(0,0,0,0.07)" : "transparent",
        transition: "background 0.1s, opacity 0.15s",
        userSelect: "none",
        opacity: dragging ? 0.4 : 1,
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
        <span style={{ fontSize: 12, color: "#8E8E93", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif", flexShrink: 0 }}>
          {formatDate(note.updated_at)}
        </span>
        {preview && (
          <span style={{ fontSize: 12, color: "#AEAEB2", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
  const { selectedSpaceId, notes, activeNoteId, createNote, selectNote, deleteNote } = useNotesContentStore();
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const spaceId = selectedSpaceId ?? "general";
  const noteList = notes[spaceId] ?? [];

  // Dismiss context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [contextMenu]);

  function handleContextMenu(e: React.MouseEvent, noteId: number) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, noteId, confirming: false });
  }

  async function handleDelete() {
    if (!contextMenu) return;
    if (!contextMenu.confirming) {
      setContextMenu({ ...contextMenu, confirming: true });
      return;
    }
    const id = contextMenu.noteId;
    setContextMenu(null);
    await deleteNote(id, spaceId);
  }

  return (
    <div
      style={{ width: 260, minWidth: 260, height: "100vh", background: "#FAFAFA", display: "flex", flexDirection: "column", borderRight: "1px solid rgba(0,0,0,0.08)", boxSizing: "border-box" }}
    >
      {/* Header */}
      <div style={{ height: 52, padding: "0 14px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, borderBottom: "1px solid rgba(0,0,0,0.06)", gap: 8 }}>
        <button
          onClick={onToggleSidebar}
          title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          style={{ width: 26, height: 26, borderRadius: 6, background: "transparent", border: "none", cursor: "pointer", fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center", color: "#636366", padding: 0, flexShrink: 0, transition: "background 0.1s" }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
        >
          {sidebarOpen ? "⟨" : "⟩"}
        </button>
        <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: "#1C1C1E", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif" }}>
          Notes
        </span>
        <button
          onClick={() => createNote(spaceId)}
          title="New note"
          style={{ width: 26, height: 26, borderRadius: "50%", background: "rgba(0,0,0,0.06)", border: "none", cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", color: "#1C1C1E", padding: 0, flexShrink: 0, transition: "background 0.1s" }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.12)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
        >
          +
        </button>
      </div>

      {/* Note list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {noteList.length === 0 && (
          <div style={{ padding: "32px 14px", textAlign: "center", color: "#AEAEB2", fontSize: 13, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>
            No notes yet. Press + to create one.
          </div>
        )}
        {noteList.map((note) => (
          <NoteRow
            key={note.id}
            note={note}
            active={activeNoteId === note.id}
            spaceId={spaceId}
            dragging={draggingId === note.id}
            onSelect={() => selectNote(note.id)}
            onDragStart={(id) => setDraggingId(id)}
            onDragEnd={() => setDraggingId(null)}
            onContextMenu={handleContextMenu}
          />
        ))}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 1000,
            background: "#FFFFFF",
            borderRadius: 10,
            boxShadow: "0 4px 24px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.06)",
            padding: 6,
            minWidth: 160,
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
          }}
        >
          {!contextMenu.confirming ? (
            <button
              onClick={handleDelete}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 10px", border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, fontSize: 13.5, color: "#FF3B30", textAlign: "left" }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(255,59,48,0.08)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
            >
              🗑 Delete Note
            </button>
          ) : (
            <div style={{ padding: "6px 10px" }}>
              <div style={{ fontSize: 13, color: "#1C1C1E", marginBottom: 8, fontWeight: 500 }}>Delete this note?</div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={handleDelete}
                  style={{ flex: 1, padding: "5px 0", borderRadius: 6, border: "none", background: "#FF3B30", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                >
                  Delete
                </button>
                <button
                  onClick={() => setContextMenu(null)}
                  style={{ flex: 1, padding: "5px 0", borderRadius: 6, border: "none", background: "rgba(0,0,0,0.07)", color: "#1C1C1E", fontSize: 13, cursor: "pointer" }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
