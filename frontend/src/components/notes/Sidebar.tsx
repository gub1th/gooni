import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { fetchPinnedNotes, fetchRecentNotes, patchNote, fetchNoteFolders, createNoteFolder, type ApiNote, type NoteFolder } from "../../services/api";
import { displayTitle } from "../../utils/notePreview";
import { usePinnedVersionStore } from "../../stores/usePinnedVersionStore";
import { useOrderingStore, applyOrder } from "../../stores/useOrderingStore";
import { FileText,
  Pin as PinIcon,
  Folder as FolderIcon,
} from "lucide-react";
import { frostInk } from "../../ui";
import { ink } from "../ambient/ambientInk";

const ICON_TINT = {
  allNotes: "#6366F1",   // indigo
  pinned:   "#F59E0B",   // amber
  newChat:  "#10B981",   // emerald
  log:      "#0A84FF",   // accent blue — the glow surface
  folders:  "#94A3B8",   // slate-soft — navigation chrome, muted on purpose
  memories: "#0EA5E9",  // sky
  chatAudit: "#0891B2",  // cyan
  settings: "#64748B",   // slate
} as const;

// Sidebar = the NOTES BROWSER ONLY (pinned/recents/folders). Always
// expanded when notes is the active view — no collapse toggle, no app-level
// nav (IconRail owns that, always visible to its left).
interface SidebarProps {
  // All-Notes row click. Sidebar mutates the store (selectSpace "general"),
  // AppShell does the URL nav to ?view=notes.
  onAllNotes: () => void;
  // Note-row click (pinned / recent). Drives the URL to ?note=<id>
  // so the index route's search.note effect picks it up.
  onSelectNote: (id: number) => void;
}

// SidebarSection — labeled group (Notes / Tags). Header row has icon +
// label + optional trailing link; children render indented underneath.
function SidebarSection({
  label, Icon, iconColor, active, onHeaderClick, trailingLabel, onTrailingClick, children,
}: {
  label: string;
  Icon: typeof FileText;
  iconColor?: string;
  active?: boolean;
  onHeaderClick: (e: React.MouseEvent) => void;
  trailingLabel?: string;           // small "all" link (Notes)
  onTrailingClick?: (e: React.MouseEvent) => void;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 2 }}>
      <div
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "7px 14px",
          background: active ? frostInk.accentDim : "transparent",
          transition: "background 0.12s",
        }}
        onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLDivElement).style.background = "rgb(var(--gooni-tint, 0 0 0) / 0.03)"; }}
        onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
      >
        <button
          onClick={onHeaderClick}
          style={{
            display: "flex", alignItems: "center", gap: 8,
            flex: 1, background: "none", border: "none", cursor: "pointer",
            padding: 0, textAlign: "left",
            color: active ? frostInk.accent : "var(--gooni-text, #1C1C1E)",
            fontSize: 13, fontWeight: active ? 600 : 500,
            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
          }}
        >
          <Icon size={15} strokeWidth={1.8} color={active ? frostInk.accent : (iconColor ?? "rgb(var(--gooni-ink, 244 245 244) / 0.55)")} style={{ flexShrink: 0 }} />
          {label}
        </button>
        {trailingLabel && (
          <button
            onClick={onTrailingClick}
            title={`Open ${label}`}
            style={{
              background: "transparent", border: "none", cursor: "pointer",
              padding: "2px 4px",
              fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
              fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
              transition: "color 0.1s",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--gooni-text, #1C1C1E)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--gooni-muted, #8E8E93)"; }}
          >
            {trailingLabel}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

// GroupLabel — tiny small-caps divider inside the Notes section so the
// pinned / recent groups read as one surface but stay scannable.
function GroupLabel({ label }: { label: string }) {
  return (
    <div style={{
      padding: "6px 14px 2px 38px",
      fontSize: 9.5, fontWeight: 600, letterSpacing: 0.8,
      textTransform: "uppercase",
      color: "rgba(142,142,147,0.75)",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      userSelect: "none",
    }}>
      {label}
    </div>
  );
}

// SidebarChildRow — indented child row under a section (a note, a tag).
// Small font, muted color, tight padding. `trailing` renders hover-only
// on the right (used for the pinned-note unpin affordance).
function SidebarChildRow({
  label, icon, selected, onClick, trailing, indent = 0,
}: {
  label: string;
  icon?: React.ReactNode;
  selected?: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
  // Nesting depth for folder rows. Adds to the existing 38px text inset
  // rather than replacing it, so a depth-0 folder lines up exactly with
  // every other child row in the sidebar.
  indent?: number;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={(e) => {
        setHovered(true);
        if (!selected) (e.currentTarget as HTMLDivElement).style.background = "rgb(var(--gooni-tint, 0 0 0) / 0.05)";
      }}
      onMouseLeave={(e) => {
        setHovered(false);
        if (!selected) (e.currentTarget as HTMLDivElement).style.background = "transparent";
      }}
      style={{
        display: "flex", alignItems: "center",
        background: selected ? "rgb(var(--gooni-tint, 0 0 0) / 0.05)" : "transparent",
        transition: "background 0.12s",
      }}
    >
      <button
        onClick={onClick}
        title={label}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          flex: 1, minWidth: 0,
          padding: `5px 4px 5px ${38 + indent * 12}px`,
          background: "transparent",
          border: "none", borderRadius: 0,
          cursor: "pointer", textAlign: "left",
          fontSize: 13,
          fontWeight: selected ? 600 : 400,
          color: hovered || selected ? "var(--gooni-text, #1C1C1E)" : "var(--gooni-muted, #6B7280)",
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
          transition: "color 0.12s",
        }}
      >
        {icon && (
          <span style={{ display: "inline-flex", flexShrink: 0, color: "rgba(142,142,147,0.7)" }}>
            {icon}
          </span>
        )}
        <span style={{
          flex: 1, minWidth: 0,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {label}
        </span>
      </button>
      {trailing && (
        <span style={{ opacity: hovered ? 1 : 0, transition: "opacity 0.1s", flexShrink: 0, paddingRight: 8 }}>
          {trailing}
        </span>
      )}
    </div>
  );
}

// ExpandToggle — "Show all N" / "Show less" row under a capped list.
export function Sidebar({ onAllNotes, onSelectNote }: SidebarProps) {
  const navigate = useNavigate();
  const { selectSpace, loadNotes, selectNote, activeNoteId } = useNotesContentStore();

  const [pinnedNotes, setPinnedNotes] = useState<ApiNote[]>([]);
  const [recentNotes, setRecentNotes] = useState<ApiNote[]>([]);
  // Distinct tag set across the whole corpus — derived from the flat
  // GET /notes list (notes carry `tags: string[]`).
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [unfiledCount, setUnfiledCount] = useState(0);
  const [expandedFolders, setExpandedFolders] = useState<Set<number>>(new Set());
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const [folderVersion, setFolderVersion] = useState(0);


  const pinnedVersion = usePinnedVersionStore((s) => s.version);
  useEffect(() => {
    fetchPinnedNotes().then(setPinnedNotes).catch(() => {});
  }, [activeNoteId, pinnedVersion]);
  useEffect(() => {
  }, [activeNoteId]);
  // Recent: refetch on any state change that could shift order — note edits
  // (activeNoteId proxies opens/edits via the store) and pin toggles. We
  // dedupe in the render path against pinned ids so
  // the same note never shows twice.
  useEffect(() => {
    fetchRecentNotes(15).then(setRecentNotes).catch(() => {});
  }, [activeNoteId, pinnedVersion]);
  // Folders. One flat read; the tree is nested here from `parent_id` so the
  // server never serializes a recursive shape. Same refetch triggers as
  // recents — filing a note changes a count.
  //
  // This replaced the TAGS section. Tags still exist and still organize
  // things, they are just no longer a thing Daniel maintains by hand: a note
  // lives in exactly one folder (a real FK), and tags became machine
  // metadata the extractor writes.
  useEffect(() => {
    fetchNoteFolders()
      .then((r: { folders: NoteFolder[]; unfiled_count: number }) => { setFolders(r.folders); setUnfiledCount(r.unfiled_count); })
      .catch(() => {});
  }, [activeNoteId, pinnedVersion, folderVersion]);

  // Pinned ordering — the drag UI died with the redesign, but the saved
  // per-device order still applies so previously-arranged pins keep their
  // spots. New pins append in backend order.
  const pinnedOrder = useOrderingStore((s) => s.pinnedOrder);
  const orderedPinnedNotes = useMemo(
    () => applyOrder(pinnedNotes, pinnedOrder),
    [pinnedNotes, pinnedOrder],
  );

  // Sidebar scroll-position persistence across route changes. The Sidebar
  // is re-mounted on /, /memories, /chat-audit; without a sessionStorage
  // round-trip the scrollTop resets to 0 every time the user clicks a
  // top-level destination.
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollRestoredRef = useRef(false);

  async function handleUnpin(noteId: number) {
    setPinnedNotes((prev) => prev.filter((n) => n.id !== noteId)); // optimistic
    await patchNote(noteId, { is_pinned: false });
    usePinnedVersionStore.getState().bump();
  }

  // Top recent notes, excluding any already shown in the PINNED
  // groups above so the same note doesn't appear twice in the sidebar.
  const recentTop = useMemo(() => {
    const skip = new Set<number>();
    pinnedNotes.forEach((n) => skip.add(n.id));
    return recentNotes.filter((n) => !skip.has(n.id)).slice(0, 5);
  }, [recentNotes, pinnedNotes]);

  function handleAllNotes() {
    selectSpace("general");
    loadNotes("general");
    onAllNotes();
  }

  function handleSelectNote(note: ApiNote) {
    selectSpace("general");
    selectNote(note.id);
    loadNotes("general");
    onSelectNote(note.id);
  }

  // Folder click → land on the notes view narrowed to that folder. `null`
  // means Unfiled, which is a real place, not "no filter" — so it goes
  // through the same channel rather than clearing the filter.
  //
  // Same CustomEvent channel the tag filter used: NotesList owns the
  // filtering, and a URL param for a client-only narrowing is overkill.
  function handleFolderClick(folderId: number | null) {
    selectSpace("general");
    loadNotes("general");
    window.dispatchEvent(new CustomEvent("gooni:filter-folder", { detail: { folderId } }));
    navigate({
      to: "/",
      search: { view: "notes", note: undefined, conv: undefined, audit: undefined, segment: undefined },
    });
  }

  function bumpFolders() {
    setFolderVersion((v) => v + 1);
  }

  // Nest the flat list at render time. Recursive, but the depth is a human
  // filing hierarchy (single digits) and the guard against a pathological
  // one is server-side: reparent refuses cycles, so this cannot loop.
  function renderFolderTree(parentId: number | null, depth: number) {
    const children = folders.filter((f) => f.parent_id === parentId);
    if (children.length === 0) return null;
    return children.map((f) => {
      const kids = folders.some((c) => c.parent_id === f.id);
      const open = expandedFolders.has(f.id);
      return (
        <div key={`folder-${f.id}`}>
          <SidebarChildRow
            label={`${kids ? (open ? "▾ " : "▸ ") : ""}${f.name}${f.note_count ? ` (${f.note_count})` : ""}`}
            selected={false}
            indent={depth}
            onClick={() => {
              // A folder with children toggles AND filters — one click does
              // both, because a disclosure arrow that isn't also the row is
              // a second tiny hit target for no benefit.
              if (kids) {
                setExpandedFolders((prev) => {
                  const next = new Set(prev);
                  if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
                  return next;
                });
              }
              handleFolderClick(f.id);
            }}
          />
          {open && renderFolderTree(f.id, depth + 1)}
        </div>
      );
    });
  }

  return (
    <>
      <div
        style={{
          width: 240, minWidth: 240, height: "100%",
          // TRANSPARENT, not `palette.sidebar`. That palette is the app-card
          // world — near-white on light, #181818 on dark — and against the void
          // the panel paints it read as a lit slab pasted into the surface,
          // which is the "brightest thing on screen / looks unaffected by
          // anything around it" complaint exactly. The hairline is the only
          // thing that has to say where the column ends.
          background: "transparent", display: "flex", flexDirection: "column",
          borderRight: `1px solid ${ink(0.08)}`, boxSizing: "border-box",
          position: "relative",
          // `100%`, not `100vh`: the panel starts below the session band, so a
          // viewport-height column overflowed it by the band's height and
          // pushed the footer off the bottom whenever a session was running.
        }}
      >
        {/* Scrollable content — thin overlay scrollbar that fades in only
            when the user is scrolling. Static chunky scrollbar Daniel
            flagged was a leftover platform default. */}
        <style>{`
          .gooni-sidebar-scroll { scrollbar-width: thin; scrollbar-color: rgb(var(--gooni-tint, 0 0 0) / 0) transparent; transition: scrollbar-color 0.2s; }
          .gooni-sidebar-scroll:hover { scrollbar-color: rgb(var(--gooni-tint, 0 0 0) / 0.18) transparent; }
          .gooni-sidebar-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
          .gooni-sidebar-scroll::-webkit-scrollbar-track { background: transparent; }
          .gooni-sidebar-scroll::-webkit-scrollbar-thumb { background: transparent; border-radius: 3px; transition: background 0.2s; }
          .gooni-sidebar-scroll:hover::-webkit-scrollbar-thumb { background: rgb(var(--gooni-tint, 0 0 0) / 0.22); }
          .gooni-sidebar-scroll::-webkit-scrollbar-thumb:hover { background: rgb(var(--gooni-tint, 0 0 0) / 0.36); }
        `}</style>
        <div
          ref={(el) => {
            sidebarScrollRef.current = el;
            // Restore on mount — see the ref comment above.
            if (el && !scrollRestoredRef.current) {
              try {
                const saved = window.sessionStorage.getItem("gooni-sidebar-scroll");
                if (saved) el.scrollTop = parseInt(saved, 10) || 0;
              } catch {}
              scrollRestoredRef.current = true;
            }
          }}
          onScroll={(e) => {
            try {
              window.sessionStorage.setItem(
                "gooni-sidebar-scroll",
                String((e.currentTarget as HTMLDivElement).scrollTop),
              );
            } catch {}
          }}
          className="gooni-sidebar-scroll"
          style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", padding: "4px 0" }}
        >
          {/* All Notes — a plain link row, not a section header. The sidebar is
              always-expanded and notes-only now (no collapse toggle, no
              app-level nav to distinguish itself from), so the green "Notes"
              banner this used to be was announcing something nobody needed
              announced — the GroupLabel rows below (PINNED/RECENT)
              already give the list its structure. */}
          <button
            onClick={handleAllNotes}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              width: "100%", background: "none", border: "none", cursor: "pointer",
              padding: "7px 14px", textAlign: "left",
              color: "rgb(var(--gooni-ink, 244 245 244) / 0.55)",
              fontSize: 12.5, fontWeight: 500,
              fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
              transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--gooni-text, #1C1C1E)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "rgb(var(--gooni-ink, 244 245 244) / 0.55)"; }}
          >
            <FileText size={14} strokeWidth={1.8} color={ICON_TINT.allNotes} style={{ flexShrink: 0 }} />
            All notes
          </button>
          <div>
            {orderedPinnedNotes.length > 0 && <GroupLabel label="Pinned" />}
            {orderedPinnedNotes.map((note) => (
              <SidebarChildRow
                key={`pinned-${note.id}`}
                label={displayTitle(note)}
                icon={<PinIcon size={11} strokeWidth={2} color={ICON_TINT.pinned} />}
                selected={activeNoteId === note.id}
                onClick={() => handleSelectNote(note)}
                trailing={
                  <button
                    onClick={(e) => { e.stopPropagation(); void handleUnpin(note.id); }}
                    title="Unpin"
                    style={{
                      background: "transparent", border: "none", cursor: "pointer",
                      padding: 2, lineHeight: 0, borderRadius: 4,
                      color: "var(--gooni-muted, #8E8E93)",
                      display: "inline-flex",
                    }}
                  >
                    ×
                  </button>
                }
              />
            ))}
            {recentTop.length > 0 && <GroupLabel label="Recent" />}
            {recentTop.map((note) => (
              <SidebarChildRow
                key={`recent-${note.id}`}
                label={displayTitle(note)}
                selected={activeNoteId === note.id}
                onClick={() => handleSelectNote(note)}
              />
            ))}
          </div>

          <div style={{ height: 1, margin: "8px 14px", background: "rgb(var(--gooni-tint, 0 0 0) / 0.07)" }} />

          {/* === Folders ===
              Topic rows. A note is in exactly ONE (topic_id is an FK), which
              is what tags could never express — a note has many tags, so
              "which folder is this in" had no answer and no tree could be
              drawn. Nesting is free via Topic.parent_id.

              Folders do NOT show salience. A Topic carries a decay curve so
              the focus dashboard can shrink subjects you've stopped thinking
              about; a folder that fades is a folder you lose things in. The
              curve is untouched — this surface just never reads it. */}
          <SidebarSection
            label="Folders"
            Icon={FolderIcon}
            iconColor={ICON_TINT.folders}
            onHeaderClick={() => setNewFolderName(newFolderName === null ? "" : null)}
          >
            {renderFolderTree(null, 0)}

            {/* Unfiled is a real row, always shown even at zero. Notes that
                were never filed must not be reachable only by scrolling the
                whole list — that is how a folder tree loses things. */}
            <SidebarChildRow
              label={`Unfiled${unfiledCount ? ` (${unfiledCount})` : ""}`}
              selected={false}
              onClick={() => handleFolderClick(null)}
            />

            {newFolderName !== null && (
              <input
                autoFocus
                value={newFolderName}
                placeholder="folder name…"
                onChange={(e) => setNewFolderName(e.target.value)}
                onBlur={() => setNewFolderName(null)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setNewFolderName(null); return; }
                  if (e.key !== "Enter") return;
                  const name = newFolderName.trim();
                  setNewFolderName(null);
                  if (!name) return;
                  createNoteFolder(name)
                    .then(() => bumpFolders())
                    .catch(() => {});
                }}
                style={{
                  width: "calc(100% - 28px)", margin: "2px 14px",
                  background: "transparent", border: "none", outline: "none",
                  color: "var(--gooni-text, #0F172A)", fontSize: 12.5,
                }}
              />
            )}
          </SidebarSection>

          <div style={{ flex: 1, minHeight: 20 }} />

        </div>
      </div>

    </>
  );
}

