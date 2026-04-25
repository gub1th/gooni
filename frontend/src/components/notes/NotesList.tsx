import { useEffect, useRef, useState } from "react";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useSpacesStore } from "../../stores/useSpacesStore";
import { cleanupEmptyNotes, patchNote, type ApiNote } from "../../services/api";
import { usePinnedVersionStore } from "../../stores/usePinnedVersionStore";
import { SpaceIcon } from "./SpaceIcon";
import { extractFirstImage } from "../../utils/notePreview";

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
  onTogglePin: (note: ApiNote) => void;
}

function NoteRow({ note, active, spaceId, dragging, onSelect, onDragStart, onDragEnd, onContextMenu, onTogglePin }: NoteRowProps) {
  // Derive title from content when the note has no real title — so the list
  // never shows a row of repeated "New Note" placeholders.
  const plain = note.content ? stripHtml(note.content) : "";
  const trimmedTitle = note.title?.trim() ?? "";
  const thumbSrc = note.content ? extractFirstImage(note.content) : null;
  let title: string;
  let preview: string;
  if (trimmedTitle) {
    title = trimmedTitle;
    preview = plain.slice(0, 60);
  } else if (plain) {
    // First line (or first ~50 chars) becomes the display title.
    const firstLineBreak = plain.search(/[\n\r]/);
    title = plain.slice(0, firstLineBreak > 0 ? firstLineBreak : 50).trim() || "Untitled";
    const rest = plain.slice(title.length).trim();
    preview = rest.slice(0, 60);
  } else if (thumbSrc) {
    title = "Image";
    preview = "";
  } else {
    title = "Untitled";
    preview = "";
  }

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
        position: "relative",
        padding: "15px 14px",
        borderBottom: "1px solid rgba(0,0,0,0.06)",
        cursor: note.id > 0 ? "grab" : "pointer",
        background: active ? "rgba(0,0,0,0.07)" : "transparent",
        transition: "background 0.1s, opacity 0.15s",
        userSelect: "none",
        opacity: dragging ? 0.4 : 1,
      }}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.04)";
        (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLButtonElement>(".row-action").forEach(b => b.style.opacity = "1");
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLDivElement).style.background = "transparent";
        (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLButtonElement>(".row-action").forEach(b => b.style.opacity = "0");
      }}
    >
      {/* Title row: title left, timestamp right, pin button absolute on hover */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <div
          style={{
            flex: 1,
            fontSize: 13.5,
            fontWeight: 600,
            color: "#1C1C1E",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
          }}
        >
          {title}
        </div>
        <span style={{
          fontSize: 10.5, color: "#C7C7CC", flexShrink: 0,
          fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
          fontVariantNumeric: "tabular-nums",
        }}>
          {formatTime(note.updated_at)}
        </span>
      </div>
      {/* Preview row — text on the left, optional image thumb on the right.
          Thumb is shown even when there's no text (e.g. image-only notes). */}
      {(preview || thumbSrc) && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
          <div style={{
            flex: 1,
            fontSize: 11.5, color: "#8E8E93",
            fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            minWidth: 0,
          }}>
            {preview || (thumbSrc ? <span style={{ fontStyle: "italic", color: "#C7C7CC" }}>image</span> : null)}
          </div>
          {thumbSrc && (
            <div style={{
              width: 28, height: 28, borderRadius: 4,
              overflow: "hidden", flexShrink: 0,
              background: "rgba(0,0,0,0.04)",
            }}>
              <img
                src={thumbSrc}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              />
            </div>
          )}
        </div>
      )}
      {/* Pin button — hover-only. The Pinned section in the sidebar is the source of truth. */}
      <button
        className="row-action"
        onClick={(e) => { e.stopPropagation(); onTogglePin(note); }}
        title={note.is_pinned ? "Unpin" : "Pin"}
        style={{
          position: "absolute", top: 6, right: 5,
          opacity: 0,
          background: "rgba(255,255,255,0.85)",
          border: "none", cursor: "pointer",
          fontSize: 10, padding: "2px 5px", lineHeight: 1,
          transition: "opacity 0.1s",
          borderRadius: 5,
          filter: note.is_pinned ? "none" : "grayscale(1) opacity(0.6)",
        }}
      >📌</button>
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{
      padding: "16px 14px 6px",
      fontSize: 10.5,
      fontWeight: 600,
      color: "#AEAEB2",
      letterSpacing: 0.5,
      textTransform: "uppercase",
      fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
    }}>
      {label}
    </div>
  );
}

export function NotesList() {
  const { selectedSpaceId, notes, activeNoteId, createNote, selectNote, deleteNote, loadNotes } = useNotesContentStore();
  const spaces = useSpacesStore((s) => s.spaces);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [cleanConfirm, setCleanConfirm] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const spaceId = selectedSpaceId ?? "general";
  const isAllNotes = spaceId === "general";
  const allNotes = notes[spaceId] ?? [];

  // Clear search whenever the user switches spaces — a query only makes sense
  // in the space it was typed in.
  useEffect(() => { setSearch(""); }, [spaceId]);

  // Client-side title+content search. Case-insensitive substring match.
  const searchTrimmed = search.trim().toLowerCase();
  const noteList = !searchTrimmed ? allNotes : allNotes.filter((n) => {
    const title = (n.title ?? "").toLowerCase();
    if (title.includes(searchTrimmed)) return true;
    const plain = n.content ? stripHtml(n.content).toLowerCase() : "";
    return plain.includes(searchTrimmed);
  });

  const currentSpace = isAllNotes ? null : spaces.find((s) => String(s.id) === spaceId);
  const headerName = isAllNotes ? "All Notes" : (currentSpace?.name ?? "Notes");

  // ⌘F / Ctrl-F focuses the search input when the notes pane is visible.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

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

  async function handleTogglePin(note: ApiNote) {
    const updated = await patchNote(note.id, { is_pinned: !note.is_pinned });
    usePinnedVersionStore.getState().bump();
    loadNotes(spaceId);
    return updated;
  }

  async function handleCleanInbox() {
    if (!cleanConfirm) {
      setCleanConfirm(true);
      return;
    }
    setCleanConfirm(false);
    const { deleted } = await cleanupEmptyNotes();
    if (deleted > 0) loadNotes(spaceId);
  }

  // Skip date grouping while searching — a flat, recency-ordered list reads better.
  const groups = isAllNotes && !searchTrimmed ? groupNotes(noteList) : null;

  return (
    <div
      style={{ width: 210, minWidth: 210, height: "100vh", background: "#FAFAFA", display: "flex", flexDirection: "column", borderRight: "1px solid rgba(0,0,0,0.08)", boxSizing: "border-box" }}
    >
      {/* Header */}
      <div style={{ height: 52, padding: "0 10px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, borderBottom: "1px solid rgba(0,0,0,0.06)", gap: 6 }}>
        <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 7, fontSize: 14, fontWeight: 600, color: "#1C1C1E", fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif", overflow: "hidden", whiteSpace: "nowrap" }}>
          {!isAllNotes && currentSpace && (
            <SpaceIcon emoji={currentSpace.emoji} size={14} />
          )}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{headerName}</span>
        </span>
        {isAllNotes && (
          <button
            onClick={handleCleanInbox}
            onMouseLeave={() => setCleanConfirm(false)}
            title={cleanConfirm ? "Click again to confirm" : "Delete empty untitled notes"}
            style={{
              height: 26, padding: "0 8px", borderRadius: 6,
              background: cleanConfirm ? "#FF3B30" : "transparent", border: "none",
              cursor: "pointer", color: cleanConfirm ? "#fff" : "#8E8E93", fontSize: 11.5,
              fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
              fontWeight: 500, flexShrink: 0, transition: "background 0.1s, color 0.1s",
            }}
            onMouseEnter={(e) => { if (!cleanConfirm) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)"; }}
          >
            {cleanConfirm ? "sure?" : "🧹"}
          </button>
        )}
        <button
          onClick={() => createNote(spaceId)}
          title="New note"
          style={{ width: 28, height: 28, borderRadius: 7, background: "rgba(0,0,0,0.06)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#3C3C43", padding: 0, flexShrink: 0, transition: "background 0.1s" }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.12)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
        >
          <svg width="13" height="13" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M11 1.5L13.5 4L6.5 11H4V8.5L11 1.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none"/>
            <path d="M2 13.5H13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* Search row — compact, always visible */}
      <div style={{ padding: "8px 10px", borderBottom: "1px solid rgba(0,0,0,0.06)", flexShrink: 0 }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <svg
            width="12" height="12" viewBox="0 0 14 14" fill="none"
            style={{ position: "absolute", left: 8, pointerEvents: "none", color: "#AEAEB2" }}
          >
            <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M9 9L12 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setSearch(""); (e.target as HTMLInputElement).blur(); } }}
            placeholder="Search notes"
            style={{
              flex: 1, minWidth: 0, height: 28, padding: "0 26px",
              boxSizing: "border-box",
              borderRadius: 7, border: "1px solid rgba(0,0,0,0.08)",
              background: "#fff", outline: "none", fontSize: 12.5,
              fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
              color: "#1C1C1E",
            }}
          />
          {search && (
            <button
              onClick={() => { setSearch(""); searchRef.current?.focus(); }}
              title="Clear"
              style={{
                position: "absolute", right: 4, width: 20, height: 20,
                borderRadius: 4, border: "none", background: "transparent",
                cursor: "pointer", color: "#8E8E93", fontSize: 14,
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: 0,
              }}
            >×</button>
          )}
        </div>
      </div>

      {/* Note list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {noteList.length === 0 && (
          <div style={{ padding: "32px 14px", textAlign: "center", color: "#AEAEB2", fontSize: 13, fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif" }}>
            {searchTrimmed ? `No notes match “${search.trim()}”` : "No notes yet. Press + to create one."}
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
                    onSelect={() => selectNote(note.id)}
                    onDragStart={(id) => setDraggingId(id)}
                    onDragEnd={() => setDraggingId(null)}
                    onContextMenu={handleContextMenu}
                    onTogglePin={handleTogglePin}
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
                onTogglePin={handleTogglePin}
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
            fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
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
