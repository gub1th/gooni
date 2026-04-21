import { useEffect, useRef, useState } from "react";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useConversationsStore } from "../../stores/useConversationsStore";
import { useSpacesStore } from "../../stores/useSpacesStore";
import { fetchPinnedNotes, patchNote, type ApiNote } from "../../services/api";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function ComposeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M11 1.5L13.5 4L6.5 11H4V8.5L11 1.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none"/>
      <path d="M2 13.5H13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  );
}

function DragHandle() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="none" style={{ flexShrink: 0 }}>
      {[0, 4, 8].map((y) => (
        <g key={y}>
          <circle cx="2.5" cy={y + 3} r="1.2" fill="#C7C7CC" />
          <circle cx="7.5" cy={y + 3} r="1.2" fill="#C7C7CC" />
        </g>
      ))}
    </svg>
  );
}

const COMMON_EMOJIS = [
  "📁","📂","🗂️","📝","📋","📌","📎","🔖",
  "🏷️","⭐","🌟","💫","🎯","🎨","🎭","💡",
  "🔑","🔒","🔧","🔨","⚙️","🛠️","💼","🗃️",
  "📊","📈","📅","🏠","🌐","💻","📱","🎮",
  "📚","📖","✏️","🖊️","💰","🌱","🌿","🍀",
  "🔥","❤️","🎵","🏋️","🧠","🚀","⚡","🎁",
];

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
      {/* Backdrop */}
      <div style={{ position: "fixed", inset: 0, zIndex: 99 }} onClick={onCancel} />

      {/* Popover */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed", top: anchor.top, left: anchor.left,
          zIndex: 100, background: "#fff", borderRadius: 10,
          boxShadow: "0 4px 24px rgba(0,0,0,0.18), 0 1px 4px rgba(0,0,0,0.08)",
          padding: "12px 12px 10px", width: 228,
        }}
      >
        {/* Emoji button + name input */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: pickerOpen ? 8 : 10 }}>
          <button
            onClick={() => setPickerOpen((o) => !o)}
            title="Pick emoji"
            style={{
              width: 32, height: 32, borderRadius: 6,
              border: `1px solid ${pickerOpen ? "rgba(0,0,0,0.18)" : "rgba(0,0,0,0.1)"}`,
              background: "#F2F2F7", cursor: "pointer", fontSize: 16,
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0, outline: "none", transition: "border-color 0.1s",
            }}
          >
            {emoji || "🗂️"}
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

        {/* Emoji grid */}
        {pickerOpen && (
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(8, 1fr)",
            gap: 1, marginBottom: 10,
            padding: "6px 0 2px",
            borderTop: "1px solid rgba(0,0,0,0.07)",
          }}>
            {COMMON_EMOJIS.map((e) => (
              <button
                key={e}
                onClick={() => { onEmojiChange(e); setPickerOpen(false); }}
                style={{
                  background: emoji === e ? "rgba(0,0,0,0.08)" : "transparent",
                  border: "none", borderRadius: 4, cursor: "pointer",
                  fontSize: 15, padding: "4px 2px",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                {e}
              </button>
            ))}
          </div>
        )}

        {/* Save / Cancel */}
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

type SectionId = "notes" | "chat";

function getSavedOrder(): SectionId[] {
  try {
    const saved = localStorage.getItem("gooni-sidebar-order");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length === 2) return parsed;
    }
  } catch {}
  return ["notes", "chat"];
}

interface SidebarProps {
  isDashboard: boolean;
  isNotes: boolean;
  showCompose: boolean;
  onLogoClick: () => void;
  onSpaceSelect: () => void;
  onCompose: () => void;
  onNewChat: () => void;
  onConversationSelect: () => void;
}

export function Sidebar({ isDashboard, isNotes, showCompose, onLogoClick, onSpaceSelect, onCompose, onNewChat, onConversationSelect }: SidebarProps) {
  const { selectedSpaceId, selectSpace, loadNotes, selectNote, activeNoteId, removeSpace } = useNotesContentStore();
  const { conversations, activeId, selectConversation } = useConversationsStore();
  const { spaces, createSpace, updateSpace, deleteSpace } = useSpacesStore();

  const [pinnedNotes, setPinnedNotes] = useState<ApiNote[]>([]);
  const [spacesOpen, setSpacesOpen] = useState(true);
  const [sectionOrder, setSectionOrder] = useState<SectionId[]>(getSavedOrder);

  // Space popover state
  const [popover, setPopover] = useState<PopoverMode>(null);
  const [popoverAnchor, setPopoverAnchor] = useState({ top: 0, left: 208 });
  const [popoverName, setPopoverName] = useState("");
  const [popoverEmoji, setPopoverEmoji] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const [dragOver, setDragOver] = useState<SectionId | null>(null);
  const dragging = useRef<SectionId | null>(null);

  useEffect(() => {
    fetchPinnedNotes().then(setPinnedNotes).catch(() => {});
  }, [activeNoteId]);

  async function handleUnpin(noteId: number) {
    await patchNote(noteId, { is_pinned: false });
    setPinnedNotes((prev) => prev.filter((n) => n.id !== noteId));
  }

  function handleAllNotes() {
    // Always deselect & reload so the click is perceivable even when we're already in All Notes.
    selectSpace("general");
    loadNotes("general");
    onSpaceSelect();
  }

  function handleSelectRecentNote(note: ApiNote) {
    const spaceId = note.space_id == null ? "general" : String(note.space_id);
    selectSpace(spaceId);
    selectNote(note.id); // set eagerly so the editor shows the right note immediately
    loadNotes(spaceId);  // fire-and-forget refresh
    onSpaceSelect();
  }

  function handleDragStart(section: SectionId) {
    dragging.current = section;
  }

  function handleDragOver(e: React.DragEvent, section: SectionId) {
    e.preventDefault();
    if (dragging.current && dragging.current !== section) {
      setDragOver(section);
    }
  }

  function handleDrop(target: SectionId) {
    if (!dragging.current || dragging.current === target) {
      setDragOver(null);
      return;
    }
    const from = sectionOrder.indexOf(dragging.current);
    const to = sectionOrder.indexOf(target);
    const reordered = [...sectionOrder];
    reordered.splice(from, 1);
    reordered.splice(to, 0, dragging.current);
    setSectionOrder(reordered);
    localStorage.setItem("gooni-sidebar-order", JSON.stringify(reordered));
    dragging.current = null;
    setDragOver(null);
  }

  function handleDragEnd() {
    dragging.current = null;
    setDragOver(null);
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

  const notesSection = (
    <div
      key="notes"
      draggable
      onDragStart={() => handleDragStart("notes")}
      onDragOver={(e) => handleDragOver(e, "notes")}
      onDrop={() => handleDrop("notes")}
      onDragEnd={handleDragEnd}
      style={{
        outline: dragOver === "notes" ? "2px solid rgba(0,122,255,0.4)" : "none",
        borderRadius: 8,
        transition: "outline 0.1s",
      }}
    >
      {/* Section header */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "8px 12px 4px", cursor: "grab" }}>
        <DragHandle />
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
          <span style={{ fontSize: 14, flexShrink: 0 }}>📋</span>
          <span style={{
            flex: 1, fontSize: 13.5,
            fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
            fontWeight: isAllNotes ? 600 : 400, color: "#1C1C1E",
          }}>All Notes</span>
        </div>

        {/* Spaces list */}
        <>
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

          {spacesOpen && spaces.filter(s => s.id !== "general").map((space) => {
            const spaceId = String(space.id);
            const isSelected = isNotes && selectedSpaceId === spaceId;
            const isDelConfirm = deleteConfirmId === space.id;

            return (
              <div
                key={space.id}
                style={{ display: "flex", alignItems: "center", gap: 4, padding: "0 4px 0 10px", height: 30, borderRadius: 8, cursor: "pointer", background: isSelected ? "rgba(0,0,0,0.09)" : "transparent", transition: "background 0.12s", userSelect: "none" }}
                onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.05)"; (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLButtonElement>(".space-action").forEach(b => b.style.opacity = "1"); }}
                onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = "transparent"; (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLButtonElement>(".space-action").forEach(b => b.style.opacity = "0"); setDeleteConfirmId(null); }}
                onClick={(e) => { if ((e.target as HTMLElement).closest("button")) return; selectSpace(spaceId); loadNotes(spaceId); onSpaceSelect(); }}
              >
                <span style={{ fontSize: 13, flexShrink: 0 }}>{space.emoji ?? "🗂️"}</span>
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
        </>

        {/* Pinned notes */}
        {pinnedNotes.length > 0 && (
          <>
            <div style={{ padding: "10px 6px 2px" }}>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.5, fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif" }}>PINNED</span>
            </div>
            {pinnedNotes.map((note) => {
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
                  onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.05)"; (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLButtonElement>(".pin-action").forEach(b => b.style.opacity = "1"); }}
                  onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = "transparent"; (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLButtonElement>(".pin-action").forEach(b => b.style.opacity = "0"); }}
                  onClick={(e) => { if ((e.target as HTMLElement).closest("button")) return; handleSelectRecentNote(note); }}
                >
                  <span style={{ fontSize: 11, flexShrink: 0, color: "#FFB020" }}>📌</span>
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
          </>
        )}

      </div>
    </div>
  );

  const chatSection = (
    <div
      key="chat"
      draggable
      onDragStart={() => handleDragStart("chat")}
      onDragOver={(e) => handleDragOver(e, "chat")}
      onDrop={() => handleDrop("chat")}
      onDragEnd={handleDragEnd}
      style={{
        outline: dragOver === "chat" ? "2px solid rgba(0,122,255,0.4)" : "none",
        borderRadius: 8,
        transition: "outline 0.1s",
      }}
    >
      {/* Section header */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "8px 12px 4px", cursor: "grab" }}>
        <DragHandle />
        <span style={{ flex: 1, fontSize: 10.5, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.5, fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif", userSelect: "none" }}>
          CHAT
        </span>
        <button
          onClick={onNewChat}
          title="New chat"
          style={{ background: "none", border: "none", cursor: "pointer", color: "#AEAEB2", fontSize: 16, lineHeight: 1, padding: "0 2px", display: "flex", alignItems: "center" }}
        >+</button>
      </div>

      <div style={{ padding: "0 6px 4px" }}>
        {conversations.slice(0, 5).map((conv) => (
          <button
            key={conv.id}
            onClick={() => { selectConversation(conv.id); onConversationSelect(); }}
            style={{
              display: "flex", flexDirection: "column", alignItems: "flex-start",
              width: "100%", padding: "6px 10px", borderRadius: 8, border: "none",
              background: activeId === conv.id ? "rgba(0,0,0,0.08)" : "transparent",
              cursor: "pointer", textAlign: "left", transition: "background 0.1s",
            }}
            onMouseEnter={(e) => { if (activeId !== conv.id) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)"; }}
            onMouseLeave={(e) => { if (activeId !== conv.id) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            <div style={{
              fontSize: 13,
              fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
              fontWeight: activeId === conv.id ? 600 : 400,
              color: "#1C1C1E", overflow: "hidden", textOverflow: "ellipsis",
              whiteSpace: "nowrap", width: "100%",
            }}>
              {conv.title || "New conversation"}
            </div>
            <div style={{ fontSize: 11, color: "#AEAEB2", marginTop: 1, fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif" }}>
              {relativeTime(conv.last_message_at ?? conv.created_at)}
            </div>
          </button>
        ))}
      </div>
    </div>
  );

  const sections: Record<SectionId, React.ReactNode> = { notes: notesSection, chat: chatSection };

  return (
    <>
      <div
        style={{
          width: 200, minWidth: 200, height: "100vh",
          background: "#F2F2F7", display: "flex", flexDirection: "column",
          borderRight: "1px solid rgba(0,0,0,0.08)", boxSizing: "border-box",
        }}
      >
        {/* Header */}
        <div style={{
          height: 52, padding: "0 12px", display: "flex", alignItems: "center",
          justifyContent: "space-between", flexShrink: 0,
          borderBottom: "1px solid rgba(0,0,0,0.06)",
        }}>
          <button
            onClick={onLogoClick}
            title={isDashboard ? "Back to notes" : "Dashboard"}
            style={{
              background: isDashboard ? "rgba(0,0,0,0.08)" : "transparent",
              border: "none", borderRadius: 6, padding: "3px 7px", cursor: "pointer",
              fontSize: 15, fontWeight: 700,
              fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
              color: "#1C1C1E", transition: "background 0.1s", outline: "none",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = isDashboard ? "rgba(0,0,0,0.12)" : "rgba(0,0,0,0.06)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = isDashboard ? "rgba(0,0,0,0.08)" : "transparent")}
          >
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
              <ComposeIcon />
            </button>
          )}
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", padding: "4px 0" }}>
          {sectionOrder.map((id, i) => (
            <div key={id}>
              {sections[id]}
              {i === 0 && (
                <div style={{ height: 1, background: "rgba(0,0,0,0.07)", margin: "6px 6px 2px" }} />
              )}
            </div>
          ))}
        </div>
      </div>

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
