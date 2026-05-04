import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Plus, FileText } from "lucide-react";
import {
  fetchRecentNotes,
  searchNotes,
  type ApiNote,
} from "../../services/api";
import { useSpacesStore } from "../../stores/useSpacesStore";
import { displayTitle } from "../../utils/notePreview";
import { SpaceIcon } from "./SpaceIcon";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

interface AllNotesDiscoveryProps {
  onSelectNote: (id: number) => void;
  onCompose: () => void;
}

// Replaces the "No note selected" empty state when the user is in
// All Notes view with no active note. Confluence-Quickfind style:
// big search bar at the top, recent notes as a card grid below,
// type to swap into semantic search results. Selecting a card calls
// onSelectNote which sets activeNoteId — the parent then re-renders
// the standard 2-column NotesList + NoteEditor layout.
export function AllNotesDiscovery({ onSelectNote, onCompose }: AllNotesDiscoveryProps) {
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<ApiNote[]>([]);
  const [results, setResults] = useState<ApiNote[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spaces = useSpacesStore((s) => s.spaces);

  // Map space id → emoji + name for the small space chip on each card.
  // The store types SpaceId as `number | "general"`; we only key the map by
  // numeric ids since notes carry numeric space_id (or null).
  const spaceById = useMemo(() => {
    const m = new Map<number, { name: string; emoji: string | null }>();
    for (const s of spaces) {
      if (typeof s.id === "number") m.set(s.id, { name: s.name, emoji: s.emoji });
    }
    return m;
  }, [spaces]);

  useEffect(() => {
    fetchRecentNotes(24).then(setRecent).catch(console.error);
    // Auto-focus so the user can type immediately.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Debounced semantic search. Empty query clears results so we fall back
  // to the recent grid.
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceTimer.current = setTimeout(async () => {
      try {
        const r = await searchNotes(q, 24);
        setResults(r);
      } catch (e) {
        console.error(e);
      } finally {
        setSearching(false);
      }
    }, 220);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [query]);

  const showResults = query.trim().length > 0;
  const visible = showResults ? results : recent;

  return (
    <div
      style={{
        flex: 1,
        height: "100%",
        overflowY: "auto",
        background: "var(--gooni-bg, #FFFFFF)",
        fontFamily: FONT,
      }}
    >
      <div
        style={{
          maxWidth: 880,
          margin: "0 auto",
          padding: "72px 32px 80px",
          boxSizing: "border-box",
        }}
      >
        {/* Header */}
        <div style={{ marginBottom: 28, textAlign: "center" }}>
          <div
            style={{
              fontSize: 28,
              fontWeight: 700,
              color: "var(--gooni-text, #1C1C1E)",
              letterSpacing: "-0.4px",
              marginBottom: 6,
            }}
          >
            All Notes
          </div>
          <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)" }}>
            Find a note across every space — or start a new one.
          </div>
        </div>

        {/* Big search bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "16px 20px",
            background: "var(--gooni-card, #FFFFFF)",
            border: "1px solid rgba(0,0,0,0.10)",
            borderRadius: 14,
            boxShadow: "0 4px 20px rgba(0,0,0,0.04)",
            marginBottom: 28,
          }}
        >
          <Search size={20} strokeWidth={1.7} color="var(--gooni-muted, #8E8E93)" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes by meaning…"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              fontSize: 16,
              fontFamily: FONT,
              color: "var(--gooni-text, #1C1C1E)",
              background: "transparent",
            }}
          />
          {searching && (
            <span style={{ fontSize: 11, color: "var(--gooni-muted, #8E8E93)" }}>searching…</span>
          )}
          <button
            onClick={onCompose}
            title="New note (⌘N)"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              borderRadius: 8,
              border: "none",
              background: "#1C1C1E",
              color: "#FFFFFF",
              fontFamily: FONT,
              fontSize: 12.5,
              fontWeight: 500,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <Plus size={13} strokeWidth={2} />
            New note
          </button>
        </div>

        {/* Section header */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <h3
            style={{
              fontSize: 12,
              letterSpacing: 1.2,
              textTransform: "uppercase",
              color: "var(--gooni-muted, #8E8E93)",
              fontWeight: 600,
              margin: 0,
            }}
          >
            {showResults ? "Search results" : "Recent"}
          </h3>
          <span style={{ fontSize: 11.5, color: "var(--gooni-muted, #8E8E93)" }}>
            {visible.length} {visible.length === 1 ? "note" : "notes"}
          </span>
        </div>

        {/* Card grid */}
        {visible.length === 0 ? (
          <div
            style={{
              padding: "48px 16px",
              textAlign: "center",
              color: "var(--gooni-muted, #8E8E93)",
              fontSize: 13.5,
            }}
          >
            {showResults ? "No notes match that query." : "No notes yet — create one above."}
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
              gap: 12,
            }}
          >
            {visible.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                space={note.space_id != null ? spaceById.get(note.space_id) ?? null : null}
                onClick={() => onSelectNote(note.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function NoteCard({
  note,
  space,
  onClick,
}: {
  note: ApiNote;
  space: { name: string; emoji: string | null } | null;
  onClick: () => void;
}) {
  const title = displayTitle(note);
  const preview = stripHtml(note.content ?? "").slice(0, 180);
  const updated = formatRelative(note.updated_at);

  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        textAlign: "left",
        gap: 8,
        padding: "14px 16px",
        background: "var(--gooni-card, #FFFFFF)",
        border: "1px solid rgba(0,0,0,0.08)",
        borderRadius: 12,
        cursor: "pointer",
        minHeight: 132,
        transition: "transform 0.12s, box-shadow 0.12s, border-color 0.12s",
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.transform = "translateY(-1px)";
        el.style.boxShadow = "0 6px 20px rgba(0,0,0,0.08)";
        el.style.borderColor = "rgba(0,0,0,0.14)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.transform = "translateY(0)";
        el.style.boxShadow = "none";
        el.style.borderColor = "rgba(0,0,0,0.08)";
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--gooni-muted, #8E8E93)" }}>
        <FileText size={12} strokeWidth={1.7} />
        {space ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5 }}>
            <SpaceIcon emoji={space.emoji} size={10} color="#8E8E93" />
            {space.name}
          </span>
        ) : (
          <span style={{ fontSize: 10.5 }}>General</span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 10.5 }}>{updated}</span>
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: "var(--gooni-text, #1C1C1E)",
          lineHeight: 1.35,
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {title}
      </div>
      {preview && (
        <div
          style={{
            fontSize: 12,
            color: "var(--gooni-muted, #8E8E93)",
            lineHeight: 1.5,
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
          }}
        >
          {preview}
        </div>
      )}
    </button>
  );
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
