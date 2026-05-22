import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useSpacesStore } from "../../stores/useSpacesStore";
import { useListsStore } from "../../stores/useListsStore";
import { fetchPinnedNotes, fetchDraftNotes, fetchUnprocessedNotes, fetchRecentNotes, patchNote, type ApiNote } from "../../services/api";
import { displayTitle, stripHtmlForExcerpt } from "../../utils/notePreview";
import { usePinnedVersionStore } from "../../stores/usePinnedVersionStore";
import { useDraftVersionStore } from "../../stores/useDraftVersionStore";
import { useGooniThemeStore, THEME_PALETTES } from "../../stores/useGooniThemeStore";
import { useOrderingStore, applyOrder } from "../../stores/useOrderingStore";
import {
  PenLine, FileText, Brain, ClipboardList, Settings as SettingsIcon,
  Globe, Plug, PanelLeftClose, Plus,
  Home, Folder as FolderIcon, List as ListIcon, MessageSquare, Pin as PinIcon,
} from "lucide-react";
import { GooniLogo } from "../GooniLogo";
import { SettingsModal } from "../SettingsModal";
import { SpaceIcon, SPACE_ICON_OPTIONS, lucideIconValue } from "./SpaceIcon";

const ICON_TINT = {
  allNotes: "#6366F1",   // indigo
  pinned:   "#F59E0B",   // amber
  draft:    "#8B5CF6",   // violet — distinct from amber pinned + sky memories
  recent:   "#94A3B8",   // slate-soft — recent is read-only, muted on purpose
  newChat:  "#10B981",   // emerald
  gooni:    "#A855F7",   // violet
  memories: "#0EA5E9",  // sky
  chatAudit: "#0891B2",  // cyan
  settings: "#64748B",   // slate
  // Match the per-list-type tints used by ListIcon so the top shortcuts read
  // as the same surface as the Todo/Backlog rows under LISTS.
  todos:    "#15803D",   // green-700
  backlog:  "#4338CA",   // indigo-700
} as const;

const sidebarFooterBtn: React.CSSProperties = {
  flex: 1,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 5,
  height: 28,
  padding: "0 8px",
  borderRadius: 6,
  border: "none",
  background: "transparent",
  color: "#3C3C43",
  fontSize: 11,
  fontWeight: 500,
  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  cursor: "pointer",
  transition: "background 0.12s",
  outline: "none",
};

interface SpacePopoverProps {
  anchor: { top: number; left: number };
  name: string;
  emoji: string;
  onNameChange: (v: string) => void;
  onEmojiChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

function SpacePopover({ anchor, name, emoji, onNameChange, onEmojiChange, onSave, onCancel }: SpacePopoverProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 99 }} onClick={onCancel} />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed", top: anchor.top, left: anchor.left,
          zIndex: 100, background: "var(--gooni-card, #fff)", borderRadius: 10,
          boxShadow: "0 4px 24px rgba(0,0,0,0.18), 0 1px 4px rgba(0,0,0,0.08)",
          padding: "12px 12px 10px", width: 228,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: pickerOpen ? 8 : 10 }}>
          <button
            onClick={() => setPickerOpen((o) => !o)}
            title="Pick icon"
            style={{
              width: 32, height: 32, borderRadius: 6,
              border: `1px solid ${pickerOpen ? "rgba(0,0,0,0.18)" : "rgba(0,0,0,0.1)"}`,
              background: "#F2F2F7", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0, outline: "none", transition: "border-color 0.1s",
            }}
          >
            <SpaceIcon emoji={emoji || null} size={16} color="#475569" />
          </button>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); onSave(); }
              if (e.key === "Escape") onCancel();
            }}
            placeholder="Space name"
            style={{
              flex: 1, fontSize: 13.5, outline: "none", border: "none",
              fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
              fontWeight: 500, color: "var(--gooni-text, #1C1C1E)", background: "transparent",
            }}
          />
        </div>

        {pickerOpen && (
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(6, 1fr)",
            gap: 2, marginBottom: 10,
            padding: "8px 0 2px",
            borderTop: "1px solid rgba(0,0,0,0.07)",
          }}>
            {SPACE_ICON_OPTIONS.map(({ name, Icon }) => {
              const value = lucideIconValue(name);
              const selected = emoji === value;
              return (
                <button
                  key={name}
                  onClick={() => { onEmojiChange(value); setPickerOpen(false); }}
                  title={name}
                  style={{
                    background: selected ? "rgba(15,23,42,0.08)" : "transparent",
                    border: "none", borderRadius: 6, cursor: "pointer",
                    height: 28, padding: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: selected ? "#0F172A" : "#475569",
                    transition: "background 0.1s, color 0.1s",
                  }}
                  onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "rgba(15,23,42,0.04)"; }}
                  onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                >
                  <Icon size={15} strokeWidth={1.8} />
                </button>
              );
            })}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <button
            onClick={onCancel}
            style={{
              fontSize: 12, background: "none", border: "none",
              cursor: "pointer", color: "var(--gooni-muted, #8E8E93)",
              padding: "4px 8px", borderRadius: 6,
            }}
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            style={{
              fontSize: 12, background: "#1C1C1E", color: "#fff",
              border: "none", borderRadius: 6, cursor: "pointer",
              padding: "4px 12px", fontWeight: 500,
            }}
          >
            Save
          </button>
        </div>
      </div>
    </>
  );
}

type PopoverMode = { mode: "edit"; id: number } | { mode: "create" } | null;

interface SidebarProps {
  isDashboard: boolean;
  isNotes: boolean;
  isChat: boolean;
  isLists: boolean;
  isEval?: boolean;
  // In-flight props from another agent's hoist work — declared here as
  // optional passthrough so the type-check passes while that branch is
  // mid-merge. Sidebar doesn't read them today; safe to ignore.
  isStats?: boolean;
  onOpenStats?: () => void;
  activeListId: number | null;
  showCompose: boolean;
  onLogoClick: () => void;
  onSpaceSelect: () => void;
  // All-Notes row click. Sidebar mutates the store (selectSpace "general"),
  // AppShell does the URL nav to ?view=notes.
  onAllNotes: () => void;
  // Note-row click (pinned / draft / unprocessed / recent). Drives the URL
  // to ?note=<id> so NotesPage's search.note effect picks it up.
  onSelectNote: (id: number) => void;
  onCompose: () => void;
  onNewChat: () => void;
  onSelectList: (id: number) => void;
  onOpenEval?: () => void;
  // Collapse the sidebar — Claude-style top-right panel-close icon.
  // AppShell owns sidebarOpen state; Sidebar just calls this.
  onClose?: () => void;
}

// SidebarSection — labeled group (Notes / Spaces / Lists). Header row
// has icon + label + + button; children render indented underneath.
function SidebarSection({
  label, Icon, iconColor, active, onHeaderClick, onPlusClick, showPlus = true, trailingLabel, onTrailingClick, children,
}: {
  label: string;
  Icon: typeof FileText;
  iconColor?: string;
  active?: boolean;
  onHeaderClick: (e: React.MouseEvent) => void;
  onPlusClick: (e: React.MouseEvent) => void;
  showPlus?: boolean;
  trailingLabel?: string;           // small "all" link in lieu of a + button (Notes)
  onTrailingClick?: (e: React.MouseEvent) => void;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 2 }}>
      <div
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "7px 14px",
          background: active ? "rgba(10,132,255,0.08)" : "transparent",
          transition: "background 0.12s",
        }}
        onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.03)"; }}
        onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
      >
        <button
          onClick={onHeaderClick}
          style={{
            display: "flex", alignItems: "center", gap: 8,
            flex: 1, background: "none", border: "none", cursor: "pointer",
            padding: 0, textAlign: "left",
            color: active ? "#0A66D6" : "var(--gooni-text, #1C1C1E)",
            fontSize: 13, fontWeight: active ? 600 : 500,
            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
          }}
        >
          <Icon size={15} strokeWidth={1.8} color={active ? "#0A66D6" : (iconColor ?? "#475569")} style={{ flexShrink: 0 }} />
          {label}
        </button>
        {trailingLabel ? (
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
        ) : showPlus ? (
          <button
            onClick={onPlusClick}
            title={`New ${label.toLowerCase().replace(/s$/, "")}`}
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 22, height: 22, borderRadius: 4,
              border: "none", background: "transparent",
              color: "var(--gooni-muted, #9CA3AF)",
              cursor: "pointer", transition: "background 0.1s, color 0.1s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "rgba(15,23,42,0.06)";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--gooni-text, #1C1C1E)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--gooni-muted, #9CA3AF)";
            }}
          >
            <Plus size={14} strokeWidth={2} />
          </button>
        ) : null}
      </div>
      {children}
    </div>
  );
}

// SidebarChildRow — indented child row under a section (a note, a space,
// a list, etc). Small font, muted color, tight padding.
function SidebarChildRow({
  label, prefix, icon, selected, onClick,
}: {
  label: string;
  prefix?: string;
  icon?: React.ReactNode;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        width: "100%",
        padding: "5px 14px 5px 38px",
        background: selected ? "rgba(0,0,0,0.05)" : "transparent",
        border: "none", borderRadius: 0,
        cursor: "pointer", textAlign: "left",
        fontSize: 13,
        fontWeight: selected ? 600 : 400,
        color: selected ? "var(--gooni-text, #1C1C1E)" : "var(--gooni-muted, #6B7280)",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        transition: "background 0.12s, color 0.12s",
      }}
      onMouseEnter={(e) => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "rgba(15,23,42,0.05)";
        (e.currentTarget as HTMLButtonElement).style.color = "var(--gooni-text, #1C1C1E)";
      }}
      onMouseLeave={(e) => {
        if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
        (e.currentTarget as HTMLButtonElement).style.color = selected
          ? "var(--gooni-text, #1C1C1E)" : "var(--gooni-muted, #6B7280)";
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
        {prefix ?? ""}{label}
      </span>
    </button>
  );
}

export function Sidebar({ isDashboard, isNotes, isChat, isLists, isEval, activeListId, showCompose, onLogoClick, onSpaceSelect: _unusedOnSpaceSelect, onAllNotes, onSelectNote, onCompose, onNewChat, onSelectList, onOpenEval, onClose }: SidebarProps) {
  void _unusedOnSpaceSelect;
  // Dead helpers retained for now (referenced via `void` so tsc accepts
  // them) — they wired the dropped DRAFTS/UNPROCESSED/SPACES sections.
  // Sweep in a follow-up if the redesign sticks.
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  const _silenceUnused = () => {
    void _dropSpace; void dropPinned; void handleUnpin;
    void pulseId; void typing;
    void _handleUndraft; void _handleArchiveUnprocessed;
    void _startInlineEdit; void _commitInlineEdit; void _cancelInlineEdit;
    void _confirmDelete;
  };
  void _silenceUnused;
  const navigate = useNavigate();
  const { selectedSpaceId, selectSpace, loadNotes, selectNote, activeNoteId, removeSpace } = useNotesContentStore();
  const { spaces, createSpace, updateSpace, deleteSpace } = useSpacesStore();
  const lists = useListsStore((s) => s.lists);
  const createListInStore = useListsStore((s) => s.createList);
  const [_listsOpen, _setListsOpen] = useState(true);
  // Inline new-list composer state. When non-null, an input row replaces
  // the placeholder so the user can name + Enter without a browser prompt.
  const [newListDraft, setNewListDraft] = useState<string | null>(null);
  const newListInputRef = useRef<HTMLInputElement>(null);

  function handleAddList() {
    setNewListDraft("");
    // Focus once the input is mounted on the next paint.
    requestAnimationFrame(() => newListInputRef.current?.focus());
  }

  async function commitNewList() {
    const name = (newListDraft ?? "").trim();
    setNewListDraft(null);
    if (!name) return;
    try {
      const lst = await createListInStore(name, "generic", null);
      onSelectList(lst.id);
    } catch (e) {
      console.error("createList failed", e);
      alert("Failed to create list.");
    }
  }

  const [pinnedNotes, setPinnedNotes] = useState<ApiNote[]>([]);
  const [draftNotes, setDraftNotes] = useState<ApiNote[]>([]);
  const [_unprocessedNotes, setUnprocessedNotes] = useState<ApiNote[]>([]);
  const [recentNotes, setRecentNotes] = useState<ApiNote[]>([]);
  const [_spacesOpen, _setSpacesOpen] = useState(true);
  const [_pinnedOpen, _setPinnedOpen] = useState(true);
  const [_draftsOpen, _setDraftsOpen] = useState(true);
  const [_unprocessedOpen, _setUnprocessedOpen] = useState(true);
  const [_recentOpen, _setRecentOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const theme = useGooniThemeStore((s) => s.theme);
  const palette = THEME_PALETTES[theme];

  const [popover, setPopover] = useState<PopoverMode>(null);
  const [popoverAnchor, setPopoverAnchor] = useState({ top: 0, left: 208 });
  const [popoverName, setPopoverName] = useState("");
  const [popoverEmoji, setPopoverEmoji] = useState("");
  // Inline edit state for spaces — Daniel wanted Apple-Notes-style rename/
  // emoji edit directly in the row, no modal. The popover above stays for
  // CREATE only (create-from-row would feel out of place); edits route here.
  const [inlineEditId, setInlineEditId] = useState<number | null>(null);
  const [inlineEditName, setInlineEditName] = useState("");
  const [inlineEditEmoji, setInlineEditEmoji] = useState<string>("");
  const [_inlinePaletteOpen, setInlinePaletteOpen] = useState(false);
  const inlineNameRef = useRef<HTMLInputElement>(null);
  const [_deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const pinnedVersion = usePinnedVersionStore((s) => s.version);
  const draftVersion = useDraftVersionStore((s) => s.version);
  useEffect(() => {
    fetchPinnedNotes().then(setPinnedNotes).catch(() => {});
  }, [activeNoteId, pinnedVersion]);
  useEffect(() => {
    fetchDraftNotes().then(setDraftNotes).catch(() => {});
  }, [activeNoteId, draftVersion]);
  // Unprocessed notes — Daniel's triage queue. Captured intent that hasn't
  // graduated into a Promise / Todo / Habit / Focus yet. Refetches on the
  // same triggers as recents (any note edit could flip status).
  useEffect(() => {
    fetchUnprocessedNotes().then(setUnprocessedNotes).catch(() => {});
  }, [activeNoteId, draftVersion, pinnedVersion]);
  // Recent: refetch on any state change that could shift order — note edits
  // (activeNoteId proxies opens/edits via the store), pin toggles (pinned
  // titles can change via inline rename), and draft toggles. We dedupe in
  // the render path against pinned + draft ids, so the union shown above
  // never collides with this section.
  async function refreshRecents() {
    try {
      const r = await fetchRecentNotes(15);
      setRecentNotes(r);
      return r;
    } catch {
      return [] as ApiNote[];
    }
  }
  useEffect(() => {
    // Ask for extra rows so dedup against pinned/drafts still leaves 5
    // visible even when the top of the list is occupied by pinned items.
    void refreshRecents();
  }, [activeNoteId, pinnedVersion, draftVersion]);

  // ── Drag-to-reorder (localStorage-backed) ─────────────────────────────
  const spaceOrder = useOrderingStore((s) => s.spaceOrder);
  const pinnedOrder = useOrderingStore((s) => s.pinnedOrder);
  const setSpaceOrder = useOrderingStore((s) => s.setSpaceOrder);
  const setPinnedOrder = useOrderingStore((s) => s.setPinnedOrder);

  // drag state: { kind: "space"|"pinned", fromId: number, overId: number | null }
  const [drag, setDrag] = useState<{ kind: "space" | "pinned"; fromId: number; overId: number | null } | null>(null);

  // Sidebar scroll-position persistence across route changes. The
  // Sidebar component is re-mounted on /, /memories, /chat-audit, so
  // without a sessionStorage round-trip the scrollTop resets to 0 every
  // time the user clicks a top-level destination — Daniel called this
  // "the sidebar autoscrolls after I click."
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollRestoredRef = useRef(false);

  const orderedSpaces = useMemo(() => {
    const nonGeneral = spaces.filter((s) => s.id !== "general") as {
      id: number;
      name: string;
      emoji: string | null;
      is_pinned: boolean;
    }[];
    const userOrdered = applyOrder(nonGeneral, spaceOrder);
    // Pinned spaces always float above unpinned ones; within each group
    // the user's manual drag-order is preserved (so pinning doesn't blow
    // away custom ordering they've built up).
    return [
      ...userOrdered.filter((s) => s.is_pinned),
      ...userOrdered.filter((s) => !s.is_pinned),
    ];
  }, [spaces, spaceOrder]);

  const orderedPinnedNotes = useMemo(
    () => applyOrder(pinnedNotes, pinnedOrder),
    [pinnedNotes, pinnedOrder],
  );

  function moveId(list: number[], fromId: number, toId: number): number[] {
    // If the current list doesn't contain every id we need, seed it from the
    // currently-rendered order so the reorder operation has a stable basis.
    const fromIdx = list.indexOf(fromId);
    const toIdx = list.indexOf(toId);
    if (fromIdx === -1 || toIdx === -1) return list;
    const next = list.slice();
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, fromId);
    return next;
  }

  function _dropSpace(overId: number) {
    if (!drag || drag.kind !== "space") return;
    const ids = orderedSpaces.map((s) => s.id as number);
    // seed the stored order with the full current list so every id is present
    const seeded = ids;
    setSpaceOrder(moveId(seeded, drag.fromId, overId));
    setDrag(null);
  }

  function dropPinned(overId: number) {
    if (!drag || drag.kind !== "pinned") return;
    const ids = orderedPinnedNotes.map((n) => n.id);
    setPinnedOrder(moveId(ids, drag.fromId, overId));
    setDrag(null);
  }

  async function handleUnpin(noteId: number) {
    setPinnedNotes((prev) => prev.filter((n) => n.id !== noteId)); // optimistic
    await patchNote(noteId, { is_pinned: false });
    usePinnedVersionStore.getState().bump();
  }

  async function _handleUndraft(noteId: number) {
    setDraftNotes((prev) => prev.filter((n) => n.id !== noteId)); // optimistic
    await patchNote(noteId, { is_draft: false });
    useDraftVersionStore.getState().bump();
  }

  async function _handleArchiveUnprocessed(noteId: number) {
    // Optimistic remove from the unprocessed list; the row stays in the DB
    // but flips status='archived' so the synthesizer and this sidebar
    // section stop surfacing it. Daniel can still find it via search +
    // its parent space.
    setUnprocessedNotes((prev) => prev.filter((n) => n.id !== noteId));
    await patchNote(noteId, { status: "archived" });
  }

  // Top 5 most-recently-edited notes, excluding any already shown in the
  // PINNED or DRAFTS sections above so the same note doesn't appear twice
  // in the sidebar.
  const recentTop = useMemo(() => {
    const skip = new Set<number>();
    pinnedNotes.forEach((n) => skip.add(n.id));
    draftNotes.forEach((n) => skip.add(n.id));
    return recentNotes.filter((n) => !skip.has(n.id)).slice(0, 4);
  }, [recentNotes, pinnedNotes, draftNotes]);

  // ── Submit-ink + typing animation (migrated from Dashboard) ───────────────
  // When the dashboard composer fires a note save, it dispatches
  // `gooni:note-submitted` with the submit-button rect. We refetch recents,
  // then animate an ink dot from the button → the first recent row, and
  // typewriter-reveal that row's title + excerpt.
  type InkPhase = "init" | "travel" | "absorb";
  type InkState = {
    id: number;
    fromX: number; fromY: number;
    toX: number; toY: number;
    angle: number;
    phase: InkPhase;
  };
  const [ink, setInk] = useState<InkState | null>(null);
  const [pulseId, setPulseId] = useState<number | null>(null);
  const [typing, setTyping] = useState<{ noteId: number; revealed: number; total: number } | null>(null);
  const typingRaf = useRef<number | null>(null);
  const recentRowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  function startTyping(noteId: number, total: number) {
    if (typingRaf.current != null) cancelAnimationFrame(typingRaf.current);
    if (total <= 0) return;
    setTyping({ noteId, revealed: 0, total });
    const duration = Math.min(1400, 350 + total * 6);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const revealed = Math.floor(eased * total);
      setTyping((s) => (s && s.noteId === noteId ? { ...s, revealed } : s));
      if (t < 1) {
        typingRaf.current = requestAnimationFrame(tick);
      } else {
        typingRaf.current = null;
        setTyping(null);
      }
    };
    typingRaf.current = requestAnimationFrame(tick);
  }

  useEffect(() => () => {
    if (typingRaf.current != null) cancelAnimationFrame(typingRaf.current);
  }, []);

  useEffect(() => {
    function onSubmitted(e: Event) {
      const detail = (e as CustomEvent<{ buttonRect: DOMRect | null }>).detail;
      const buttonRect = detail?.buttonRect ?? null;
      const inkId = Date.now();

      // Refetch first so the new note shows up at index 0; then orchestrate
      // the ink → pulse → typing sequence against that row's rect.
      refreshRecents().then((fresh) => {
        // Recompute the visible top after dedup. The just-saved note is
        // unlikely to be pinned/draft, so it should land at index 0.
        const skip = new Set<number>();
        pinnedNotes.forEach((n) => skip.add(n.id));
        draftNotes.forEach((n) => skip.add(n.id));
        const visible = fresh.filter((n) => !skip.has(n.id)).slice(0, 5);
        const first = visible[0];
        if (!first || !buttonRect) return;

        // The row may not have its ref attached yet on the same frame as the
        // state update — defer one rAF so React commits the new row, then
        // measure.
        requestAnimationFrame(() => {
          const rowEl = recentRowRefs.current.get(first.id);
          if (!rowEl) return;
          const target = rowEl.getBoundingClientRect();
          const fromX = buttonRect.left + buttonRect.width / 2;
          const fromY = buttonRect.top + buttonRect.height / 2;
          const toX = target.left + target.width / 2;
          const toY = target.top + target.height / 2;
          const angle = (Math.atan2(toY - fromY, toX - fromX) * 180) / Math.PI;
          setInk({ id: inkId, fromX, fromY, toX, toY, angle, phase: "init" });
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              setInk((s) => (s && s.id === inkId ? { ...s, phase: "travel" } : s));
            });
          });
          setTimeout(() => {
            setInk((s) => (s && s.id === inkId ? { ...s, phase: "absorb" } : s));
            setPulseId(first.id);
            const t = displayTitle(first);
            const ex = stripHtmlForExcerpt(first.content ?? "");
            startTyping(first.id, t.length + ex.length);
          }, 640);
          setTimeout(() => {
            setInk((s) => (s && s.id === inkId ? null : s));
            setPulseId((p) => (p === first.id ? null : p));
          }, 1280);
        });
      });
    }
    window.addEventListener("gooni:note-submitted", onSubmitted as EventListener);
    return () => window.removeEventListener("gooni:note-submitted", onSubmitted as EventListener);
  }, [pinnedNotes, draftNotes]);

  function handleAllNotes() {
    selectSpace("general");
    loadNotes("general");
    onAllNotes();
  }

  function handleSelectNote(note: ApiNote) {
    const spaceId = note.space_id == null ? "general" : String(note.space_id);
    selectSpace(spaceId);
    selectNote(note.id);
    loadNotes(spaceId);
    onSelectNote(note.id);
  }

  function _startInlineEdit(e: React.MouseEvent, id: number, name: string, emoji: string | null) {
    e.stopPropagation();
    setInlineEditId(id);
    setInlineEditName(name);
    setInlineEditEmoji(emoji ?? "");
    setInlinePaletteOpen(false);
    setDeleteConfirmId(null);
    // Focus the input after state commits + the input has been rendered.
    requestAnimationFrame(() => inlineNameRef.current?.focus());
  }

  async function _commitInlineEdit() {
    if (inlineEditId == null) return;
    const trimmed = inlineEditName.trim() || "Untitled";
    await updateSpace(inlineEditId, { name: trimmed, emoji: inlineEditEmoji || null });
    setInlineEditId(null);
    setInlinePaletteOpen(false);
  }

  function _cancelInlineEdit() {
    setInlineEditId(null);
    setInlinePaletteOpen(false);
  }

  function openCreatePopover(e: React.MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPopoverAnchor({ top: Math.max(rect.top - 8, 8), left: 208 });
    setPopoverName("");
    setPopoverEmoji("");
    setPopover({ mode: "create" });
  }

  async function handlePopoverSave() {
    if (!popover) return;
    if (popover.mode === "edit") {
      await updateSpace(popover.id, { name: popoverName.trim() || "Untitled", emoji: popoverEmoji || null });
    } else {
      if (!popoverName.trim()) return;
      await createSpace(popoverName.trim(), popoverEmoji || undefined);
    }
    setPopover(null);
  }

  async function _confirmDelete(id: number) {
    await deleteSpace(id);
    removeSpace(String(id));
    setDeleteConfirmId(null);
  }

  const isAllNotes = isNotes && (selectedSpaceId === "general" || selectedSpaceId === null);

  return (
    <>
      <style>{`
        @keyframes gooni-sidebar-row-pulse {
          0%   { transform: scale(1);    box-shadow: 0 0 0 0 rgba(28,28,30,0.0); }
          22%  { transform: scale(1.04); box-shadow: 0 0 0 4px rgba(28,28,30,0.07); }
          60%  { transform: scale(1);    box-shadow: 0 0 0 2px rgba(28,28,30,0.03); }
          100% { transform: scale(1);    box-shadow: 0 0 0 0 rgba(28,28,30,0.0); }
        }
        @keyframes gooni-sidebar-caret-blink {
          0%, 49% { opacity: 1; }
          50%, 100% { opacity: 0; }
        }
        .gooni-sidebar-caret {
          display: inline-block;
          color: #1C1C1E;
          animation: gooni-sidebar-caret-blink 0.7s step-end infinite;
          margin-left: 1px;
          font-weight: 400;
        }
      `}</style>

      {/* Ink dot — flies from the dashboard composer's submit button to the
          first recent row when a note is saved. Fixed-position so it can
          render anywhere inside the sidebar tree without layout impact. */}
      {ink && (
        <div
          style={{
            position: "fixed",
            left: ink.fromX,
            top: ink.fromY,
            width: 14,
            height: 14,
            marginLeft: -7,
            marginTop: -7,
            borderRadius: "50%",
            background: "radial-gradient(circle at 35% 35%, #3A3A3C 0%, #1C1C1E 60%, #0A0A0B 100%)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.28), 0 0 2px rgba(0,0,0,0.35)",
            filter: "blur(0.3px)",
            pointerEvents: "none",
            zIndex: 9999,
            willChange: "transform, opacity",
            transform:
              ink.phase === "init"
                ? `translate(0px, 0px) rotate(${ink.angle}deg) scale(0.5, 0.5)`
                : ink.phase === "travel"
                ? `translate(${ink.toX - ink.fromX}px, ${ink.toY - ink.fromY}px) rotate(${ink.angle}deg) scale(1.55, 0.6)`
                : `translate(${ink.toX - ink.fromX}px, ${ink.toY - ink.fromY}px) rotate(0deg) scale(2.1, 2.1)`,
            opacity: ink.phase === "init" ? 0.55 : ink.phase === "absorb" ? 0 : 0.92,
            transition:
              ink.phase === "absorb"
                ? "transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.4s ease-out"
                : "transform 0.6s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.35s ease-in",
          }}
        />
      )}

      <div
        style={{
          width: 240, minWidth: 240, height: "100vh",
          background: palette.sidebar, display: "flex", flexDirection: "column",
          borderRight: "1px solid rgba(0,0,0,0.08)", boxSizing: "border-box",
          position: "relative",
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
            title={isDashboard ? "Back to notes" : "Dashboard"}
            style={{
              background: "transparent",
              border: "none", borderRadius: 8, padding: "3px 7px", cursor: "pointer",
              fontSize: 17, fontWeight: 700,
              fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
              color: "var(--gooni-text, #1C1C1E)", transition: "background 0.1s", outline: "none",
              display: "flex", alignItems: "center", gap: 7,
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
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
                style={{ width: 28, height: 28, borderRadius: 7, background: "transparent", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#3C3C43", padding: 0, flexShrink: 0, transition: "background 0.1s", outline: "none" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
              >
                <PenLine size={14} strokeWidth={1.6} />
              </button>
            )}
            {onClose && (
              <button
                onClick={onClose}
                title="Close sidebar"
                style={{ width: 28, height: 28, borderRadius: 7, background: "transparent", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#3C3C43", padding: 0, flexShrink: 0, transition: "background 0.1s", outline: "none" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
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
          .gooni-sidebar-scroll { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0) transparent; transition: scrollbar-color 0.2s; }
          .gooni-sidebar-scroll:hover { scrollbar-color: rgba(0,0,0,0.18) transparent; }
          .gooni-sidebar-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
          .gooni-sidebar-scroll::-webkit-scrollbar-track { background: transparent; }
          .gooni-sidebar-scroll::-webkit-scrollbar-thumb { background: transparent; border-radius: 3px; transition: background 0.2s; }
          .gooni-sidebar-scroll:hover::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.22); }
          .gooni-sidebar-scroll::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.36); }
        `}</style>
        <div
          ref={(el) => {
            sidebarScrollRef.current = el;
            // Restore on mount — the Sidebar component is mounted
            // separately on /, /memories, /chat-audit; without this the
            // scroll position resets every time the user clicks a top-
            // level destination ("Memories", "New chat"), which Daniel
            // perceives as the sidebar "auto-scrolling" to the top.
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
          {/* === REDESIGN v2 layout (matches Daniel's mockup) ===
              Dashboard prominent at top → New chat row → Notes / Spaces /
              Lists each as a labeled section with + button + 3-item
              flat list of children. Smaller font tier (13/12) so the
              chrome doesn't dwarf the editor content. */}

          {/* Dashboard — primary destination. info-blue highlight when
              active so eye-tracking lands here first. Reuses gotoBlank
              (onLogoClick) under the hood — both clear URL params and
              the view derivation in routes/index.tsx lands on
              "dashboard". */}
          <div style={{ padding: "4px 6px 2px" }}>
            <button
              onClick={onLogoClick}
              title="Dashboard"
              style={{
                display: "flex", alignItems: "center", gap: 10,
                width: "100%", padding: "0 10px", height: 30, borderRadius: 7,
                cursor: "pointer",
                background: isDashboard ? "rgba(10,132,255,0.10)" : "transparent",
                border: "none", textAlign: "left",
                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                fontWeight: isDashboard ? 600 : 500,
                fontSize: 13,
                color: isDashboard ? "#0A84FF" : "var(--gooni-text, #1C1C1E)",
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(e) => { if (!isDashboard) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)"; }}
              onMouseLeave={(e) => { if (!isDashboard) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <Home size={14} strokeWidth={1.8} color={isDashboard ? "#0A84FF" : "#475569"} style={{ flexShrink: 0 }} />
              Dashboard
            </button>
          </div>

          <div style={{ height: 1, margin: "8px 14px", background: "rgba(0,0,0,0.07)" }} />

          {/* === Notes section ===
              Header row clickable → All Notes. "all" trailing link is
              redundant w/ header click but Daniel wanted the explicit
              affordance (mirrors mock). + button gone — the pen icon
              next to the logo owns note creation now. */}
          <SidebarSection
            label="Notes"
            Icon={FileText}
            iconColor={ICON_TINT.allNotes}
            active={isAllNotes}
            onHeaderClick={handleAllNotes}
            onPlusClick={onCompose}
            showPlus={false}
            trailingLabel="all"
            onTrailingClick={handleAllNotes}
          >
            {[...orderedPinnedNotes, ...recentTop].slice(0, 3).map((note) => {
              const selected = activeNoteId === note.id;
              const pinned = pinnedNotes.some((p) => p.id === note.id);
              return (
                <SidebarChildRow
                  key={`note-${note.id}`}
                  label={displayTitle(note)}
                  icon={pinned ? <PinIcon size={11} strokeWidth={2} /> : null}
                  selected={selected}
                  onClick={() => handleSelectNote(note)}
                />
              );
            })}
          </SidebarSection>

          <div style={{ height: 1, margin: "8px 14px", background: "rgba(0,0,0,0.07)" }} />

          {/* === Spaces section ===
              Header opens nothing (just a label) — clicking a space row
              navigates. + opens the SpacePopover (existing create flow). */}
          <SidebarSection
            label="Spaces"
            Icon={FolderIcon}
            iconColor="#94A3B8"
            onHeaderClick={() => { /* label-only header for now */ }}
            onPlusClick={(e) => openCreatePopover(e as React.MouseEvent)}
          >
            {orderedSpaces.map((space) => {
              const spaceId = String(space.id);
              const isSelected = isNotes && selectedSpaceId === spaceId;
              return (
                <SidebarChildRow
                  key={`space-${space.id}`}
                  label={space.name}
                  prefix={space.is_pinned ? "★ " : ""}
                  selected={isSelected}
                  onClick={() => { selectSpace(spaceId); loadNotes(spaceId); }}
                />
              );
            })}
          </SidebarSection>

          <div style={{ height: 1, margin: "8px 14px", background: "rgba(0,0,0,0.07)" }} />

          {/* === Lists section ===
              + button opens an inline composer (newListDraft state). */}
          <SidebarSection
            label="Lists"
            Icon={ListIcon}
            iconColor="#94A3B8"
            onHeaderClick={() => { /* label-only header for now */ }}
            onPlusClick={() => handleAddList()}
          >
            {lists.map((lst) => (
              <SidebarChildRow
                key={`list-${lst.id}`}
                label={lst.name}
                selected={isLists && activeListId === lst.id}
                onClick={() => onSelectList(lst.id)}
              />
            ))}
            {newListDraft !== null && (
              <div style={{ padding: "3px 10px 3px 26px" }}>
                <input
                  ref={newListInputRef}
                  value={newListDraft}
                  onChange={(e) => setNewListDraft(e.target.value)}
                  onBlur={() => { void commitNewList(); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); void commitNewList(); }
                    if (e.key === "Escape") { e.preventDefault(); setNewListDraft(null); }
                  }}
                  placeholder="List name"
                  style={{
                    width: "100%", fontSize: 12, padding: "3px 6px",
                    border: "1px solid rgba(0,0,0,0.10)", borderRadius: 4,
                    outline: "none",
                    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                    background: "rgba(255,255,255,0.6)",
                  }}
                />
              </div>
            )}
          </SidebarSection>


          <div style={{ flex: 1, minHeight: 20 }} />

          {/* Divider into the bottom flat-nav cluster. Chat / Memories /
              Audit / Settings all read as flat navigation items at the
              same scale as section headers — Chat lives here (not as a
              top action) because it's a destination Daniel visits
              occasionally, not a primary write surface. */}
          <div style={{ height: 1, margin: "8px 14px", background: "rgba(0,0,0,0.07)" }} />
          <FlatNavRow
            label="Chat"
            Icon={MessageSquare}
            iconColor={ICON_TINT.newChat}
            active={isChat}
            onClick={onNewChat}
          />
          <FlatNavRow
            label="Memories"
            Icon={Brain}
            iconColor={ICON_TINT.memories}
            onClick={() => navigate({ to: "/memories", search: { focus: undefined } })}
          />
          <FlatNavRow
            label="Audit"
            Icon={ClipboardList}
            iconColor={ICON_TINT.chatAudit}
            active={!!isEval}
            onClick={() => {
              if (onOpenEval) { onOpenEval(); return; }
              navigate({
                to: "/",
                search: { audit: true, note: undefined, conv: undefined, list: undefined, segment: undefined, view: undefined },
              });
            }}
          />
          <FlatNavRow
            label="Settings"
            Icon={SettingsIcon}
            iconColor={ICON_TINT.settings}
            onClick={() => setSettingsOpen(true)}
          />
        </div>

        {/* Footer — Public profile + MCP connector. Side-by-side pills. Lives
            outside the scrollable area so they're always visible at sidebar
            bottom; replaces the floating top-right pair that was crowding
            the page header. */}
        <div style={{
          display: "flex", gap: 6, padding: "8px 8px 10px",
          borderTop: "1px solid rgba(0,0,0,0.06)", flexShrink: 0,
        }}>
          <button
            onClick={() => navigate({ to: "/public" })}
            title="Public profile (visitors see this)"
            aria-label="Public profile"
            style={sidebarFooterBtn}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
          >
            <Globe size={13} strokeWidth={1.7} />
            <span>Public</span>
          </button>
          <button
            onClick={() => navigate({ to: "/public/mcp" })}
            title="MCP — public connector page"
            aria-label="MCP"
            style={sidebarFooterBtn}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
          >
            <Plug size={13} strokeWidth={1.7} />
            <span>MCP</span>
          </button>
        </div>
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {popover && (
        <SpacePopover
          anchor={popoverAnchor}
          name={popoverName}
          emoji={popoverEmoji}
          onNameChange={setPopoverName}
          onEmojiChange={setPopoverEmoji}
          onSave={handlePopoverSave}
          onCancel={() => setPopover(null)}
        />
      )}
    </>
  );
}

// FlatNavRow — destination rows in the bottom cluster (Chat / Memories /
// Audit / Settings). Same scale as SidebarSection headers so they read
// as peers, not as muted afterthoughts. No trailing affordance — clicking
// the row navigates.
function FlatNavRow({ label, Icon, iconColor, active, onClick }: {
  label: string;
  Icon: typeof FileText;
  iconColor?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        width: "100%", padding: "7px 14px",
        border: "none",
        background: active ? "rgba(10,132,255,0.08)" : "transparent",
        cursor: "pointer", textAlign: "left",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        color: active ? "#0A66D6" : "var(--gooni-text, #1C1C1E)",
        transition: "background 0.12s, color 0.12s",
      }}
      onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.03)"; }}
      onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
    >
      <Icon size={15} strokeWidth={1.8} color={active ? "#0A66D6" : (iconColor ?? "#475569")} style={{ flexShrink: 0 }} />
      {label}
    </button>
  );
}
