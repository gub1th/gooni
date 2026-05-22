import { useEffect, useRef, useState } from "react";
import { Pin as PinIcon } from "lucide-react";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useSpacesStore } from "../../stores/useSpacesStore";
import {
  cleanupEmptyNotes,
  fetchSpaceStats,
  patchNote,
  uploadImage,
  type ApiNote,
  type ApiSpaceStats,
} from "../../services/api";
import { usePinnedVersionStore } from "../../stores/usePinnedVersionStore";
import { SpaceIcon } from "./SpaceIcon";
import { displayTitle, extractFirstImage } from "../../utils/notePreview";

// Module-level drag state so Sidebar can read it without prop drilling
export let draggingNotePayload: { noteId: number; fromSpaceId: string } | null = null;

function parseDate(iso: string | null): Date | null {
  if (!iso) return null;
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  return new Date(hasOffset ? iso : iso + "Z");
}

// Compact "Xd ago" / "Xh ago" stamp for the space header. Falls back to
// the localized date when the gap is older than ~30 days.
function formatRelative(iso: string | null): string {
  const d = parseDate(iso);
  if (!d) return "—";
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 60_000) return "just now";
  const min = Math.floor(diffMs / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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

// Status filter pill — used in the row under the search bar to toggle
// Public / Draft / Pinned + show the active Space narrowing. Active vs
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
        color: active ? "#0A84FF" : "#636366",
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

// Single row in the space-filter dropdown menu. Tight, hover-tinted,
// shows an inline check mark on the active row.
function SpaceMenuItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
        padding: "6px 10px",
        border: "none",
        background: active ? "rgba(10,132,255,0.10)" : "transparent",
        cursor: "pointer",
        borderRadius: 6,
        fontSize: 12.5,
        color: active ? "#0A84FF" : "var(--gooni-text, #1C1C1E)",
        fontWeight: active ? 600 : 400,
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        textAlign: "left",
      }}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)";
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      <span>{label}</span>
      {active && <span style={{ fontSize: 11 }}>✓</span>}
    </button>
  );
}

function NoteRow({ note, active, spaceId, dragging, onSelect, onDragStart, onDragEnd, onContextMenu, onTogglePin }: NoteRowProps) {
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
            🌐 = public, ✏️ = draft, 📌 stays on the existing pin button
            below. Renders nothing for the default state. */}
        {note.is_draft && (
          <span
            title="Draft"
            style={{
              fontSize: 9,
              padding: "1px 5px",
              borderRadius: 4,
              background: "rgba(255,149,0,0.14)",
              color: "#B86E00",
              fontWeight: 600,
              letterSpacing: 0.3,
              flexShrink: 0,
              textTransform: "uppercase",
              fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
            }}
          >draft</span>
        )}
        {note.is_public && (
          <span
            title="Public"
            style={{
              fontSize: 10,
              color: "#0A84FF",
              flexShrink: 0,
              lineHeight: 1,
            }}
          >🌐</span>
        )}
        <span style={{
          fontSize: 10.5, color: "#C7C7CC", flexShrink: 0,
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
      color: "#AEAEB2",
      letterSpacing: 0.5,
      textTransform: "uppercase",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    }}>
      {label}
    </div>
  );
}

export function NotesList() {
  const { selectedSpaceId, notes, activeNoteId, createNote, selectNote, deleteNote, loadNotes } = useNotesContentStore();
  const spaces = useSpacesStore((s) => s.spaces);
  const updateSpaceStore = useSpacesStore((s) => s.updateSpace);
  const [descEditing, setDescEditing] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [spaceStats, setSpaceStats] = useState<ApiSpaceStats | null>(null);
  const [coverUploading, setCoverUploading] = useState(false);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [cleanConfirm, setCleanConfirm] = useState(false);
  const [search, setSearch] = useState("");
  // Status filters for All Notes — public / draft / pinned + optional
  // space narrowing. Stack as AND: enabling multiple means rows must
  // match all of them. Reset when leaving All Notes since they're
  // meaningless inside a single space.
  const [publicOnly, setPublicOnly] = useState(false);
  const [draftOnly, setDraftOnly] = useState(false);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [spaceFilter, setSpaceFilter] = useState<number | null>(null);
  const [spaceMenuOpen, setSpaceMenuOpen] = useState(false);
  const spaceMenuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const spaceId = selectedSpaceId ?? "general";
  const isAllNotes = spaceId === "general";
  const allNotes = notes[spaceId] ?? [];

  // Clear search whenever the user switches spaces — a query only makes sense
  // in the space it was typed in. Same for the public-only toggle: it only
  // applies on All Notes, so reset when leaving.
  useEffect(() => { setSearch(""); }, [spaceId]);
  useEffect(() => {
    if (!isAllNotes) {
      setPublicOnly(false);
      setDraftOnly(false);
      setPinnedOnly(false);
      setSpaceFilter(null);
      setSpaceMenuOpen(false);
    }
  }, [isAllNotes]);

  // Fetch space stats for the header (note count, last touched, top tags).
  // Re-runs when notes mutate so a freshly-created note bumps the count
  // without requiring a manual refresh.
  const allNotesForCount = notes[spaceId] ?? [];
  const allNotesLen = allNotesForCount.length;
  useEffect(() => {
    if (isAllNotes || spaceId === "general") {
      setSpaceStats(null);
      return;
    }
    const idNum = Number(spaceId);
    if (!Number.isFinite(idNum)) return;
    let cancelled = false;
    fetchSpaceStats(idNum)
      .then((s) => { if (!cancelled) setSpaceStats(s); })
      .catch((e) => console.warn("space stats fetch failed", e));
    return () => { cancelled = true; };
  }, [spaceId, isAllNotes, allNotesLen]);

  // Dismiss space-filter dropdown on outside click.
  useEffect(() => {
    if (!spaceMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (spaceMenuRef.current && !spaceMenuRef.current.contains(e.target as Node)) {
        setSpaceMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [spaceMenuOpen]);

  // Client-side title+excerpt search. Case-insensitive substring match.
  // List rows only carry `excerpt` (no full body) — full-content search
  // lives behind the semantic `/mcp/notes/search` route used by AllNotes.
  const searchTrimmed = search.trim().toLowerCase();
  const statusFiltered = !isAllNotes ? allNotes : allNotes.filter((n) => {
    if (publicOnly && !n.is_public) return false;
    if (draftOnly && !n.is_draft) return false;
    if (pinnedOnly && !n.is_pinned) return false;
    if (spaceFilter !== null && n.space_id !== spaceFilter) return false;
    return true;
  });
  const noteList = !searchTrimmed ? statusFiltered : statusFiltered.filter((n) => {
    const title = (n.title ?? "").toLowerCase();
    if (title.includes(searchTrimmed)) return true;
    const plain = (n.excerpt ?? (n.content ? stripHtml(n.content) : "")).toLowerCase();
    return plain.includes(searchTrimmed);
  });
  const anyFilterActive = publicOnly || draftOnly || pinnedOnly || spaceFilter !== null;
  const filterSpaceName = spaceFilter !== null
    ? (spaces.find((s) => typeof s.id === "number" && s.id === spaceFilter)?.name ?? "Space")
    : null;

  const currentSpace = isAllNotes ? null : spaces.find((s) => String(s.id) === spaceId);
  const headerName = isAllNotes ? "All Notes" : (currentSpace?.name ?? "Notes");

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
    await deleteNote(id, spaceId);
  }

  async function handleTogglePin(note: ApiNote) {
    const updated = await patchNote(note.id, { is_pinned: !note.is_pinned });
    usePinnedVersionStore.getState().bump();
    // Force-bypass the cache TTL — pinning shifts list order on the server,
    // and the user expects to see the change immediately.
    loadNotes(spaceId, { force: true });
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
    if (deleted > 0) loadNotes(spaceId, { force: true });
  }

  // Skip date grouping while searching — a flat, recency-ordered list reads better.
  const groups = isAllNotes && !searchTrimmed ? groupNotes(noteList) : null;

  return (
    <div
      style={{ width: 280, minWidth: 280, height: "100vh", background: "#FAFAFA", display: "flex", flexDirection: "column", borderRight: "1px solid rgba(0,0,0,0.08)", boxSizing: "border-box" }}
    >
      {/* Header */}
      <div style={{ height: 52, padding: "0 10px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, borderBottom: "1px solid rgba(0,0,0,0.06)", gap: 6 }}>
        <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 7, fontSize: 14, fontWeight: 600, color: "var(--gooni-text, #1C1C1E)", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", overflow: "hidden", whiteSpace: "nowrap" }}>
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
              fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
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

      {/* Space header — description + cover + stats. Hidden for All
          Notes since there's no underlying space row to attach metadata
          to. */}
      {!isAllNotes && currentSpace && (
        <div
          style={{
            position: "relative",
            padding: "10px 12px 8px",
            flexShrink: 0,
            background: currentSpace.cover_image_url
              ? `linear-gradient(rgba(255,255,255,0.82), rgba(255,255,255,0.95)), url(${JSON.stringify(currentSpace.cover_image_url).slice(1, -1)}) center/cover`
              : "transparent",
          }}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer?.items ?? []).some((i) => i.type.startsWith("image/"))) {
              e.preventDefault();
            }
          }}
          onDrop={async (e) => {
            const file = Array.from(e.dataTransfer?.files ?? []).find((f) =>
              f.type.startsWith("image/"),
            );
            if (!file || typeof currentSpace.id !== "number") return;
            e.preventDefault();
            setCoverUploading(true);
            try {
              const result = await uploadImage(file);
              if (result.kind === "url") {
                await updateSpaceStore(currentSpace.id as number, {
                  cover_image_url: result.url,
                });
              } else if (result.kind === "fallback") {
                console.warn("cover upload: R2 unconfigured, skipping");
              } else {
                console.warn("cover upload failed:", result.message);
              }
            } finally {
              setCoverUploading(false);
            }
          }}
        >
          {descEditing ? (
            <textarea
              autoFocus
              value={descDraft}
              onChange={(e) => setDescDraft(e.target.value)}
              onBlur={async () => {
                const next = descDraft.trim();
                const current = (currentSpace.description ?? "").trim();
                if (next !== current && typeof currentSpace.id === "number") {
                  try {
                    await updateSpaceStore(currentSpace.id, { description: next || null });
                  } catch (e) {
                    console.error("updateSpace description failed", e);
                  }
                }
                setDescEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDescDraft(currentSpace.description ?? "");
                  setDescEditing(false);
                }
              }}
              placeholder="What's this space for?"
              rows={3}
              style={{
                width: "100%",
                fontSize: 12,
                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                color: "var(--gooni-text, #1C1C1E)",
                background: "rgba(255,255,255,0.7)",
                border: "1px solid rgba(0,0,0,0.10)",
                borderRadius: 6,
                padding: "6px 8px",
                resize: "vertical",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          ) : (
            <div
              onClick={() => {
                setDescDraft(currentSpace.description ?? "");
                setDescEditing(true);
              }}
              title="Click to edit description"
              style={{
                fontSize: 12,
                color: currentSpace.description ? "#475569" : "rgba(142,142,147,0.85)",
                lineHeight: 1.4,
                cursor: "pointer",
                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                fontStyle: currentSpace.description ? "normal" : "italic",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {currentSpace.description || "+ add description"}
            </div>
          )}

          {/* Hidden file input that the cover-upload button trips. Click
              the camera icon → native file picker → R2 upload → PATCH
              cover_image_url. Drag-drop on the whole header also works
              (see the wrapping div's onDrop). */}
          <input
            ref={coverInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file || typeof currentSpace.id !== "number") return;
              setCoverUploading(true);
              try {
                const result = await uploadImage(file);
                if (result.kind === "url") {
                  await updateSpaceStore(currentSpace.id as number, {
                    cover_image_url: result.url,
                  });
                }
              } finally {
                setCoverUploading(false);
                if (coverInputRef.current) coverInputRef.current.value = "";
              }
            }}
          />

          {/* Footer — stats stack into two lines (notes + touched on
              line 1, top tags on line 2) so the 210px column doesn't
              pulverize them into a vertical drip of fragments. The
              "+ cover" affordance moves out of the row entirely into the
              card's top-right corner — keeps the stats line uncluttered. */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              marginTop: 6,
              fontSize: 11,
              color: "rgba(71,85,105,0.85)",
              fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
            }}
          >
            {spaceStats && (
              <>
                <span>
                  {spaceStats.note_count} note{spaceStats.note_count === 1 ? "" : "s"}
                  {spaceStats.last_touched && (
                    <span style={{ color: "rgba(142,142,147,0.85)" }}>
                      {" · "}{formatRelative(spaceStats.last_touched)}
                    </span>
                  )}
                </span>
                {spaceStats.top_tags.length > 0 && (
                  <span style={{ color: "rgba(142,142,147,0.85)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {spaceStats.top_tags.map((t) => `#${t.tag}`).join(" ")}
                  </span>
                )}
              </>
            )}
          </div>
          <div
            style={{
              position: "absolute",
              top: 6,
              right: 8,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <button
              onClick={() => coverInputRef.current?.click()}
              disabled={coverUploading}
              title={
                coverUploading
                  ? "Uploading cover…"
                  : currentSpace.cover_image_url
                    ? "Change cover image"
                    : "Add cover image (or drag/drop here)"
              }
              style={{
                background: "transparent",
                border: "none",
                cursor: coverUploading ? "wait" : "pointer",
                padding: "0 2px",
                color: "rgba(71,85,105,0.65)",
                fontSize: 11,
                lineHeight: 1,
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#0F172A")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "rgba(71,85,105,0.65)")}
            >
              {coverUploading ? "uploading…" : currentSpace.cover_image_url ? "change cover" : "+ cover"}
            </button>
            {currentSpace.cover_image_url && !coverUploading && (
              <button
                onClick={() => {
                  if (typeof currentSpace.id === "number") {
                    void updateSpaceStore(currentSpace.id as number, { cover_image_url: null });
                  }
                }}
                title="Remove cover image"
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  padding: "0 2px",
                  color: "rgba(239,68,68,0.55)",
                  fontSize: 11,
                  lineHeight: 1,
                }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#EF4444")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "rgba(239,68,68,0.55)")}
              >
                ×
              </button>
            )}
          </div>
        </div>
      )}

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
        {/* Status pill filters — only on All Notes. Active vs inactive
            states are visually distinct: active = filled accent bg +
            saturated text, inactive = outlined chip + muted text. */}
        {isAllNotes && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            <FilterPill
              label="Public"
              icon="🌐"
              active={publicOnly}
              onClick={() => setPublicOnly((v) => !v)}
            />
            <FilterPill
              label="Draft"
              icon="✏️"
              active={draftOnly}
              onClick={() => setDraftOnly((v) => !v)}
            />
            <FilterPill
              label="Pinned"
              icon="📌"
              active={pinnedOnly}
              onClick={() => setPinnedOnly((v) => !v)}
            />
            <div ref={spaceMenuRef} style={{ position: "relative" }}>
              <FilterPill
                label={filterSpaceName ?? "Space"}
                icon="▾"
                iconRight
                active={spaceFilter !== null}
                onClick={() => setSpaceMenuOpen((v) => !v)}
              />
              {spaceMenuOpen && (
                <div style={{
                  position: "absolute", top: "100%", left: 0, marginTop: 4,
                  background: "var(--gooni-card, #FFFFFF)",
                  border: "1px solid var(--gooni-border, rgba(0,0,0,0.08))",
                  borderRadius: 8, boxShadow: "0 6px 24px rgba(0,0,0,0.10)",
                  zIndex: 50, minWidth: 140, padding: 4, maxHeight: 260,
                  overflowY: "auto",
                }}>
                  <SpaceMenuItem
                    label="All spaces"
                    active={spaceFilter === null}
                    onClick={() => { setSpaceFilter(null); setSpaceMenuOpen(false); }}
                  />
                  {spaces
                    .filter((s): s is typeof s & { id: number } => typeof s.id === "number")
                    .map((s) => (
                      <SpaceMenuItem
                        key={s.id}
                        label={`${s.emoji ?? "📁"} ${s.name}`}
                        active={spaceFilter === s.id}
                        onClick={() => { setSpaceFilter(s.id); setSpaceMenuOpen(false); }}
                      />
                    ))}
                </div>
              )}
            </div>
            {anyFilterActive && (
              <button
                onClick={() => {
                  setPublicOnly(false);
                  setDraftOnly(false);
                  setPinnedOnly(false);
                  setSpaceFilter(null);
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
        )}
      </div>

      {/* Note list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {noteList.length === 0 && (
          <div style={{ padding: "32px 14px", textAlign: "center", color: "#AEAEB2", fontSize: 13, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>
            {searchTrimmed
              ? `No notes match “${search.trim()}”`
              : (isAllNotes && anyFilterActive)
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
            background: "var(--gooni-card, #FFFFFF)",
            borderRadius: 10,
            boxShadow: "0 4px 24px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.06)",
            padding: 6,
            minWidth: 160,
            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
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
              <div style={{ fontSize: 13, color: "var(--gooni-text, #1C1C1E)", marginBottom: 8, fontWeight: 500 }}>Delete this note?</div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={handleDelete}
                  style={{ flex: 1, padding: "5px 0", borderRadius: 6, border: "none", background: "#FF3B30", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
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
