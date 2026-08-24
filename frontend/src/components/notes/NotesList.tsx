import { useEffect, useRef, useState } from "react";
import { Pin as PinIcon } from "lucide-react";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import {
  cleanupEmptyNotes,
  fetchArchivedNotes,
  patchNote,
  type ApiNote,
  fetchNoteFolders,
} from "../../services/api";
import { usePinnedVersionStore } from "../../stores/usePinnedVersionStore";
import { displayTitle, extractFirstImage } from "../../utils/notePreview";
// see AllNotesDiscovery: `frostInk` mirrors `color`, so this is the whole
// migration for a legacy light surface.
import { frostInk as ctok, z } from "../../ui";
import { parseServerDate } from "../../utils/date";

// Tag-filter channel from the Sidebar. The event can fire BEFORE this
// component mounts (a folder click navigates to ?view=notes, which mounts
// NotesList a tick later), so a module-scope listener stashes the last
// selection and the component reads it on mount. The module is imported
// eagerly by routes/index.tsx, so the listener is always attached first.
//
// `undefined` = no folder narrowing. `null` = UNFILED, which is a real place
// and not the absence of a filter — collapsing the two would make "show me
// what I never filed" unreachable.
let pendingFolderFilter: number | null | undefined = undefined;
if (typeof window !== "undefined") {
  window.addEventListener("gooni:filter-folder", (e: Event) => {
    const d = (e as CustomEvent<{ folderId?: number | null }>).detail;
    pendingFolderFilter = d ? d.folderId : undefined;
  });
}

function formatTime(iso: string | null): string {
  const d = parseServerDate(iso);
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
    const d = parseServerDate(note.updated_at);
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
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent, noteId: number) => void;
  onTogglePin: (note: ApiNote) => void;
}

// Status filter pill — used in the row under the search bar to toggle
// Public / Pinned + show the active Space narrowing. Active vs
// inactive must read at a glance: active uses a tinted bg + accent text,
// inactive uses a muted outlined chip. Same height for keyboard rhythm.
function FilterPill({
  label,
  icon,
  active,
  iconRight,
  onClick,
}: {
  label: string;
  icon?: string;
  active: boolean;
  iconRight?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 22,
        padding: "0 9px",
        borderRadius: 11,
        background: active ? "rgba(10,132,255,0.14)" : "transparent",
        border: `1px solid ${active ? "rgba(10,132,255,0.35)" : "rgba(0,0,0,0.10)"}`,
        cursor: "pointer",
        color: active ? ctok.accent : "#636366",
        fontSize: 11,
        fontWeight: active ? 600 : 500,
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        transition: "background 0.1s, color 0.1s, border-color 0.1s",
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)";
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      {icon && !iconRight && <span style={{ fontSize: 10 }}>{icon}</span>}
      <span>{label}</span>
      {icon && iconRight && <span style={{ fontSize: 9, opacity: 0.7 }}>{icon}</span>}
    </button>
  );
}

function NoteRow({ note, active, onSelect, onContextMenu, onTogglePin }: NoteRowProps) {
  // Derive title from content when the note has no real title — so the list
  // never shows a row of repeated "New Note" placeholders. Prefer the
  // server-supplied `excerpt`/`thumb_src` (list endpoints don't ship full
  // body anymore — see ApiNote.content comment) and fall back to the local
  // strippers only when the legacy full-body shape is still in hand.
  const plain = note.excerpt ?? (note.content ? stripHtml(note.content) : "");
  const trimmedTitle = note.title?.trim() ?? "";
  const thumbSrc = note.thumb_src ?? (note.content ? extractFirstImage(note.content) : null);
  const hasBody = plain.length > 0;
  const title = trimmedTitle
    ? trimmedTitle
    : hasBody
      ? displayTitle(note)
      : thumbSrc
        ? "Image"
        : "Untitled";
  let preview: string;
  if (trimmedTitle) {
    preview = plain.slice(0, 60);
  } else if (hasBody) {
    const rest = plain.slice(title.length).trim();
    preview = rest.slice(0, 60);
  } else {
    preview = "";
  }

  return (
    <div
      onClick={onSelect}
      onContextMenu={(e) => onContextMenu(e, note.id)}
      style={{
        position: "relative",
        padding: "15px 14px",
        borderBottom: "1px solid rgba(0,0,0,0.06)",
        cursor: "pointer",
        background: active ? "rgba(0,0,0,0.07)" : "transparent",
        transition: "background 0.1s",
        userSelect: "none",
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
            color: "var(--gooni-text, #1C1C1E)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
          }}
        >
          {title}
        </div>
        {/* Status badges — tiny chips just before the timestamp.
            🌐 = public, 📌 stays on the existing pin button below.
            Renders nothing for the default state. */}
        {note.is_public && (
          <span
            title="Public"
            style={{
              fontSize: 10,
              color: ctok.accent,
              flexShrink: 0,
              lineHeight: 1,
            }}
          >🌐</span>
        )}
        <span style={{
          fontSize: 10.5, color: ctok.disabled, flexShrink: 0,
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
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
            fontSize: 11.5, color: "var(--gooni-muted, #8E8E93)",
            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            minWidth: 0,
          }}>
            {preview || (thumbSrc ? <span style={{ fontStyle: "italic", color: ctok.disabled }}>image</span> : null)}
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
          padding: "3px 5px", lineHeight: 0,
          transition: "opacity 0.1s, color 0.12s",
          borderRadius: 5,
          color: note.is_pinned ? "#6B7280" : "rgba(142,142,147,0.6)",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        }}
      ><PinIcon size={11} strokeWidth={2} /></button>
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{
      padding: "16px 14px 6px",
      fontSize: 10.5,
      fontWeight: 600,
      color: ctok.faint,
      letterSpacing: 0.5,
      textTransform: "uppercase",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    }}>
      {label}
    </div>
  );
}

export function NotesList() {
  // Per-field selectors, not a whole-store destructure. Destructuring
  // subscribes to EVERY store write, so one note's refetch re-rendered every
  // consumer — and the save path fires several writes per edit. Zustand's
  // actions are stable identities defined once in the creator, so selecting
  // them individually never triggers a render on its own.
  const notes = useNotesContentStore((s) => s.notes);
  const activeNoteId = useNotesContentStore((s) => s.activeNoteId);
  const createNote = useNotesContentStore((s) => s.createNote);
  const selectNote = useNotesContentStore((s) => s.selectNote);
  const deleteNote = useNotesContentStore((s) => s.deleteNote);
  const loadNotes = useNotesContentStore((s) => s.loadNotes);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [cleanConfirm, setCleanConfirm] = useState(false);
  const [search, setSearch] = useState("");
  // Status filters — public / pinned. Stack as AND: enabling
  // multiple means rows must match all of them.
  const [publicOnly, setPublicOnly] = useState(false);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  // The Archived view. Deliberately NOT another AND-stacked status filter
  // like the three above: archived notes are absent from the store's list
  // entirely (the server excludes them from GET /notes), so this switches the
  // list's SOURCE to the archive read rather than narrowing what's loaded.
  const [archivedOnly, setArchivedOnly] = useState(false);
  const [archivedNotes, setArchivedNotes] = useState<ApiNote[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  // Bumped after every archive/unarchive so the archive list refetches while
  // it's on screen — unarchiving from inside it has to make the row leave.
  const [archiveVersion, setArchiveVersion] = useState(0);
  // Folder filter — set by the Sidebar's folder tree via gooni:filter-folder.
  // Seeded from the module-level stash so a click that mounted this component
  // still applies (see pendingFolderFilter above).
  const [folderFilter, setFolderFilter] = useState<number | null | undefined>(() => pendingFolderFilter);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // All notes live in the one "general" bucket since Spaces died.
  const allNotes = notes;

  // Follow subsequent folder clicks while mounted.
  useEffect(() => {
    function onFilterFolder(e: Event) {
      const d = (e as CustomEvent<{ folderId?: number | null }>).detail;
      setFolderFilter(d ? d.folderId : undefined);
    }
    window.addEventListener("gooni:filter-folder", onFilterFolder);
    return () => window.removeEventListener("gooni:filter-folder", onFilterFolder);
  }, []);

  // Load the archive only while the view is open. It's a recovery surface,
  // not something worth fetching on every notes visit.
  useEffect(() => {
    if (!archivedOnly) return;
    let cancelled = false;
    setArchivedLoading(true);
    fetchArchivedNotes()
      .then((rows) => { if (!cancelled) setArchivedNotes(rows); })
      .catch(() => { if (!cancelled) setArchivedNotes([]); })
      .finally(() => { if (!cancelled) setArchivedLoading(false); });
    return () => { cancelled = true; };
  }, [archivedOnly, archiveVersion]);

  function clearFolderFilter() {
    setFolderFilter(undefined);
  }

  // Folder id -> name, for the filter chip. Its own small read rather than a
  // prop from the Sidebar: NotesList also mounts on surfaces where the
  // sidebar isn't rendered, and a chip that can't name its folder is worse
  // than no chip.
  const [folderNames, setFolderNames] = useState<Record<number, string>>({});
  useEffect(() => {
    if (folderFilter === undefined || folderFilter === null) return;
    if (folderNames[folderFilter]) return;
    fetchNoteFolders()
      .then((r) => setFolderNames(Object.fromEntries(r.folders.map((f) => [f.id, f.name]))))
      .catch(() => {});
  }, [folderFilter, folderNames]);

  // Client-side title+excerpt search. Case-insensitive substring match.
  // List rows only carry `excerpt` (no full body) — full-content search
  // lives behind the semantic `/mcp/notes/search` route used by AllNotes.
  const searchTrimmed = search.trim().toLowerCase();
  // In the Archived view the archive read IS the list — the store's notes
  // never contain archived rows, so there is nothing to filter down to.
  const sourceNotes = archivedOnly ? archivedNotes : allNotes;
  const statusFiltered = sourceNotes.filter((n) => {
    if (publicOnly && !n.is_public) return false;
    if (pinnedOnly && !n.is_pinned) return false;
    // undefined = no narrowing; null = unfiled; a number = that folder.
    if (folderFilter !== undefined) {
      if (folderFilter === null) { if (n.topic_id != null) return false; }
      else if (n.topic_id !== folderFilter) return false;
    }
    return true;
  });
  const noteList = !searchTrimmed ? statusFiltered : statusFiltered.filter((n) => {
    const title = (n.title ?? "").toLowerCase();
    if (title.includes(searchTrimmed)) return true;
    const plain = (n.excerpt ?? (n.content ? stripHtml(n.content) : "")).toLowerCase();
    return plain.includes(searchTrimmed);
  });
  const anyFilterActive = publicOnly || pinnedOnly || archivedOnly || folderFilter !== undefined;

  const headerName = "All Notes";

  // Cmd/Ctrl-F stays as native browser find. Daniel asked for the
  // standard shortcut back — hijacking it for the notes-rail search
  // ate every page-level find-in-text use, which mattered more once
  // notes started carrying long pasted transcripts.

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
    await deleteNote(id);
  }

  async function handleArchive(archive: boolean) {
    if (!contextMenu) return;
    const id = contextMenu.noteId;
    setContextMenu(null);
    // One click each way, no confirm step: archiving destroys nothing, and a
    // confirm dialog would make it read like the delete it exists to replace.
    await patchNote(id, { is_archived: archive });
    // Pins live in their own sidebar section fed by a separate read, and an
    // archived note has to leave it — bump so the sidebar refetches.
    usePinnedVersionStore.getState().bump();
    setArchiveVersion((v) => v + 1);
    // Force past the cache TTL: the row has to disappear from (or reappear
    // in) the main list on this click, not on the next natural refetch.
    loadNotes({ force: true });
  }

  async function handleTogglePin(note: ApiNote) {
    const updated = await patchNote(note.id, { is_pinned: !note.is_pinned });
    usePinnedVersionStore.getState().bump();
    // Force-bypass the cache TTL — pinning shifts list order on the server,
    // and the user expects to see the change immediately.
    loadNotes({ force: true });
    return updated;
  }

  async function handleCleanInbox() {
    if (!cleanConfirm) {
      setCleanConfirm(true);
      return;
    }
    setCleanConfirm(false);
    const { deleted } = await cleanupEmptyNotes();
    // Always force after cleanup — if 0 deleted, no-op refetch is fine and
    // it surfaces any external deletes that happened since the last fetch.
    if (deleted > 0) loadNotes({ force: true });
  }

  // Skip date grouping while searching — a flat, recency-ordered list reads better.
  const groups = !searchTrimmed ? groupNotes(noteList) : null;

  return (
    <div
      style={{ width: 280, minWidth: 280, height: "100vh", background: ctok.bg, display: "flex", flexDirection: "column", borderRight: "1px solid rgba(0,0,0,0.08)", boxSizing: "border-box" }}
    >
      {/* Header */}
      <div style={{ height: 52, padding: "0 10px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, borderBottom: "1px solid rgba(0,0,0,0.06)", gap: 6 }}>
        <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 7, fontSize: 14, fontWeight: 600, color: "var(--gooni-text, #1C1C1E)", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", overflow: "hidden", whiteSpace: "nowrap" }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{headerName}</span>
        </span>
        <button
          onClick={handleCleanInbox}
          onMouseLeave={() => setCleanConfirm(false)}
          title={cleanConfirm ? "Click again to confirm" : "Delete empty untitled notes"}
          style={{
            height: 26, padding: "0 8px", borderRadius: 6,
            background: cleanConfirm ? ctok.danger : "transparent", border: "none",
            cursor: "pointer", color: cleanConfirm ? "#fff" : ctok.muted, fontSize: 11.5,
            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
            fontWeight: 500, flexShrink: 0, transition: "background 0.1s, color 0.1s",
          }}
          onMouseEnter={(e) => { if (!cleanConfirm) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)"; }}
        >
          {cleanConfirm ? "sure?" : "🧹"}
        </button>
        <button
          onClick={() => createNote()}
          title="New note"
          style={{ width: 28, height: 28, borderRadius: 7, background: "rgba(0,0,0,0.06)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--gooni-text, #3C3C43)", padding: 0, flexShrink: 0, transition: "background 0.1s" }}
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
            style={{ position: "absolute", left: 8, pointerEvents: "none", color: ctok.faint }}
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
              borderRadius: 7, border: "1px solid var(--gooni-border, rgba(0,0,0,0.08))",
              background: "var(--gooni-card, #fff)", outline: "none", fontSize: 12.5,
              fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
              color: "var(--gooni-text, #1C1C1E)",
            }}
          />
          {search && (
            <button
              onClick={() => { setSearch(""); searchRef.current?.focus(); }}
              title="Clear"
              style={{
                position: "absolute", right: 4, width: 20, height: 20,
                borderRadius: 4, border: "none", background: "transparent",
                cursor: "pointer", color: "var(--gooni-muted, #8E8E93)", fontSize: 14,
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: 0,
              }}
            >×</button>
          )}
        </div>
        {/* Status pill filters. Active vs inactive states are visually
            distinct: active = filled accent bg + saturated text,
            inactive = outlined chip + muted text. */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          <FilterPill
            label="Public"
            icon="🌐"
            active={publicOnly}
            onClick={() => setPublicOnly((v) => !v)}
          />
          <FilterPill
            label="Pinned"
            icon="📌"
            active={pinnedOnly}
            onClick={() => setPinnedOnly((v) => !v)}
          />
          <FilterPill
            label="Archived"
            icon="🗄"
            active={archivedOnly}
            onClick={() => setArchivedOnly((v) => !v)}
          />
          {/* Folder chip — set by the Sidebar's folder tree. Click to clear.
              Named, because "filtered by a folder" is useless if it doesn't
              say which; Unfiled says so by name for the same reason. */}
          {folderFilter !== undefined && (
            <FilterPill
              label={
                folderFilter === null
                  ? "Unfiled ✕"
                  : `${folderNames[folderFilter] ?? "folder"} ✕`
              }
              active
              onClick={clearFolderFilter}
            />
          )}
          {anyFilterActive && (
            <button
              onClick={() => {
                setPublicOnly(false);
                setPinnedOnly(false);
                setArchivedOnly(false);
                clearFolderFilter();
              }}
              title="Clear all filters"
              style={{
                height: 22, padding: "0 8px", borderRadius: 11,
                background: "transparent", border: "none", cursor: "pointer",
                color: "var(--gooni-muted, #8E8E93)", fontSize: 11,
                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
              }}
            >clear</button>
          )}
        </div>
      </div>

      {/* Note list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {noteList.length === 0 && (
          <div style={{ padding: "32px 14px", textAlign: "center", color: ctok.faint, fontSize: 13, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>
            {archivedLoading
              ? "Loading archive…"
              : archivedOnly && !searchTrimmed
              ? "Nothing archived. Right-click a note › Archive to file it away."
              : searchTrimmed
              ? `No notes match “${search.trim()}”`
              : anyFilterActive
                ? "No notes match the active filters. Click 'clear' to reset."
                : "No notes yet. Press + to create one."}
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
                    onSelect={() => selectNote(note.id)}
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
                onSelect={() => selectNote(note.id)}
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
            zIndex: z.dropdown,
            background: "var(--gooni-card, #FFFFFF)",
            borderRadius: 10,
            boxShadow: "0 4px 24px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.06)",
            padding: 6,
            minWidth: 160,
            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
          }}
        >
          {!contextMenu.confirming ? (
            <>
            {/* Archive sits ABOVE delete and reads in neutral ink, not
                `danger` — the wording and the colour both have to say
                "filed away", never "removed", or it gets mistaken for the
                destructive action directly beneath it. */}
            <button
              onClick={() => handleArchive(!archivedOnly)}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 10px", border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, fontSize: 13.5, color: "var(--gooni-text, #1C1C1E)", textAlign: "left" }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
              title={archivedOnly ? "Put this note back in the notes list" : "Hide from lists and search — keeps the note"}
            >
              {archivedOnly ? "↩︎ Unarchive Note" : "🗄 Archive Note"}
            </button>
            <button
              onClick={handleDelete}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 10px", border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, fontSize: 13.5, color: ctok.danger, textAlign: "left" }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(255,59,48,0.08)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
            >
              🗑 Delete Note
            </button>
            </>
          ) : (
            <div style={{ padding: "6px 10px" }}>
              <div style={{ fontSize: 13, color: "var(--gooni-text, #1C1C1E)", marginBottom: 8, fontWeight: 500 }}>Delete this note?</div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={handleDelete}
                  style={{ flex: 1, padding: "5px 0", borderRadius: 6, border: "none", background: ctok.danger, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                >
                  Delete
                </button>
                <button
                  onClick={() => setContextMenu(null)}
                  style={{ flex: 1, padding: "5px 0", borderRadius: 6, border: "none", background: "rgba(0,0,0,0.07)", color: "var(--gooni-text, #1C1C1E)", fontSize: 13, cursor: "pointer" }}
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
