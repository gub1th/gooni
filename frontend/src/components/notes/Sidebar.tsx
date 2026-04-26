import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useSpacesStore } from "../../stores/useSpacesStore";
import { fetchPinnedNotes, patchNote, type ApiNote } from "../../services/api";
import { usePinnedVersionStore } from "../../stores/usePinnedVersionStore";
import { useGooniThemeStore, THEME_PALETTES } from "../../stores/useGooniThemeStore";
import { useOrderingStore, applyOrder } from "../../stores/useOrderingStore";
import {
  PenLine, FileText, Pin, MessageSquare, Bug, Brain, ClipboardList, Settings as SettingsIcon,
} from "lucide-react";
import { GooniLogo } from "../GooniLogo";
import { SettingsModal } from "../SettingsModal";
import { DevToolsModal } from "../DevToolsModal";
import { SpaceIcon, SPACE_ICON_OPTIONS, lucideIconValue } from "./SpaceIcon";

// Per-item color tints — Tolaria-style subtle hues.
const ICON_TINT = {
  allNotes: "#6366F1",   // indigo
  pinned:   "#F59E0B",   // amber
  newChat:  "#10B981",   // emerald
  gooni:    "#A855F7",   // violet
  memories: "#0EA5E9",  // sky
  chatAudit: "#0891B2",  // cyan
  devTools: "#F43F5E",   // rose
  settings: "#64748B",   // slate
} as const;

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
          zIndex: 100, background: "#fff", borderRadius: 10,
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
              fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
              fontWeight: 500, color: "#1C1C1E", background: "transparent",
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
              cursor: "pointer", color: "#8E8E93",
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
  showCompose: boolean;
  onLogoClick: () => void;
  onSpaceSelect: () => void;
  onCompose: () => void;
  onNewChat: () => void;
}

export function Sidebar({ isDashboard, isNotes, isChat, showCompose, onLogoClick, onSpaceSelect, onCompose, onNewChat }: SidebarProps) {
  const navigate = useNavigate();
  const { selectedSpaceId, selectSpace, loadNotes, selectNote, activeNoteId, removeSpace } = useNotesContentStore();
  const { spaces, createSpace, updateSpace, deleteSpace } = useSpacesStore();

  const [pinnedNotes, setPinnedNotes] = useState<ApiNote[]>([]);
  const [spacesOpen, setSpacesOpen] = useState(true);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const theme = useGooniThemeStore((s) => s.theme);
  const palette = THEME_PALETTES[theme];

  const [popover, setPopover] = useState<PopoverMode>(null);
  const [popoverAnchor, setPopoverAnchor] = useState({ top: 0, left: 208 });
  const [popoverName, setPopoverName] = useState("");
  const [popoverEmoji, setPopoverEmoji] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const pinnedVersion = usePinnedVersionStore((s) => s.version);
  useEffect(() => {
    fetchPinnedNotes().then(setPinnedNotes).catch(() => {});
  }, [activeNoteId, pinnedVersion]);

  // ── Drag-to-reorder (localStorage-backed) ─────────────────────────────
  const spaceOrder = useOrderingStore((s) => s.spaceOrder);
  const pinnedOrder = useOrderingStore((s) => s.pinnedOrder);
  const setSpaceOrder = useOrderingStore((s) => s.setSpaceOrder);
  const setPinnedOrder = useOrderingStore((s) => s.setPinnedOrder);

  // drag state: { kind: "space"|"pinned", fromId: number, overId: number | null }
  const [drag, setDrag] = useState<{ kind: "space" | "pinned"; fromId: number; overId: number | null } | null>(null);

  const orderedSpaces = useMemo(() => {
    const nonGeneral = spaces.filter((s) => s.id !== "general") as { id: number; name: string; emoji: string | null }[];
    return applyOrder(nonGeneral, spaceOrder);
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

  function handleAllNotes() {
    selectSpace("general");
    loadNotes("general");
    onSpaceSelect();
  }

  function handleSelectNote(note: ApiNote) {
    const spaceId = note.space_id == null ? "general" : String(note.space_id);
    selectSpace(spaceId);
    selectNote(note.id);
    loadNotes(spaceId);
    onSpaceSelect();
  }

  function openEditPopover(e: React.MouseEvent, id: number, name: string, emoji: string | null) {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPopoverAnchor({ top: Math.max(rect.top - 8, 8), left: 208 });
    setPopoverName(name);
    setPopoverEmoji(emoji ?? "");
    setDeleteConfirmId(null);
    setPopover({ mode: "edit", id });
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
              fontSize: 15, fontWeight: 700,
              fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
              color: "#1C1C1E", transition: "background 0.1s", outline: "none",
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

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", padding: "4px 0" }}>
          {/* Section: NOTES */}
          <div style={{ padding: "8px 12px 4px" }}>
            <span style={{ fontSize: 10.5, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.5, fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif", userSelect: "none" }}>
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
                fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
                fontWeight: isAllNotes ? 600 : 400, color: "#1C1C1E",
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
                    <span style={{ fontSize: 10.5, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.5, fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif" }}>PINNED</span>
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
                        flex: 1, fontSize: 13,
                        fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
                        fontWeight: selected ? 600 : 400, color: "#1C1C1E",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {note.title?.trim() || "Untitled"}
                      </span>
                      <button
                        className="pin-action"
                        onClick={(e) => { e.stopPropagation(); handleUnpin(note.id); }}
                        title="Unpin"
                        style={{ opacity: 0, background: "none", border: "none", cursor: "pointer", color: "#8E8E93", fontSize: 12, padding: "0 3px", flexShrink: 0 }}
                      >×</button>
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
                <span style={{ fontSize: 10.5, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.5, fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif" }}>SPACES</span>
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
                  <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, flexShrink: 0 }}>
                    <SpaceIcon emoji={space.emoji} size={14} />
                  </span>
                  <span style={{ flex: 1, fontSize: 13, fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif", fontWeight: isSelected ? 600 : 400, color: "#1C1C1E", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {space.name}
                  </span>
                  {isDelConfirm ? (
                    <button className="space-action" onClick={(e) => { e.stopPropagation(); confirmDelete(space.id as number); }}
                      style={{ opacity: 1, background: "none", border: "none", cursor: "pointer", color: "#FF3B30", fontSize: 10.5, padding: "0 3px", flexShrink: 0, fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif" }}>
                      sure?
                    </button>
                  ) : (
                    <>
                      <button className="space-action" onClick={(e) => openEditPopover(e, space.id as number, space.name, space.emoji)}
                        style={{ opacity: 0, background: "none", border: "none", cursor: "pointer", color: "#8E8E93", fontSize: 11, padding: "0 2px", flexShrink: 0 }} title="Rename">✎</button>
                      <button className="space-action" onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(space.id as number); }}
                        style={{ opacity: 0, background: "none", border: "none", cursor: "pointer", color: "#8E8E93", fontSize: 11, padding: "0 2px", flexShrink: 0 }} title="Delete">×</button>
                    </>
                  )}
                </div>
              );
            })}
          </div>

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
                fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
                fontWeight: isChat ? 600 : 400, fontSize: 13.5, color: "#1C1C1E",
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
              onClick={() => navigate({ to: "/memories" })}
              title="Memory dashboard"
              style={{
                display: "flex", alignItems: "center", gap: 8,
                width: "100%", padding: "0 10px", height: 32, borderRadius: 8,
                border: "none", background: "transparent", cursor: "pointer",
                textAlign: "left",
                fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
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

          {/* Chat audit — every Gooni reply + any feedback Daniel gave inline. */}
          <div style={{ padding: "0 6px 2px" }}>
            <button
              onClick={() => navigate({ to: "/chat-audit" })}
              title="Chat audit"
              style={{
                display: "flex", alignItems: "center", gap: 8,
                width: "100%", padding: "0 10px", height: 32, borderRadius: 8,
                border: "none", background: "transparent", cursor: "pointer",
                textAlign: "left",
                fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
                fontSize: 13.5, color: "#3C3C43",
                transition: "background 0.12s",
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
            >
              <ClipboardList size={14} strokeWidth={1.7} color={ICON_TINT.chatAudit} style={{ flexShrink: 0 }} />
              Chat audit
            </button>
          </div>

          {/* Dev tools — sits directly above Settings */}
          <div style={{ padding: "0 6px 2px" }}>
            <button
              onClick={() => setDevToolsOpen(true)}
              title="Dev tools"
              style={{
                display: "flex", alignItems: "center", gap: 8,
                width: "100%", padding: "0 10px", height: 32, borderRadius: 8,
                border: "none", background: "transparent", cursor: "pointer",
                textAlign: "left",
                fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
                fontSize: 13.5, color: "#3C3C43",
                transition: "background 0.12s",
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
            >
              <Bug size={14} strokeWidth={1.7} color={ICON_TINT.devTools} style={{ flexShrink: 0 }} />
              Dev tools
            </button>
          </div>

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
                fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
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
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <DevToolsModal open={devToolsOpen} onClose={() => setDevToolsOpen(false)} />

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
