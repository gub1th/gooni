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
  PenLine, FileText, Pin, MessageSquare, Brain, ClipboardList, Settings as SettingsIcon,
  Globe, Plug, Pencil, Clock, ListChecks, Inbox, Sparkles,
} from "lucide-react";
import { GooniLogo } from "../GooniLogo";
import { SettingsModal } from "../SettingsModal";
import { SpaceIcon, SPACE_ICON_OPTIONS, lucideIconValue } from "./SpaceIcon";
import { ListIcon } from "./ListIcon";

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
}

export function Sidebar({ isDashboard, isNotes, isChat, isLists, isEval, activeListId, showCompose, onLogoClick, onSpaceSelect, onAllNotes, onSelectNote, onCompose, onNewChat, onSelectList, onOpenEval }: SidebarProps) {
  const navigate = useNavigate();
  const { selectedSpaceId, selectSpace, loadNotes, selectNote, activeNoteId, removeSpace } = useNotesContentStore();
  const { spaces, createSpace, updateSpace, deleteSpace } = useSpacesStore();
  const lists = useListsStore((s) => s.lists);
  const createListInStore = useListsStore((s) => s.createList);
  const [listsOpen, setListsOpen] = useState(true);
  // Inline new-list composer state. When non-null, an input row replaces
  // the placeholder so the user can name + Enter without a browser prompt.
  const [newListDraft, setNewListDraft] = useState<string | null>(null);
  const newListInputRef = useRef<HTMLInputElement>(null);

  function handleAddList() {
    setListsOpen(true);
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
  const [unprocessedNotes, setUnprocessedNotes] = useState<ApiNote[]>([]);
  const [recentNotes, setRecentNotes] = useState<ApiNote[]>([]);
  const [spacesOpen, setSpacesOpen] = useState(true);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [draftsOpen, setDraftsOpen] = useState(true);
  const [unprocessedOpen, setUnprocessedOpen] = useState(true);
  const [recentOpen, setRecentOpen] = useState(true);
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
  const [inlinePaletteOpen, setInlinePaletteOpen] = useState(false);
  const inlineNameRef = useRef<HTMLInputElement>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

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

  function dropSpace(overId: number) {
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

  async function handleUndraft(noteId: number) {
    setDraftNotes((prev) => prev.filter((n) => n.id !== noteId)); // optimistic
    await patchNote(noteId, { is_draft: false });
    useDraftVersionStore.getState().bump();
  }

  async function handleArchiveUnprocessed(noteId: number) {
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

  function startInlineEdit(e: React.MouseEvent, id: number, name: string, emoji: string | null) {
    e.stopPropagation();
    setInlineEditId(id);
    setInlineEditName(name);
    setInlineEditEmoji(emoji ?? "");
    setInlinePaletteOpen(false);
    setDeleteConfirmId(null);
    // Focus the input after state commits + the input has been rendered.
    requestAnimationFrame(() => inlineNameRef.current?.focus());
  }

  async function commitInlineEdit() {
    if (inlineEditId == null) return;
    const trimmed = inlineEditName.trim() || "Untitled";
    await updateSpace(inlineEditId, { name: trimmed, emoji: inlineEditEmoji || null });
    setInlineEditId(null);
    setInlinePaletteOpen(false);
  }

  function cancelInlineEdit() {
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

  async function confirmDelete(id: number) {
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
          width: 200, minWidth: 200, height: "100vh",
          background: palette.sidebar, display: "flex", flexDirection: "column",
          borderRight: "1px solid rgba(0,0,0,0.08)", boxSizing: "border-box",
          position: "relative",
        }}
      >
        {/* Header — logo + compose */}
        <div style={{
          height: 52, padding: "0 12px", display: "flex", alignItems: "center",
          justifyContent: "space-between", flexShrink: 0,
          borderBottom: "1px solid rgba(0,0,0,0.06)",
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
          {showCompose && (
            <button
              onClick={onCompose}
              title="New note"
              style={{ width: 30, height: 30, borderRadius: 8, background: "transparent", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#3C3C43", padding: 0, flexShrink: 0, transition: "background 0.1s", outline: "none" }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
            >
              <PenLine size={15} strokeWidth={1.6} />
            </button>
          )}
        </div>

        {/* Scrollable content — thin overlay scrollbar that fades in only
            when the user is scrolling. Static chunky scrollbar Daniel
            flagged was a leftover platform default. */}
        <style>{`
          .gooni-sidebar-scroll { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0) transparent; transition: scrollbar-color 0.2s; }
          .gooni-sidebar-scroll:hover { scrollbar-color: rgba(0,0,0,0.18) transparent; }
          .gooni-sidebar-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
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
          {/* Top-level shortcuts: Todos + Backlog. Resolves to the canonical
              first list of each type (multiple todo/backlog lists are rare —
              the rest are reachable via the LISTS section below). Hidden when
              the lists haven't loaded yet or no list of that type exists. */}
          {(() => {
            const todoList = lists.find((l) => l.type === "todo");
            const backlogList = lists.find((l) => l.type === "backlog");
            if (!todoList && !backlogList) return null;
            const rowStyle = (isSelected: boolean): React.CSSProperties => ({
              display: "flex", alignItems: "center", gap: 8,
              width: "100%", padding: "0 10px", height: 32, borderRadius: 8,
              border: "none", textAlign: "left",
              background: isSelected ? "rgba(0,0,0,0.09)" : "transparent",
              cursor: "pointer",
              fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
              fontSize: 14.5, color: "var(--gooni-text, #1C1C1E)",
              fontWeight: isSelected ? 600 : 400,
              transition: "background 0.12s",
            });
            return (
              <div style={{ padding: "4px 6px 4px" }}>
                {todoList && (
                  <button
                    onClick={() => onSelectList(todoList.id)}
                    title="Todos"
                    style={rowStyle(isLists && activeListId === todoList.id)}
                    onMouseEnter={(e) => { if (!(isLists && activeListId === todoList.id)) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)"; }}
                    onMouseLeave={(e) => { if (!(isLists && activeListId === todoList.id)) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                  >
                    <ListChecks size={15} strokeWidth={1.7} color={ICON_TINT.todos} style={{ flexShrink: 0 }} />
                    <span>Todos</span>
                  </button>
                )}
                {backlogList && (
                  <button
                    onClick={() => onSelectList(backlogList.id)}
                    title="Backlog"
                    style={rowStyle(isLists && activeListId === backlogList.id)}
                    onMouseEnter={(e) => { if (!(isLists && activeListId === backlogList.id)) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)"; }}
                    onMouseLeave={(e) => { if (!(isLists && activeListId === backlogList.id)) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                  >
                    <Inbox size={15} strokeWidth={1.7} color={ICON_TINT.backlog} style={{ flexShrink: 0 }} />
                    <span>Backlog</span>
                  </button>
                )}
                <div style={{ height: 1, background: "rgba(0,0,0,0.07)", margin: "8px 4px 0" }} />
              </div>
            );
          })()}

          {/* Section: NOTES */}
          <div style={{ padding: "8px 12px 4px" }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.5, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", userSelect: "none" }}>
              NOTES
            </span>
          </div>

          <div style={{ padding: "0 6px 4px" }}>
            {/* All Notes */}
            <div
              onClick={handleAllNotes}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "0 10px", height: 32, borderRadius: 8,
                cursor: "pointer",
                background: isAllNotes ? "rgba(0,0,0,0.09)" : "transparent",
                transition: "background 0.12s", userSelect: "none", marginBottom: 2,
              }}
              onMouseEnter={(e) => { if (!isAllNotes) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.05)"; }}
              onMouseLeave={(e) => { if (!isAllNotes) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
            >
              <FileText size={15} strokeWidth={1.7} color={ICON_TINT.allNotes} style={{ flexShrink: 0 }} />
              <span style={{
                flex: 1, fontSize: 13.5,
                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                fontWeight: isAllNotes ? 600 : 400, color: "var(--gooni-text, #1C1C1E)",
              }}>All Notes</span>
            </div>
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: "rgba(0,0,0,0.07)", margin: "6px 10px" }} />

          {/* Section: PINNED — sits above Spaces */}
          {pinnedNotes.length > 0 && (
            <>
              <div style={{ padding: "0 6px 4px" }}>
                <div style={{ display: "flex", alignItems: "center", padding: "6px 6px 2px" }}>
                  <button
                    onClick={() => setPinnedOpen((o) => !o)}
                    style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", padding: 0, flex: 1 }}
                  >
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.5, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>PINNED</span>
                    <span style={{ fontSize: 9, color: "#AEAEB2", marginLeft: 4 }}>{pinnedOpen ? "▾" : "▸"}</span>
                  </button>
                </div>
                {pinnedOpen && orderedPinnedNotes.map((note) => {
                  const selected = activeNoteId === note.id;
                  const isDragging = drag?.kind === "pinned" && drag.fromId === note.id;
                  const isDropTarget = drag?.kind === "pinned" && drag.overId === note.id && drag.fromId !== note.id;
                  return (
                    <div
                      key={note.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", String(note.id));
                        setDrag({ kind: "pinned", fromId: note.id, overId: null });
                      }}
                      onDragOver={(e) => {
                        if (drag?.kind !== "pinned") return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (drag.overId !== note.id) setDrag({ ...drag, overId: note.id });
                      }}
                      onDragLeave={() => {
                        if (drag?.kind === "pinned" && drag.overId === note.id) setDrag({ ...drag, overId: null });
                      }}
                      onDrop={(e) => { e.preventDefault(); dropPinned(note.id); }}
                      onDragEnd={() => setDrag(null)}
                      style={{
                        display: "flex", alignItems: "center", gap: 4,
                        padding: "0 4px 0 10px", height: 30, borderRadius: 8,
                        cursor: "pointer",
                        background: selected ? "rgba(0,0,0,0.09)" : (isDropTarget ? "rgba(0,120,255,0.10)" : "transparent"),
                        opacity: isDragging ? 0.4 : 1,
                        transition: "background 0.12s, opacity 0.12s",
                        boxShadow: isDropTarget ? "inset 0 2px 0 rgba(0,120,255,0.45)" : "none",
                      }}
                      onMouseEnter={(e) => { if (!selected && !isDropTarget) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.05)"; (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLButtonElement>(".pin-action").forEach(b => b.style.opacity = "1"); }}
                      onMouseLeave={(e) => { if (!selected && !isDropTarget) (e.currentTarget as HTMLDivElement).style.background = "transparent"; (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLButtonElement>(".pin-action").forEach(b => b.style.opacity = "0"); }}
                      onClick={(e) => { if ((e.target as HTMLElement).closest("button")) return; handleSelectNote(note); }}
                    >
                      <Pin size={13} strokeWidth={1.8} color={ICON_TINT.pinned} fill={ICON_TINT.pinned} style={{ flexShrink: 0 }} />
                      <span style={{
                        flex: 1, fontSize: 14,
                        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                        fontWeight: selected ? 600 : 400, color: "var(--gooni-text, #1C1C1E)",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {displayTitle(note)}
                      </span>
                      <button
                        className="pin-action"
                        onClick={(e) => { e.stopPropagation(); handleUnpin(note.id); }}
                        title="Unpin"
                        style={{ opacity: 0, background: "none", border: "none", cursor: "pointer", color: "var(--gooni-muted, #8E8E93)", fontSize: 12, padding: "0 3px", flexShrink: 0 }}
                      >×</button>
                    </div>
                  );
                })}
              </div>
              <div style={{ height: 1, background: "rgba(0,0,0,0.07)", margin: "6px 10px" }} />
            </>
          )}

          {/* Section: DRAFTS — notes the user committed to publishing but is
              still writing. Hidden when empty so it doesn't clutter the
              sidebar for everyday note-taking. No drag-reorder (kept simple);
              ✕ on hover to flip is_draft off. */}
          {draftNotes.length > 0 && (
            <>
              <div style={{ padding: "0 6px 4px" }}>
                <div style={{ display: "flex", alignItems: "center", padding: "6px 6px 2px" }}>
                  <button
                    onClick={() => setDraftsOpen((o) => !o)}
                    style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", padding: 0, flex: 1 }}
                  >
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.5, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>DRAFTS</span>
                    <span style={{ fontSize: 9, color: "#AEAEB2", marginLeft: 4 }}>{draftsOpen ? "▾" : "▸"}</span>
                  </button>
                </div>
                {draftsOpen && draftNotes.map((note) => {
                  const selected = activeNoteId === note.id;
                  return (
                    <div
                      key={note.id}
                      style={{
                        display: "flex", alignItems: "center", gap: 4,
                        padding: "0 4px 0 10px", height: 30, borderRadius: 8,
                        cursor: "pointer",
                        background: selected ? "rgba(0,0,0,0.09)" : "transparent",
                        transition: "background 0.12s",
                      }}
                      onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.05)"; (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLButtonElement>(".draft-action").forEach(b => b.style.opacity = "1"); }}
                      onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = "transparent"; (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLButtonElement>(".draft-action").forEach(b => b.style.opacity = "0"); }}
                      onClick={(e) => { if ((e.target as HTMLElement).closest("button")) return; handleSelectNote(note); }}
                    >
                      <Pencil size={13} strokeWidth={1.8} color={ICON_TINT.draft} style={{ flexShrink: 0 }} />
                      <span style={{
                        flex: 1, fontSize: 14,
                        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                        fontWeight: selected ? 600 : 400, color: "var(--gooni-text, #1C1C1E)",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {displayTitle(note)}
                      </span>
                      <button
                        className="draft-action"
                        onClick={(e) => { e.stopPropagation(); handleUndraft(note.id); }}
                        title="Remove from drafts"
                        style={{ opacity: 0, background: "none", border: "none", cursor: "pointer", color: "var(--gooni-muted, #8E8E93)", fontSize: 12, padding: "0 3px", flexShrink: 0 }}
                      >×</button>
                    </div>
                  );
                })}
              </div>
              <div style={{ height: 1, background: "rgba(0,0,0,0.07)", margin: "6px 10px" }} />
            </>
          )}

          {/* Section: UNPROCESSED — captured notes that haven't graduated
              into a Promise / Todo / Habit / Focus yet. Daniel's triage
              queue. Hidden when empty; ✕ on hover archives the note
              (status='archived') so it stops surfacing in the queue + the
              synthesizer. */}
          {unprocessedNotes.length > 0 && (
            <>
              <div style={{ padding: "0 6px 4px" }}>
                <div style={{ display: "flex", alignItems: "center", padding: "6px 6px 2px" }}>
                  <button
                    onClick={() => setUnprocessedOpen((o) => !o)}
                    style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", padding: 0, flex: 1 }}
                  >
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.5, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>UNPROCESSED</span>
                    <span style={{ fontSize: 9, color: "#AEAEB2", marginLeft: 4 }}>{unprocessedOpen ? "▾" : "▸"}</span>
                  </button>
                </div>
                {unprocessedOpen && unprocessedNotes.slice(0, 3).map((note) => {
                  const selected = activeNoteId === note.id;
                  return (
                    <div
                      key={note.id}
                      style={{
                        display: "flex", alignItems: "center", gap: 4,
                        padding: "0 4px 0 10px", height: 30, borderRadius: 8,
                        cursor: "pointer",
                        background: selected ? "rgba(0,0,0,0.09)" : "transparent",
                        transition: "background 0.12s",
                      }}
                      onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.05)"; (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLButtonElement>(".unproc-action").forEach(b => b.style.opacity = "1"); }}
                      onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = "transparent"; (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLButtonElement>(".unproc-action").forEach(b => b.style.opacity = "0"); }}
                      onClick={(e) => { if ((e.target as HTMLElement).closest("button")) return; handleSelectNote(note); }}
                    >
                      <Sparkles size={13} strokeWidth={1.8} color="#AEAEB2" style={{ flexShrink: 0 }} />
                      <span style={{
                        flex: 1, fontSize: 14,
                        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                        fontWeight: selected ? 600 : 400, color: "var(--gooni-text, #1C1C1E)",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {displayTitle(note)}
                      </span>
                      <button
                        className="unproc-action"
                        onClick={(e) => { e.stopPropagation(); handleArchiveUnprocessed(note.id); }}
                        title="Archive (stop surfacing)"
                        style={{ opacity: 0, background: "none", border: "none", cursor: "pointer", color: "var(--gooni-muted, #8E8E93)", fontSize: 12, padding: "0 3px", flexShrink: 0 }}
                      >×</button>
                    </div>
                  );
                })}
              </div>
              <div style={{ height: 1, background: "rgba(0,0,0,0.07)", margin: "6px 10px" }} />
            </>
          )}

          {/* Section: RECENT — top 5 most-recently-edited notes, deduped
              against PINNED + DRAFTS above. Read-only quick-jump; no drag,
              no actions. Sits below PINNED/DRAFTS so the explicitly-marked
              surfaces win the eye. Hidden when empty (e.g. brand new DB).
              Owns the post-submit ink + typewriter animation that used to
              live on the dashboard's recent-notes grid. */}
          {recentTop.length > 0 && (
            <>
              <div style={{ padding: "0 6px 4px" }}>
                <div style={{ display: "flex", alignItems: "center", padding: "6px 6px 2px" }}>
                  <button
                    onClick={() => setRecentOpen((o) => !o)}
                    style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", padding: 0, flex: 1 }}
                  >
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.5, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>RECENT</span>
                    <span style={{ fontSize: 9, color: "#AEAEB2", marginLeft: 4 }}>{recentOpen ? "▾" : "▸"}</span>
                  </button>
                </div>
                {recentOpen && recentTop.map((note) => {
                  const selected = activeNoteId === note.id;
                  const fullTitle = displayTitle(note);
                  const isTyping = typing !== null && typing.noteId === note.id;
                  const revealed = isTyping ? typing!.revealed : Infinity;
                  const shownTitle = isTyping
                    ? fullTitle.slice(0, Math.min(revealed, fullTitle.length))
                    : fullTitle;
                  const showCaret = isTyping && revealed <= fullTitle.length;
                  const isPulsing = pulseId === note.id;
                  return (
                    <div
                      key={note.id}
                      ref={(el) => {
                        if (el) recentRowRefs.current.set(note.id, el);
                        else recentRowRefs.current.delete(note.id);
                      }}
                      style={{
                        display: "flex", alignItems: "center", gap: 4,
                        padding: "0 4px 0 10px", height: 30, borderRadius: 8,
                        cursor: "pointer",
                        background: selected ? "rgba(0,0,0,0.09)" : "transparent",
                        transition: "background 0.12s",
                        animation: isPulsing ? "gooni-sidebar-row-pulse 0.6s cubic-bezier(0.22,1,0.36,1)" : undefined,
                      }}
                      onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.05)"; }}
                      onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
                      onClick={() => handleSelectNote(note)}
                    >
                      <Clock size={13} strokeWidth={1.8} color={ICON_TINT.recent} style={{ flexShrink: 0 }} />
                      <span style={{
                        flex: 1, fontSize: 14,
                        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                        fontWeight: selected ? 600 : 400, color: "var(--gooni-text, #1C1C1E)",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {shownTitle || (isTyping ? " " : fullTitle || "Untitled")}
                        {showCaret && <span className="gooni-sidebar-caret">▍</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div style={{ height: 1, background: "rgba(0,0,0,0.07)", margin: "6px 10px" }} />
            </>
          )}

          {/* Section: SPACES */}
          <div style={{ padding: "0 6px 4px" }}>
            <div style={{ display: "flex", alignItems: "center", padding: "6px 6px 2px" }}>
              <button
                onClick={() => setSpacesOpen((o) => !o)}
                style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", padding: 0, flex: 1 }}
              >
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.5, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>SPACES</span>
                <span style={{ fontSize: 9, color: "#AEAEB2", marginLeft: 4 }}>{spacesOpen ? "▾" : "▸"}</span>
              </button>
              <button
                onClick={openCreatePopover}
                title="New space"
                style={{ background: "none", border: "none", cursor: "pointer", color: "#AEAEB2", fontSize: 16, lineHeight: 1, padding: "0 2px", display: "flex", alignItems: "center" }}
              >+</button>
            </div>

            {spacesOpen && orderedSpaces.map((space) => {
              const spaceId = String(space.id);
              const isSelected = isNotes && selectedSpaceId === spaceId;
              const isDelConfirm = deleteConfirmId === space.id;
              const isDragging = drag?.kind === "space" && drag.fromId === space.id;
              const isDropTarget = drag?.kind === "space" && drag.overId === space.id && drag.fromId !== space.id;

              return (
                <div
                  key={space.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", String(space.id));
                    setDrag({ kind: "space", fromId: space.id as number, overId: null });
                  }}
                  onDragOver={(e) => {
                    if (drag?.kind !== "space") return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (drag.overId !== space.id) setDrag({ ...drag, overId: space.id as number });
                  }}
                  onDragLeave={() => {
                    if (drag?.kind === "space" && drag.overId === space.id) setDrag({ ...drag, overId: null });
                  }}
                  onDrop={(e) => { e.preventDefault(); dropSpace(space.id as number); }}
                  onDragEnd={() => setDrag(null)}
                  style={{
                    display: "flex", alignItems: "center", gap: 4,
                    padding: "0 4px 0 10px", height: 30, borderRadius: 8,
                    cursor: "pointer",
                    background: isSelected ? "rgba(0,0,0,0.09)" : (isDropTarget ? "rgba(0,120,255,0.10)" : "transparent"),
                    opacity: isDragging ? 0.4 : 1,
                    transition: "background 0.12s, opacity 0.12s",
                    userSelect: "none",
                    boxShadow: isDropTarget ? "inset 0 2px 0 rgba(0,120,255,0.45)" : "none",
                  }}
                  onMouseEnter={(e) => { if (!isSelected && !isDropTarget) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.05)"; (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLButtonElement>(".space-action").forEach(b => b.style.opacity = "1"); }}
                  onMouseLeave={(e) => { if (!isSelected && !isDropTarget) (e.currentTarget as HTMLDivElement).style.background = "transparent"; (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLButtonElement>(".space-action").forEach(b => b.style.opacity = "0"); setDeleteConfirmId(null); }}
                  onClick={(e) => { if ((e.target as HTMLElement).closest("button")) return; selectSpace(spaceId); loadNotes(spaceId); onSpaceSelect(); }}
                >
                  {inlineEditId === space.id ? (
                    <>
                      {/* Emoji button — toggles inline palette below the row */}
                      <button
                        onClick={(e) => { e.stopPropagation(); setInlinePaletteOpen((o) => !o); }}
                        title="Pick icon"
                        style={{
                          width: 18, height: 18, borderRadius: 4,
                          border: inlinePaletteOpen ? "1px solid rgba(0,0,0,0.2)" : "1px solid transparent",
                          background: inlinePaletteOpen ? "rgba(0,0,0,0.04)" : "transparent",
                          padding: 0, flexShrink: 0,
                          display: "inline-flex", alignItems: "center", justifyContent: "center",
                          cursor: "pointer",
                        }}
                      >
                        <SpaceIcon emoji={inlineEditEmoji || null} size={12} color="#475569" />
                      </button>
                      <input
                        ref={inlineNameRef}
                        value={inlineEditName}
                        onChange={(e) => setInlineEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void commitInlineEdit(); }
                          if (e.key === "Escape") { e.preventDefault(); cancelInlineEdit(); }
                        }}
                        onBlur={(e) => {
                          // Don't auto-save if focus is moving to the emoji palette below.
                          const next = e.relatedTarget as HTMLElement | null;
                          if (next?.closest?.("[data-inline-emoji-palette]")) return;
                          void commitInlineEdit();
                        }}
                        onClick={(e) => e.stopPropagation()}
                        placeholder="Space name"
                        style={{
                          flex: 1, fontSize: 14, outline: "none", border: "none",
                          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                          fontWeight: 500, color: "var(--gooni-text, #1C1C1E)",
                          background: "rgba(0,0,0,0.04)",
                          borderRadius: 4, padding: "2px 6px",
                          minWidth: 0,
                        }}
                      />
                    </>
                  ) : (
                    <>
                      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, flexShrink: 0 }}>
                        <SpaceIcon emoji={space.emoji} size={14} />
                      </span>
                      <span style={{ flex: 1, fontSize: 14, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", fontWeight: isSelected ? 600 : 400, color: "var(--gooni-text, #1C1C1E)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {space.name}
                      </span>
                      {/* Pin toggle — pinned ★ is always visible (active-
                          state signal); hollow ☆ rides the `.space-action`
                          hover class so it doesn't litter every row.
                          Click bubbling is killed so we don't open the
                          space at the same time. */}
                      <button
                        className={space.is_pinned ? undefined : "space-action"}
                        onClick={(e) => {
                          e.stopPropagation();
                          void updateSpace(space.id as number, { is_pinned: !space.is_pinned });
                        }}
                        title={space.is_pinned ? "Unpin space" : "Pin space"}
                        style={{
                          opacity: space.is_pinned ? 1 : 0,
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: space.is_pinned
                            ? "#0A84FF"
                            : "rgba(142,142,147,0.45)",
                          fontSize: 12,
                          padding: "0 3px",
                          flexShrink: 0,
                          lineHeight: 1,
                          transition: "opacity 0.12s",
                        }}
                      >
                        {space.is_pinned ? "★" : "☆"}
                      </button>
                      {isDelConfirm ? (
                        <button className="space-action" onClick={(e) => { e.stopPropagation(); confirmDelete(space.id as number); }}
                          style={{ opacity: 1, background: "none", border: "none", cursor: "pointer", color: "#FF3B30", fontSize: 10.5, padding: "0 3px", flexShrink: 0, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>
                          sure?
                        </button>
                      ) : (
                        <>
                          <button className="space-action" onClick={(e) => startInlineEdit(e, space.id as number, space.name, space.emoji)}
                            style={{ opacity: 0, background: "none", border: "none", cursor: "pointer", color: "var(--gooni-muted, #8E8E93)", fontSize: 11, padding: "0 2px", flexShrink: 0 }} title="Rename">✎</button>
                          <button className="space-action" onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(space.id as number); }}
                            style={{ opacity: 0, background: "none", border: "none", cursor: "pointer", color: "var(--gooni-muted, #8E8E93)", fontSize: 11, padding: "0 2px", flexShrink: 0 }} title="Delete">×</button>
                        </>
                      )}
                    </>
                  )}
                </div>
              );
            })}
            {/* Inline emoji palette — anchored to whichever space is being
                edited. Sits in the spaces section flow rather than as a
                fixed overlay so it pushes other rows down naturally. */}
            {inlineEditId != null && inlinePaletteOpen && (
              <div
                data-inline-emoji-palette
                onMouseDown={(e) => e.preventDefault()}
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(6, 1fr)",
                  gap: 2,
                  padding: "6px 8px 8px 30px",
                }}
              >
                {SPACE_ICON_OPTIONS.map(({ name, Icon }) => {
                  const value = lucideIconValue(name);
                  const selected = inlineEditEmoji === value;
                  return (
                    <button
                      key={name}
                      onMouseDown={(e) => {
                        // Prevent the input's onBlur from firing (which would
                        // commit + close edit mode before our click lands).
                        e.preventDefault();
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setInlineEditEmoji(value);
                        setInlinePaletteOpen(false);
                        inlineNameRef.current?.focus();
                      }}
                      title={name}
                      style={{
                        background: selected ? "rgba(15,23,42,0.08)" : "transparent",
                        border: "none", borderRadius: 6, cursor: "pointer",
                        height: 24, padding: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        color: selected ? "#0F172A" : "#475569",
                        transition: "background 0.1s, color 0.1s",
                      }}
                    >
                      <Icon size={13} strokeWidth={1.8} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Lists — unified todo / backlog / generic. Independent of Spaces. */}
          <div style={{ padding: "0 6px 4px" }}>
            <div style={{ display: "flex", alignItems: "center", padding: "6px 6px 2px" }}>
              <button
                onClick={() => setListsOpen((o) => !o)}
                style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", padding: 0, flex: 1 }}
              >
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.5, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>LISTS</span>
                <span style={{ fontSize: 9, color: "#AEAEB2", marginLeft: 4 }}>{listsOpen ? "▾" : "▸"}</span>
              </button>
              <button
                onClick={handleAddList}
                title="New list"
                style={{ background: "none", border: "none", cursor: "pointer", color: "#AEAEB2", fontSize: 16, lineHeight: 1, padding: "0 2px", display: "flex", alignItems: "center" }}
              >+</button>
            </div>
          </div>
          {listsOpen && (
            <div style={{ padding: "0 6px 4px" }}>
              {newListDraft !== null && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "0 10px", height: 30, borderRadius: 8,
                  background: "rgba(74,222,128,0.10)",
                  border: "1px solid rgba(74,222,128,0.35)",
                  marginBottom: 2,
                  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                }}>
                  <span style={{ flexShrink: 0, display: "inline-flex", alignItems: "center" }}>
                    <ListIcon emoji={null} type="generic" size={14} />
                  </span>
                  <input
                    ref={newListInputRef}
                    value={newListDraft}
                    onChange={(e) => setNewListDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitNewList();
                      if (e.key === "Escape") setNewListDraft(null);
                    }}
                    onBlur={commitNewList}
                    placeholder="List name…"
                    style={{
                      flex: 1, minWidth: 0,
                      border: "none", outline: "none", background: "transparent",
                      fontFamily: "inherit", fontSize: 14.5, color: "var(--gooni-text, #1C1C1E)",
                    }}
                  />
                </div>
              )}
              {lists.length === 0 && newListDraft === null && (
                <div style={{
                  padding: "4px 10px", fontSize: 12, color: "#9CA3AF",
                  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                }}>
                  No lists yet
                </div>
              )}
              {lists.map((lst) => {
                const isSelected = isLists && activeListId === lst.id;
                return (
                  <button
                    key={lst.id}
                    onClick={() => onSelectList(lst.id)}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      width: "100%", padding: "0 10px", height: 30, borderRadius: 8,
                      cursor: "pointer", background: isSelected ? "rgba(0,0,0,0.09)" : "transparent",
                      border: "none", textAlign: "left",
                      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                      fontWeight: isSelected ? 600 : 400, fontSize: 14.5, color: "var(--gooni-text, #1C1C1E)",
                      transition: "background 0.12s",
                    }}
                    onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)"; }}
                    onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                  >
                    <span style={{ flexShrink: 0, display: "inline-flex", alignItems: "center" }}>
                      <ListIcon emoji={lst.emoji} type={lst.type} size={14} />
                    </span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {lst.name}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Spacer — push New chat + Settings to the bottom */}
          <div style={{ flex: 1, minHeight: 20 }} />

          {/* New chat — directly above Settings */}
          <div style={{ padding: "0 6px 4px" }}>
            <button
              onClick={onNewChat}
              title="Start a new chat with Gooni"
              style={{
                display: "flex", alignItems: "center", gap: 8,
                width: "100%", padding: "0 10px", height: 32, borderRadius: 8,
                cursor: "pointer", background: isChat ? "rgba(0,0,0,0.09)" : "transparent",
                border: "none", textAlign: "left",
                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                fontWeight: isChat ? 600 : 400, fontSize: 14.5, color: "var(--gooni-text, #1C1C1E)",
                transition: "background 0.12s",
              }}
              onMouseEnter={(e) => { if (!isChat) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)"; }}
              onMouseLeave={(e) => { if (!isChat) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <MessageSquare size={14} strokeWidth={1.7} color={ICON_TINT.newChat} style={{ flexShrink: 0 }} />
              New chat
            </button>
          </div>

          {/* Memories — full dashboard at /memories. Sits above Dev tools so
              it reads as a top-level surface (not a debug affordance). */}
          <div style={{ padding: "0 6px 2px" }}>
            <button
              onClick={() => navigate({ to: "/memories", search: { focus: undefined } })}
              title="Memory dashboard"
              style={{
                display: "flex", alignItems: "center", gap: 8,
                width: "100%", padding: "0 10px", height: 32, borderRadius: 8,
                border: "none", background: "transparent", cursor: "pointer",
                textAlign: "left",
                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                fontSize: 13.5, color: "#3C3C43",
                transition: "background 0.12s",
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
            >
              <Brain size={14} strokeWidth={1.7} color={ICON_TINT.memories} style={{ flexShrink: 0 }} />
              Memories
            </button>
          </div>

          {/* Audit — Eval grid + Chat audit as tabs in one page. Always
              renders so it's reachable from /memories, /chat-audit, or any
              future route that mounts the Sidebar; navigation goes through
              the router via ?audit=1, not a parent-passed callback. The
              optional `onOpenEval` short-circuit still works for index.tsx
              where we'd rather flip view state than re-route. */}
          <div style={{ padding: "0 6px 2px" }}>
            <button
              onClick={() => {
                if (onOpenEval) {
                  onOpenEval();
                  return;
                }
                navigate({
                  to: "/",
                  search: { audit: true, note: undefined, conv: undefined, list: undefined, segment: undefined, view: undefined },
                });
              }}
              title="Audit — score Gooni's replies + dispatch to Claude Code"
              style={{
                display: "flex", alignItems: "center", gap: 8,
                width: "100%", padding: "0 10px", height: 32, borderRadius: 8,
                border: "none",
                background: isEval ? "rgba(0,0,0,0.09)" : "transparent",
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                fontWeight: isEval ? 600 : 400,
                fontSize: 14.5, color: "var(--gooni-text, #1C1C1E)",
                transition: "background 0.12s",
              }}
              onMouseEnter={(e) => { if (!isEval) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)"; }}
              onMouseLeave={(e) => { if (!isEval) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <ClipboardList size={14} strokeWidth={1.7} color={ICON_TINT.chatAudit} style={{ flexShrink: 0 }} />
              Audit
            </button>
          </div>

          {/* Stats sidebar entry removed in dashboard restructure — the
              page's content (Whoop / LeetCode / Dev / Usage / Activity)
              moved into the dashboard Stats tab. */}

          {/* Settings — stays at the bottom as a full row (icon + label) */}
          <div style={{ padding: "0 6px 10px" }}>
            <button
              onClick={() => setSettingsOpen(true)}
              title="Settings"
              style={{
                display: "flex", alignItems: "center", gap: 8,
                width: "100%", padding: "0 10px", height: 32, borderRadius: 8,
                border: "none", background: "transparent", cursor: "pointer",
                textAlign: "left",
                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                fontSize: 13.5, color: "#3C3C43",
                transition: "background 0.12s",
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
            >
              <SettingsIcon size={14} strokeWidth={1.7} color={ICON_TINT.settings} style={{ flexShrink: 0 }} />
              Settings
            </button>
          </div>
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
