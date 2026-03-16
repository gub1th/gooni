import { useEffect, useRef, useState } from "react";
import { EmojiPicker } from "../EmojiPicker";
import { useSpacesStore } from "../../stores/useSpacesStore";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useGoalsStore } from "../../stores/useGoalsStore";
import { useConversationsStore } from "../../stores/useConversationsStore";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface ContextMenu {
  x: number;
  y: number;
  spaceId: string;
  spaceName: string;
  confirming: boolean;
}

interface SidebarProps {
  isDashboard: boolean;
  showCompose: boolean;
  onLogoClick: () => void;
  onSpaceSelect: () => void;
  onGoalSelect: () => void;
  onCompose: () => void;
  onNewChat: () => void;
}

function ComposeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M11 1.5L13.5 4L6.5 11H4V8.5L11 1.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none"/>
      <path d="M2 13.5H13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  );
}

export function Sidebar({ isDashboard, showCompose, onLogoClick, onSpaceSelect, onGoalSelect, onCompose, onNewChat }: SidebarProps) {
  const { spaces, create: createSpace, remove: removeSpace, rename: renameSpace, setEmoji } = useSpacesStore();
  const { selectedSpaceId, selectSpace, loadNotes, removeSpace: clearSpaceNotes, moveNote } = useNotesContentStore();
  const { goals, create: createGoal, selectedGoalId, selectGoal } = useGoalsStore();
  const { conversations, activeId, selectConversation } = useConversationsStore();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [addingGoal, setAddingGoal] = useState(false);
  const [newGoalName, setNewGoalName] = useState("");
  const goalInputRef = useRef<HTMLInputElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [emojiPicker, setEmojiPicker] = useState<{ spaceId: string; anchor: DOMRect } | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
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
    selectGoal(null);
    selectSpace(id);
    loadNotes(id);
    onSpaceSelect();
  }

  function startAddingGoal() {
    setAddingGoal(true);
    setNewGoalName("");
    setTimeout(() => goalInputRef.current?.focus(), 0);
  }

  async function submitNewGoal() {
    const name = newGoalName.trim();
    if (name) {
      const goal = await createGoal(name);
      if (goal) {
        selectSpace(null);
        selectGoal(goal.id);
        onGoalSelect();
      }
    }
    setAddingGoal(false);
    setNewGoalName("");
  }

  function handleGoalKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") submitNewGoal();
    if (e.key === "Escape") { setAddingGoal(false); setNewGoalName(""); }
  }

  function handleSelectGoal(id: number) {
    selectSpace(null);
    selectGoal(id);
    onGoalSelect();
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
        <button
          onClick={onLogoClick}
          title={isDashboard ? "Back to notes" : "Dashboard"}
          style={{
            background: isDashboard ? "rgba(0,0,0,0.08)" : "transparent",
            border: "none",
            borderRadius: 6,
            padding: "3px 7px",
            cursor: "pointer",
            fontSize: 15,
            fontWeight: 700,
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
            color: "#1C1C1E",
            transition: "background 0.1s",
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
            style={{ width: 30, height: 30, borderRadius: 8, background: "rgba(0,0,0,0.06)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#3C3C43", padding: 0, flexShrink: 0, transition: "background 0.1s" }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.12)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
          >
            <ComposeIcon />
          </button>
        )}
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>

      {/* Conversations section */}
      <>
        <button
            onClick={onNewChat}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              margin: "10px 6px 4px",
              padding: "7px 10px",
              borderRadius: 8,
              border: "none",
              background: "rgba(0,0,0,0.06)",
              color: "#1C1C1E",
              fontSize: 13,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
              fontWeight: 500,
              cursor: "pointer",
              width: "calc(100% - 12px)",
              textAlign: "left",
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.10)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
          >
            + New Chat
          </button>

          {conversations.length > 0 && (
            <div style={{ marginBottom: 4, padding: "0 6px" }}>
              {conversations.slice(0, 5).map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => selectConversation(conv.id)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    width: "100%",
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: "none",
                    background: activeId === conv.id ? "rgba(0,0,0,0.08)" : "transparent",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => {
                    if (activeId !== conv.id)
                      (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)";
                  }}
                  onMouseLeave={(e) => {
                    if (activeId !== conv.id)
                      (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                  }}
                >
                  <div
                    style={{
                      fontSize: 13,
                      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
                      fontWeight: activeId === conv.id ? 600 : 400,
                      color: "#1C1C1E",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      width: "100%",
                    }}
                  >
                    {conv.title || "New conversation"}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "#AEAEB2",
                      marginTop: 1,
                      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
                    }}
                  >
                    {relativeTime(conv.last_message_at ?? conv.created_at)}
                  </div>
                </button>
              ))}
            </div>
          )}

          <div style={{ height: 1, background: "rgba(0,0,0,0.07)", margin: "4px 6px 8px" }} />
      </>

      {/* Goals section */}
      <div style={{ padding: "10px 6px 4px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 6px", marginBottom: 2 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "#8E8E93", letterSpacing: 0.5, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>GOALS</span>
          <button
            onClick={startAddingGoal}
            title="Add goal"
            style={{ width: 20, height: 20, borderRadius: "50%", background: "transparent", border: "none", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", color: "#8E8E93", padding: 0 }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#1C1C1E")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#8E8E93")}
          >+</button>
        </div>
        {addingGoal && (
          <div style={{ padding: "4px 4px" }}>
            <input
              ref={goalInputRef}
              value={newGoalName}
              onChange={(e) => setNewGoalName(e.target.value)}
              onKeyDown={handleGoalKeyDown}
              onBlur={submitNewGoal}
              placeholder="Goal name..."
              style={{ width: "100%", boxSizing: "border-box", padding: "5px 8px", borderRadius: 6, border: "1px solid rgba(0,0,0,0.15)", fontSize: 13, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif", outline: "none", background: "#fff", color: "#1C1C1E" }}
            />
          </div>
        )}
        {goals.map((goal) => {
          const selected = selectedGoalId === goal.id;
          return (
            <div
              key={goal.id}
              onClick={() => handleSelectGoal(goal.id)}
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
              <span style={{ fontSize: 14, flexShrink: 0 }}>{goal.goal_type === "avoid" ? "🚫" : "🎯"}</span>
              <span style={{
                flex: 1,
                fontSize: 13.5,
                fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
                fontWeight: selected ? 600 : 400,
                color: "#1C1C1E",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {goal.title}
              </span>
            </div>
          );
        })}
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: "rgba(0,0,0,0.07)", margin: "4px 12px 4px" }} />

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

      {/* Spaces section label */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 12px 2px" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#8E8E93", letterSpacing: 0.5, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>SPACES</span>
        <button
          onClick={startAdding}
          title="Add space"
          style={{ width: 20, height: 20, borderRadius: "50%", background: "transparent", border: "none", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", color: "#8E8E93", padding: 0 }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#1C1C1E")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#8E8E93")}
        >+</button>
      </div>

      {/* Spaces list */}
      <div style={{ padding: "2px 6px", flex: 1 }}>
        {allSpaces.map((space) => {
          const selected = selectedSpaceId === space.id;
          const isEditing = editingId === space.id;
          return (
            <div
              key={space.id}
              onClick={() => { if (!isEditing) handleSelectSpace(space.id); }}
              onDoubleClick={() => { if (space.deletable) startEditing(space); }}
              onContextMenu={(e) => handleContextMenu(e, space)}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
              onDragEnter={(e) => { e.preventDefault(); setDragOverId(space.id); }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverId(null);
                try {
                  const data = JSON.parse(e.dataTransfer.getData("text/plain"));
                  if (data.noteId && data.fromSpaceId !== space.id) {
                    moveNote(data.noteId, data.fromSpaceId, space.id);
                  }
                } catch {}
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 10px",
                height: 32,
                borderRadius: 8,
                cursor: "pointer",
                background: dragOverId === space.id
                  ? "rgba(0,122,255,0.12)"
                  : selected ? "rgba(0,0,0,0.09)" : "transparent",
                outline: dragOverId === space.id ? "2px solid rgba(0,122,255,0.35)" : "none",
                outlineOffset: -2,
                transition: "background 0.12s",
                userSelect: "none",
              }}
              onMouseEnter={(e) => { if (!selected && dragOverId !== space.id) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.05)"; }}
              onMouseLeave={(e) => { if (!selected && dragOverId !== space.id) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
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

      </div>{/* end scrollable content */}

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
