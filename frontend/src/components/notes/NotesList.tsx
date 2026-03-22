import { useEffect, useRef, useState } from "react";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useSpacesStore } from "../../stores/useSpacesStore";
import type { ApiNote } from "../../services/api";

// Module-level drag state so Sidebar can read it without prop drilling
export let draggingNotePayload: { noteId: number; fromSpaceId: string } | null = null;

function parseDate(iso: string | null): Date | null {
  if (!iso) return null;
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  return new Date(hasOffset ? iso : iso + "Z");
}

function formatTime(iso: string | null): string {
  const d = parseDate(iso);
  if (!d) return "";
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isToday) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short" });
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}

function groupNotes(notes: ApiNote[]): { label: string; notes: ApiNote[] }[] {
  const now = new Date();
  const todayStr = now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayStr = yesterday.toDateString();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 7);

  const buckets: Record<string, ApiNote[]> = {
    Today: [],
    Yesterday: [],
    "Previous 7 Days": [],
    Older: [],
  };

  for (const note of notes) {
    const d = parseDate(note.updated_at);
    if (!d) { buckets.Older.push(note); continue; }
    const ds = d.toDateString();
    if (ds === todayStr) buckets.Today.push(note);
    else if (ds === yesterdayStr) buckets.Yesterday.push(note);
    else if (d >= sevenDaysAgo) buckets["Previous 7 Days"].push(note);
    else buckets.Older.push(note);
  }

  return Object.entries(buckets)
    .filter(([, arr]) => arr.length > 0)
    .map(([label, notes]) => ({ label, notes }));
}

function FolderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M1 3.5C1 2.948 1.448 2.5 2 2.5H4.5L5.5 3.5H10C10.552 3.5 11 3.948 11 4.5V9C11 9.552 10.552 10 10 10H2C1.448 10 1 9.552 1 9V3.5Z" stroke="#636366" strokeWidth="1.2" fill="none"/>
    </svg>
  );
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
  spaceBadge?: string | null; // "emoji name" or just "name" — shown when in all-notes view
  onSelect: () => void;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
  onContextMenu: (e: React.MouseEvent, noteId: number) => void;
}

function NoteRow({ note, active, spaceId, dragging, spaceBadge, onSelect, onDragStart, onDragEnd, onContextMenu }: NoteRowProps) {
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
          {formatTime(note.updated_at)}
        </span>
        {preview && (
          <span style={{ fontSize: 12, color: "#AEAEB2", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {preview}
          </span>
        )}
      </div>
      {spaceBadge && (
        <div style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 5, background: "rgba(0,0,0,0.07)", borderRadius: 5, padding: "2px 7px 2px 5px" }}>
          <FolderIcon />
          <span style={{ fontSize: 11.5, color: "#3C3C43", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif", fontWeight: 500 }}>
            {spaceBadge}
          </span>
        </div>
      )}
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{
      padding: "14px 14px 6px",
      fontSize: 20,
      fontWeight: 700,
      color: "#1C1C1E",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
    }}>
      {label}
    </div>
  );
}

export function NotesList() {
  const { selectedSpaceId, notes, activeNoteId, createNote, selectNote, deleteNote } = useNotesContentStore();
  const spaces = useSpacesStore((s) => s.spaces);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const spaceId = selectedSpaceId ?? "general";
  const isAllNotes = spaceId === "general";
  const noteList = notes[spaceId] ?? [];

  // Build a lookup from numeric space_id → display label
  const spaceLabel = (numericId: number | null): string | null => {
    if (!numericId) return null;
    const sp = spaces.find((s) => s.id === numericId);
    if (!sp) return null;
    return sp.emoji ? `${sp.emoji} ${sp.name}` : sp.name;
  };

  const currentSpace = isAllNotes ? null : spaces.find((s) => String(s.id) === spaceId);
  const headerLabel = isAllNotes
    ? "All Notes"
    : (currentSpace?.emoji ? `${currentSpace.emoji} ${currentSpace.name}` : currentSpace?.name ?? "Notes");

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

  const groups = isAllNotes ? groupNotes(noteList) : null;

  return (
    <div
      style={{ width: 260, minWidth: 260, height: "100vh", background: "#FAFAFA", display: "flex", flexDirection: "column", borderRight: "1px solid rgba(0,0,0,0.08)", boxSizing: "border-box" }}
    >
      {/* Header */}
      <div style={{ height: 52, padding: "0 14px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, borderBottom: "1px solid rgba(0,0,0,0.06)", gap: 8 }}>
        <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: "#1C1C1E", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif" }}>
          {headerLabel}
        </span>
        <button
          onClick={() => createNote(spaceId)}
          title="New note"
          style={{ width: 30, height: 30, borderRadius: 8, background: "rgba(0,0,0,0.06)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#3C3C43", padding: 0, flexShrink: 0, transition: "background 0.1s" }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.12)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M11 1.5L13.5 4L6.5 11H4V8.5L11 1.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none"/>
            <path d="M2 13.5H13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* Note list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {noteList.length === 0 && (
          <div style={{ padding: "32px 14px", textAlign: "center", color: "#AEAEB2", fontSize: 13, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>
            No notes yet. Press + to create one.
          </div>
        )}

        {groups
          ? groups.map(({ label, notes: sectionNotes }) => (
              <div key={label}>
                <SectionHeader label={label} />
                {sectionNotes.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    active={activeNoteId === note.id}
                    spaceId={spaceId}
                    dragging={draggingId === note.id}
                    spaceBadge={spaceLabel(note.space_id)}
                    onSelect={() => selectNote(note.id)}
                    onDragStart={(id) => setDraggingId(id)}
                    onDragEnd={() => setDraggingId(null)}
                    onContextMenu={handleContextMenu}
                  />
                ))}
              </div>
            ))
          : noteList.map((note) => (
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
