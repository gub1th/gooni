import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { fetchPinnedNotes, fetchDraftNotes, fetchRecentNotes, fetchSpaceNotes, patchNote, type ApiNote } from "../../services/api";
import { displayTitle } from "../../utils/notePreview";
import { usePinnedVersionStore } from "../../stores/usePinnedVersionStore";
import { useDraftVersionStore } from "../../stores/useDraftVersionStore";
import { useOrderingStore, applyOrder } from "../../stores/useOrderingStore";
import {
  PenLine, FileText,
  PanelLeftClose, ChevronDown, ChevronUp,
  Pin as PinIcon, Tag as TagIcon,
} from "lucide-react";
import { GooniLogo } from "../GooniLogo";
import { frostInk } from "../../ui";
import { ink } from "../ambient/ambientInk";

const ICON_TINT = {
  allNotes: "#6366F1",   // indigo
  pinned:   "#F59E0B",   // amber
  draft:    "#8B5CF6",   // violet — distinct from amber pinned + sky memories
  newChat:  "#10B981",   // emerald
  log:      "#0A84FF",   // accent blue — the glow surface
  tags:     "#94A3B8",   // slate-soft — tags are navigation, muted on purpose
  memories: "#0EA5E9",  // sky
  chatAudit: "#0891B2",  // cyan
  settings: "#64748B",   // slate
} as const;

// Drafts / Tags lists are capped at this many rows before an expand toggle
// appears — an uncapped drafts list can run 20+ items deep.
const CAPPED_LIST_SIZE = 5;
const EXPANDED_LIST_MAX_HEIGHT = 220;

// Sidebar = the NOTES BROWSER (pinned/drafts/recents/tags). App-level nav
// lives in IconRail (one rail, every surface) since the unification pass.
interface SidebarProps {
  isNotes: boolean;
  showCompose: boolean;
  onLogoClick: () => void;
  // All-Notes row click. Sidebar mutates the store (selectSpace "general"),
  // AppShell does the URL nav to ?view=notes.
  onAllNotes: () => void;
  // Note-row click (pinned / draft / recent). Drives the URL to ?note=<id>
  // so the index route's search.note effect picks it up.
  onSelectNote: (id: number) => void;
  onCompose: () => void;
  // Collapse the sidebar — Claude-style top-right panel-close icon.
  // AppShell owns sidebarOpen state; Sidebar just calls this.
  onClose?: () => void;
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
// pinned / drafts / recent groups read as one surface but stay scannable.
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
  label, icon, selected, onClick, trailing,
}: {
  label: string;
  icon?: React.ReactNode;
  selected?: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
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
          padding: "5px 4px 5px 38px",
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
function ExpandToggle({ expanded, hiddenCount, onClick }: { expanded: boolean; hiddenCount: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 4,
        width: "calc(100% - 24px)", margin: "1px 0 2px 38px",
        padding: "4px 6px",
        background: "transparent", border: "none", borderRadius: 5,
        cursor: "pointer", textAlign: "left",
        fontSize: 11.5, fontWeight: 500,
        color: "var(--gooni-muted, #8E8E93)",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        transition: "color 0.12s",
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--gooni-text, #1C1C1E)")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--gooni-muted, #8E8E93)")}
    >
      {expanded ? <ChevronUp size={12} strokeWidth={2} /> : <ChevronDown size={12} strokeWidth={2} />}
      {expanded ? "Show less" : `Show all (${hiddenCount} more)`}
    </button>
  );
}

export function Sidebar({ isNotes, showCompose, onLogoClick, onAllNotes, onSelectNote, onCompose, onClose }: SidebarProps) {
  const navigate = useNavigate();
  const { selectSpace, loadNotes, selectNote, activeNoteId } = useNotesContentStore();

  const [pinnedNotes, setPinnedNotes] = useState<ApiNote[]>([]);
  const [draftNotes, setDraftNotes] = useState<ApiNote[]>([]);
  const [recentNotes, setRecentNotes] = useState<ApiNote[]>([]);
  // Distinct tag set across the whole corpus — derived from the flat
  // GET /notes list (notes carry `tags: string[]`).
  const [allTags, setAllTags] = useState<string[]>([]);

  const [draftsExpanded, setDraftsExpanded] = useState(false);
  const [tagsExpanded, setTagsExpanded] = useState(false);

  const pinnedVersion = usePinnedVersionStore((s) => s.version);
  const draftVersion = useDraftVersionStore((s) => s.version);
  useEffect(() => {
    fetchPinnedNotes().then(setPinnedNotes).catch(() => {});
  }, [activeNoteId, pinnedVersion]);
  useEffect(() => {
    fetchDraftNotes().then(setDraftNotes).catch(() => {});
  }, [activeNoteId, draftVersion]);
  // Recent: refetch on any state change that could shift order — note edits
  // (activeNoteId proxies opens/edits via the store), pin toggles, draft
  // toggles. We dedupe in the render path against pinned + draft ids so
  // the same note never shows twice.
  useEffect(() => {
    fetchRecentNotes(15).then(setRecentNotes).catch(() => {});
  }, [activeNoteId, pinnedVersion, draftVersion]);
  // Tags: the whole corpus in one fetch. Cheap — list responses ship
  // excerpts, not bodies. Same refetch triggers as recents (any note edit
  // could add/remove a tag).
  useEffect(() => {
    fetchSpaceNotes("general")
      .then((notes) => {
        const seen = new Set<string>();
        for (const n of notes) for (const t of n.tags ?? []) seen.add(t);
        setAllTags([...seen].sort());
      })
      .catch(() => {});
  }, [activeNoteId, pinnedVersion, draftVersion]);

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

  // Top recent notes, excluding any already shown in the PINNED or DRAFTS
  // groups above so the same note doesn't appear twice in the sidebar.
  const recentTop = useMemo(() => {
    const skip = new Set<number>();
    pinnedNotes.forEach((n) => skip.add(n.id));
    draftNotes.forEach((n) => skip.add(n.id));
    return recentNotes.filter((n) => !skip.has(n.id)).slice(0, 5);
  }, [recentNotes, pinnedNotes, draftNotes]);

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

  // Tag click → land on the notes view with a client-side tag filter.
  // NotesList owns the filtering; the CustomEvent is the only channel
  // (a URL param for a client-only filter is overkill).
  function handleTagClick(tag: string) {
    selectSpace("general");
    loadNotes("general");
    window.dispatchEvent(new CustomEvent("gooni:filter-tag", { detail: { tag } }));
    navigate({
      to: "/",
      search: { view: "notes", note: undefined, conv: undefined, audit: undefined, segment: undefined },
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
        {/* Header — logo + compose. No bottom divider (Daniel's minimal
            redesign — sidebar reads as one continuous surface, not
            chrome+content). */}
        <div style={{
          height: 52, padding: "0 12px", display: "flex", alignItems: "center",
          justifyContent: "space-between", flexShrink: 0,
        }}>
          <button
            onClick={onLogoClick}
            title="Home"
            style={{
              background: "transparent",
              border: "none", borderRadius: 8, padding: "3px 7px", cursor: "pointer",
              fontSize: 17, fontWeight: 700,
              fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
              color: "var(--gooni-text, #1C1C1E)", transition: "background 0.1s", outline: "none",
              display: "flex", alignItems: "center", gap: 7,
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgb(var(--gooni-tint, 0 0 0) / 0.06)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
          >
            <GooniLogo size={20} />
            Gooni
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            {showCompose && (
              <button
                onClick={onCompose}
                title="New note"
                style={{ width: 28, height: 28, borderRadius: 7, background: "transparent", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--gooni-text, #3C3C43)", padding: 0, flexShrink: 0, transition: "background 0.1s", outline: "none" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgb(var(--gooni-tint, 0 0 0) / 0.06)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
              >
                <PenLine size={14} strokeWidth={1.6} />
              </button>
            )}
            {onClose && (
              <button
                onClick={onClose}
                title="Close sidebar"
                style={{ width: 28, height: 28, borderRadius: 7, background: "transparent", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--gooni-text, #3C3C43)", padding: 0, flexShrink: 0, transition: "background 0.1s", outline: "none" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgb(var(--gooni-tint, 0 0 0) / 0.06)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
              >
                <PanelLeftClose size={15} strokeWidth={1.7} />
              </button>
            )}
          </div>
        </div>

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
          {/* === Notes section ===
              Header row clickable → All Notes. "all" trailing link is
              redundant w/ header click but keeps the explicit affordance.
              The pen icon next to the logo owns note creation. */}
          <SidebarSection
            label="Notes"
            Icon={FileText}
            iconColor={ICON_TINT.allNotes}
            active={isNotes}
            onHeaderClick={handleAllNotes}
            trailingLabel="all"
            onTrailingClick={handleAllNotes}
          >
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
            {draftNotes.length > 0 && <GroupLabel label="Drafts" />}
            {draftNotes.length > 0 && (
              <div style={draftsExpanded ? { maxHeight: EXPANDED_LIST_MAX_HEIGHT, overflowY: "auto" } : undefined}>
                {(draftsExpanded ? draftNotes : draftNotes.slice(0, CAPPED_LIST_SIZE)).map((note) => (
                  <SidebarChildRow
                    key={`draft-${note.id}`}
                    label={displayTitle(note)}
                    icon={<PenLine size={11} strokeWidth={2} color={ICON_TINT.draft} />}
                    selected={activeNoteId === note.id}
                    onClick={() => handleSelectNote(note)}
                  />
                ))}
              </div>
            )}
            {draftNotes.length > CAPPED_LIST_SIZE && (
              <ExpandToggle
                expanded={draftsExpanded}
                hiddenCount={draftNotes.length - CAPPED_LIST_SIZE}
                onClick={() => setDraftsExpanded((v) => !v)}
              />
            )}
          </SidebarSection>

          {allTags.length > 0 && (
            <>
              <div style={{ height: 1, margin: "8px 14px", background: "rgb(var(--gooni-tint, 0 0 0) / 0.07)" }} />

              {/* === Tags section ===
                  Distinct labels across the whole corpus. Clicking one
                  lands on the notes view filtered client-side by that tag
                  (NotesList listens for gooni:filter-tag). */}
              <SidebarSection
                label="Tags"
                Icon={TagIcon}
                iconColor={ICON_TINT.tags}
                onHeaderClick={() => { /* label-only header */ }}
              >
                <div style={tagsExpanded ? { maxHeight: EXPANDED_LIST_MAX_HEIGHT, overflowY: "auto" } : undefined}>
                  {(tagsExpanded ? allTags : allTags.slice(0, CAPPED_LIST_SIZE)).map((tag) => (
                    <SidebarChildRow
                      key={`tag-${tag}`}
                      label={`#${tag}`}
                      onClick={() => handleTagClick(tag)}
                    />
                  ))}
                </div>
                {allTags.length > CAPPED_LIST_SIZE && (
                  <ExpandToggle
                    expanded={tagsExpanded}
                    hiddenCount={allTags.length - CAPPED_LIST_SIZE}
                    onClick={() => setTagsExpanded((v) => !v)}
                  />
                )}
              </SidebarSection>
            </>
          )}

          <div style={{ flex: 1, minHeight: 20 }} />

        </div>
      </div>

    </>
  );
}

