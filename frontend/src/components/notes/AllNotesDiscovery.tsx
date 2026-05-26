import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Plus, FileText, Image as ImageIcon } from "lucide-react";
import {
  cleanupEmptyNotes,
  fetchRecentNotes,
  searchNotes,
  type ApiNote,
} from "../../services/api";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useSpacesStore } from "../../stores/useSpacesStore";
import { displayTitle, extractFirstImage } from "../../utils/notePreview";
import { SpaceIcon } from "./SpaceIcon";
import { color as ctok, FONT } from "../../ui";


interface AllNotesDiscoveryProps {
  onSelectNote: (id: number) => void;
  onCompose: () => void;
}

// All Notes empty state. Confluence Quickfind-style: big search bar at the
// top, full-width row results below. Each row spans the editor area and
// shows a small image thumbnail when the note has an inline image, plus
// title, preview, space chip, and relative timestamp.
//
// "New note" lives OUTSIDE the search box (next to the title) since it
// isn't a search affordance — it's a creation affordance. Cleanup button
// (delete empty stubs) sits next to it because the standard NotesList
// isn't mounted in this view, so its 🧹 button would otherwise be
// unreachable in the All-Notes-empty state.
export function AllNotesDiscovery({ onSelectNote, onCompose }: AllNotesDiscoveryProps) {
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<ApiNote[]>([]);
  const [results, setResults] = useState<ApiNote[]>([]);
  const [searching, setSearching] = useState(false);
  const [cleanConfirm, setCleanConfirm] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spaces = useSpacesStore((s) => s.spaces);
  const loadNotes = useNotesContentStore((s) => s.loadNotes);

  const spaceById = useMemo(() => {
    const m = new Map<number, { name: string; emoji: string | null }>();
    for (const s of spaces) {
      if (typeof s.id === "number") m.set(s.id, { name: s.name, emoji: s.emoji });
    }
    return m;
  }, [spaces]);

  async function refreshRecent() {
    try {
      const r = await fetchRecentNotes(40);
      setRecent(r);
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => {
    refreshRecent();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

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
        const r = await searchNotes(q, 40);
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

  async function handleClean() {
    if (!cleanConfirm) {
      setCleanConfirm(true);
      return;
    }
    setCleanConfirm(false);
    try {
      const { deleted } = await cleanupEmptyNotes();
      if (deleted > 0) {
        await loadNotes("general");
        await refreshRecent();
      }
    } catch (e) {
      console.error(e);
    }
  }

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
          padding: "60px 32px 80px",
          boxSizing: "border-box",
        }}
      >
        {/* Header — title left, action buttons right. New-note + cleanup
            sit OUTSIDE the search bar since neither is a search affordance. */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
            marginBottom: 22,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 26,
                fontWeight: 700,
                color: "var(--gooni-text, #1C1C1E)",
                letterSpacing: "-0.4px",
                marginBottom: 4,
              }}
            >
              All Notes
            </div>
            <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)" }}>
              Find a note across every space — or start a new one.
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <button
              onClick={handleClean}
              onMouseLeave={() => setCleanConfirm(false)}
              title={cleanConfirm ? "Click again to confirm" : "Delete empty untitled notes"}
              style={{
                height: 32, padding: "0 12px", borderRadius: 8,
                background: cleanConfirm ? ctok.danger : "transparent",
                border: cleanConfirm ? "none" : "1px solid rgba(0,0,0,0.10)",
                cursor: "pointer",
                color: cleanConfirm ? "#fff" : "var(--gooni-muted, #8E8E93)",
                fontSize: 12.5, fontWeight: 500,
                fontFamily: FONT,
                display: "inline-flex", alignItems: "center", gap: 6,
              }}
            >
              {cleanConfirm ? "Sure?" : "🧹 Clean up"}
            </button>
            <button
              onClick={onCompose}
              title="New note (⌘N)"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "0 14px",
                height: 32,
                borderRadius: 8,
                border: "none",
                background: ctok.text,
                color: ctok.card,
                fontFamily: FONT,
                fontSize: 12.5,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              <Plus size={13} strokeWidth={2} />
              New note
            </button>
          </div>
        </div>

        {/* Search bar — search affordance only, no embedded action button */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "14px 18px",
            background: "var(--gooni-card, #FFFFFF)",
            border: "1px solid rgba(0,0,0,0.10)",
            borderRadius: 12,
            boxShadow: "0 4px 20px rgba(0,0,0,0.04)",
            marginBottom: 24,
          }}
        >
          <Search size={18} strokeWidth={1.7} color="var(--gooni-muted, #8E8E93)" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes by meaning…"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              fontSize: 15,
              fontFamily: FONT,
              color: "var(--gooni-text, #1C1C1E)",
              background: "transparent",
            }}
          />
          {searching && (
            <span style={{ fontSize: 11, color: "var(--gooni-muted, #8E8E93)" }}>searching…</span>
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <h3
            style={{
              fontSize: 11.5,
              letterSpacing: 1.2,
              textTransform: "uppercase",
              color: "var(--gooni-muted, #8E8E93)",
              fontWeight: 600,
              margin: 0,
            }}
          >
            {showResults ? "Search results" : "Recent"}
          </h3>
          <span style={{ fontSize: 11, color: "var(--gooni-muted, #8E8E93)" }}>
            {visible.length} {visible.length === 1 ? "note" : "notes"}
          </span>
        </div>

        {visible.length === 0 ? (
          <div
            style={{
              padding: "48px 16px",
              textAlign: "center",
              color: "var(--gooni-muted, #8E8E93)",
              fontSize: 13.5,
            }}
          >
            {showResults ? "No notes match that query." : "No notes yet — click New note above."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {visible.map((note) => (
              <NoteRow
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

function NoteRow({
  note,
  space,
  onClick,
}: {
  note: ApiNote;
  space: { name: string; emoji: string | null } | null;
  onClick: () => void;
}) {
  const title = displayTitle(note);
  const plain = stripHtml(note.content ?? "");
  const preview = plain.slice(0, 240);
  const updated = formatRelative(note.updated_at);
  const thumb = note.content ? extractFirstImage(note.content) : null;

  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 14,
        padding: "12px 14px",
        background: "var(--gooni-card, #FFFFFF)",
        border: "1px solid rgba(0,0,0,0.06)",
        borderRadius: 10,
        cursor: "pointer",
        textAlign: "left",
        transition: "background 0.12s, border-color 0.12s",
        fontFamily: FONT,
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.background = "rgba(0,0,0,0.025)";
        el.style.borderColor = "rgba(0,0,0,0.12)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.background = "var(--gooni-card, #FFFFFF)";
        el.style.borderColor = "rgba(0,0,0,0.06)";
      }}
    >
      {/* Thumbnail (image preview if present, else FileText icon as a
          neutral placeholder so all rows align) */}
      <div
        style={{
          width: 56,
          height: 56,
          flexShrink: 0,
          borderRadius: 8,
          overflow: "hidden",
          background: "rgba(0,0,0,0.04)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--gooni-muted, #B0B0B5)",
        }}
      >
        {thumb ? (
          <img
            src={thumb}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            loading="lazy"
          />
        ) : (
          <FileText size={20} strokeWidth={1.6} />
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <div
          style={{
            fontSize: 14.5,
            fontWeight: 600,
            color: "var(--gooni-text, #1C1C1E)",
            lineHeight: 1.35,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </div>
        {preview && (
          <div
            style={{
              fontSize: 12.5,
              color: "var(--gooni-muted, #8E8E93)",
              lineHeight: 1.5,
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
            }}
          >
            {preview}
          </div>
        )}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 11,
            color: "var(--gooni-muted, #8E8E93)",
            marginTop: 2,
          }}
        >
          {space ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <SpaceIcon emoji={space.emoji} size={10} color={ctok.muted} />
              {space.name}
            </span>
          ) : (
            <span>General</span>
          )}
          <span>·</span>
          <span>{updated}</span>
          {thumb && (
            <>
              <span>·</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                <ImageIcon size={10} strokeWidth={1.7} />
                image
              </span>
            </>
          )}
        </div>
      </div>
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
