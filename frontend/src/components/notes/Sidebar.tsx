import { useEffect, useRef, useState } from "react";
import { EmojiPicker } from "../EmojiPicker";
import { useSpacesStore } from "../../stores/useSpacesStore";
import { useNotesContentStore } from "../../stores/useNotesContentStore";

interface ContextMenu {
  x: number;
  y: number;
  spaceId: string;
  spaceName: string;
  confirming: boolean;
}

export function Sidebar() {
  const { spaces, create: createSpace, remove: removeSpace, rename: renameSpace, setEmoji } = useSpacesStore();
  const { selectedSpaceId, selectSpace, loadNotes, removeSpace: clearSpaceNotes } = useNotesContentStore();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [emojiPicker, setEmojiPicker] = useState<{ spaceId: string; anchor: DOMRect } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  function startAdding() {
    setAdding(true);
    setNewName("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function submitNewSpace() {
    const name = newName.trim();
    if (name) await createSpace(name);
    setAdding(false);
    setNewName("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") submitNewSpace();
    if (e.key === "Escape") { setAdding(false); setNewName(""); }
  }

  function handleSelectSpace(id: string) {
    selectSpace(id);
    loadNotes(id);
  }

  function startEditing(space: { id: string; name: string }) {
    setEditingId(space.id);
    setEditingName(space.name);
    setTimeout(() => editInputRef.current?.select(), 0);
  }

  async function submitRename() {
    if (!editingId) return;
    const name = editingName.trim();
    if (name) await renameSpace(parseInt(editingId), name);
    setEditingId(null);
  }

  function handleEditKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") { e.preventDefault(); submitRename(); }
    if (e.key === "Escape") setEditingId(null);
  }

  function handleContextMenu(e: React.MouseEvent, space: { id: string; name: string; deletable: boolean }) {
    if (!space.deletable) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, spaceId: space.id, spaceName: space.name, confirming: false });
  }

  async function handleDelete() {
    if (!contextMenu) return;
    if (!contextMenu.confirming) {
      setContextMenu({ ...contextMenu, confirming: true });
      return;
    }
    const { spaceId } = contextMenu;
    setContextMenu(null);
    clearSpaceNotes(spaceId);
    await removeSpace(parseInt(spaceId));
  }

  const allSpaces = [
    { id: "general", name: "General", emoji: null as string | null, deletable: false },
    ...spaces.filter((s) => s.id !== "general").map((s) => ({
      id: String(s.id),
      name: s.name,
      emoji: s.emoji,
      deletable: true,
    })),
  ];

  return (
    <div
      style={{
        width: 200,
        minWidth: 200,
        height: "100vh",
        background: "#F2F2F7",
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid rgba(0,0,0,0.08)",
        boxSizing: "border-box",
      }}
    >
      {/* Header */}
      <div
        style={{
          height: 52,
          padding: "0 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
          borderBottom: "1px solid rgba(0,0,0,0.06)",
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 700, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif", color: "#1C1C1E" }}>
          Gooni
        </span>
        <button
          onClick={startAdding}
          title="New space"
          style={{ width: 26, height: 26, borderRadius: "50%", background: "rgba(0,0,0,0.06)", border: "none", cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", color: "#1C1C1E", padding: 0, flexShrink: 0, transition: "background 0.1s" }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.12)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
        >
          +
        </button>
      </div>

      {/* New space input */}
      {adding && (
        <div style={{ padding: "8px 12px" }}>
          <input
            ref={inputRef}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={submitNewSpace}
            placeholder="Space name..."
            style={{ width: "100%", boxSizing: "border-box", padding: "5px 8px", borderRadius: 6, border: "1px solid rgba(0,0,0,0.15)", fontSize: 13, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif", outline: "none", background: "#fff", color: "#1C1C1E" }}
          />
        </div>
      )}

      {/* Spaces list */}
      <div style={{ padding: "6px 6px", flex: 1, overflowY: "auto" }}>
        {allSpaces.map((space) => {
          const selected = selectedSpaceId === space.id;
          const isEditing = editingId === space.id;
          return (
            <div
              key={space.id}
              onClick={() => { if (!isEditing) handleSelectSpace(space.id); }}
              onDoubleClick={() => { if (space.deletable) startEditing(space); }}
              onContextMenu={(e) => handleContextMenu(e, space)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 10px",
                height: 32,
                borderRadius: 8,
                cursor: "pointer",
                background: selected ? "rgba(0,0,0,0.09)" : "transparent",
                transition: "background 0.12s",
                userSelect: "none",
              }}
              onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.05)"; }}
              onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
            >
              <span
                title={space.deletable ? "Double-click to change emoji" : undefined}
                onDoubleClick={(e) => {
                  if (!space.deletable) return;
                  e.stopPropagation();
                  setEmojiPicker({ spaceId: space.id, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() });
                }}
                style={{ fontSize: 14, flexShrink: 0, cursor: space.deletable ? "pointer" : "default" }}
              >
                {space.id === "general" ? "📥" : (space.emoji ?? "🗂️")}
              </span>
              {isEditing ? (
                <input
                  ref={editInputRef}
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onKeyDown={handleEditKeyDown}
                  onBlur={submitRename}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    flex: 1,
                    fontSize: 13.5,
                    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
                    fontWeight: selected ? 600 : 400,
                    color: "#1C1C1E",
                    border: "none",
                    outline: "1px solid rgba(0,122,255,0.5)",
                    borderRadius: 3,
                    background: "#fff",
                    padding: "1px 4px",
                    minWidth: 0,
                  }}
                />
              ) : (
                <span
                  style={{
                    flex: 1,
                    fontSize: 13.5,
                    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
                    fontWeight: selected ? 600 : 400,
                    color: "#1C1C1E",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {space.name}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Emoji picker */}
      {emojiPicker && (
        <EmojiPicker
          anchorRect={emojiPicker.anchor}
          onSelect={(emoji) => setEmoji(parseInt(emojiPicker.spaceId), emoji)}
          onClose={() => setEmojiPicker(null)}
        />
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 1000,
            background: "#FFFFFF",
            borderRadius: 10,
            boxShadow: "0 4px 24px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.06)",
            padding: 6,
            minWidth: 160,
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
          }}
        >
          {!contextMenu.confirming ? (
            <button
              onClick={handleDelete}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 10px", border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, fontSize: 13.5, color: "#FF3B30", textAlign: "left" }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(255,59,48,0.08)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
            >
              🗑 Delete Space
            </button>
          ) : (
            <div style={{ padding: "6px 10px" }}>
              <div style={{ fontSize: 13, color: "#1C1C1E", marginBottom: 4, fontWeight: 500 }}>
                Delete "{contextMenu.spaceName}"?
              </div>
              <div style={{ fontSize: 12, color: "#8E8E93", marginBottom: 8 }}>
                All notes will be deleted.
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={handleDelete}
                  style={{ flex: 1, padding: "5px 0", borderRadius: 6, border: "none", background: "#FF3B30", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                >
                  Delete
                </button>
                <button
                  onClick={() => setContextMenu(null)}
                  style={{ flex: 1, padding: "5px 0", borderRadius: 6, border: "none", background: "rgba(0,0,0,0.07)", color: "#1C1C1E", fontSize: 13, cursor: "pointer" }}
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
