import { useEffect, useRef, useState } from "react";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useConversationsStore } from "../../stores/useConversationsStore";
import { useSpacesStore } from "../../stores/useSpacesStore";
import { fetchRecentNotes, type ApiNote } from "../../services/api";

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
  showCompose: boolean;
  onLogoClick: () => void;
  onSpaceSelect: () => void;
  onCompose: () => void;
  onNewChat: () => void;
  onConversationSelect: () => void;
}

export function Sidebar({ isDashboard, showCompose, onLogoClick, onSpaceSelect, onCompose, onNewChat, onConversationSelect }: SidebarProps) {
  const { selectedSpaceId, selectSpace, loadNotes, selectNote, activeNoteId } = useNotesContentStore();
  const { conversations, activeId, selectConversation } = useConversationsStore();
  const { spaces } = useSpacesStore();

  const [recentNotes, setRecentNotes] = useState<ApiNote[]>([]);
  const [spacesOpen, setSpacesOpen] = useState(true);
  const [sectionOrder, setSectionOrder] = useState<SectionId[]>(getSavedOrder);
  const [dragOver, setDragOver] = useState<SectionId | null>(null);
  const dragging = useRef<SectionId | null>(null);

  useEffect(() => {
    fetchRecentNotes(5).then(setRecentNotes).catch(() => {});
  }, []);

  function handleAllNotes() {
    if (selectedSpaceId !== "general" && selectedSpaceId !== null) {
      selectSpace("general");
      loadNotes("general");
    }
    onSpaceSelect();
  }

  function handleSelectRecentNote(note: ApiNote) {
    const spaceId = note.space_id == null ? "general" : String(note.space_id);
    selectSpace(spaceId);
    loadNotes(spaceId).then(() => {
      selectNote(note.id);
    });
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
    // preserve the original positions: put dragged item where target was
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

  const isAllNotes = !isDashboard && (selectedSpaceId === "general" || selectedSpaceId === null);

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
        <span style={{ fontSize: 10.5, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.5, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif", userSelect: "none" }}>
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
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            fontWeight: isAllNotes ? 600 : 400, color: "#1C1C1E",
          }}>All Notes</span>
        </div>

        {/* Spaces list */}
        {spaces.length > 1 && (
          <>
            <button
              onClick={() => setSpacesOpen((o) => !o)}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "6px 6px 2px", background: "none", border: "none",
                cursor: "pointer", width: "100%", textAlign: "left",
              }}
            >
              <span style={{ fontSize: 10.5, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.5, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>
                SPACES
              </span>
              <span style={{ fontSize: 9, color: "#AEAEB2", marginLeft: "auto" }}>{spacesOpen ? "▾" : "▸"}</span>
            </button>
            {spacesOpen && spaces.filter(s => s.id !== "general").map((space) => {
              const spaceId = String(space.id);
              const isSelected = !isDashboard && selectedSpaceId === spaceId;
              return (
                <div
                  key={space.id}
                  onClick={() => { if (spaceId !== selectedSpaceId) { selectSpace(spaceId); loadNotes(spaceId); } onSpaceSelect(); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "0 10px", height: 30, borderRadius: 8,
                    cursor: "pointer",
                    background: isSelected ? "rgba(0,0,0,0.09)" : "transparent",
                    transition: "background 0.12s", userSelect: "none",
                  }}
                  onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.05)"; }}
                  onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
                >
                  <span style={{ fontSize: 13, flexShrink: 0 }}>{space.emoji ?? "🗂️"}</span>
                  <span style={{
                    flex: 1, fontSize: 13,
                    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
                    fontWeight: isSelected ? 600 : 400, color: "#1C1C1E",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {space.name}
                  </span>
                </div>
              );
            })}
          </>
        )}

        {/* Recent notes */}
        {recentNotes.length > 0 && (
          <>
            <div style={{ padding: "6px 6px 2px" }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#8E8E93", letterSpacing: 0.5, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>RECENT</span>
            </div>
            {recentNotes.map((note) => {
              const selected = activeNoteId === note.id;
              return (
                <button
                  key={note.id}
                  onClick={() => handleSelectRecentNote(note)}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "flex-start",
                    width: "100%", padding: "5px 10px", borderRadius: 8, border: "none",
                    background: selected ? "rgba(0,0,0,0.08)" : "transparent",
                    cursor: "pointer", textAlign: "left", transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)"; }}
                  onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                >
                  <span style={{
                    fontSize: 13,
                    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
                    fontWeight: selected ? 600 : 400, color: "#1C1C1E",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%",
                  }}>
                    {note.title || "Untitled"}
                  </span>
                  <span style={{ fontSize: 11, color: "#AEAEB2", marginTop: 1, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>
                    {relativeTime(note.updated_at)}
                  </span>
                </button>
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
        <span style={{ fontSize: 10.5, fontWeight: 600, color: "#AEAEB2", letterSpacing: 0.5, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif", userSelect: "none" }}>
          CHAT
        </span>
      </div>

      <div style={{ padding: "0 6px 4px" }}>
        <button
          onClick={onNewChat}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            margin: "0 0 4px", padding: "7px 10px", borderRadius: 8, border: "none",
            background: "transparent", color: "#1C1C1E", fontSize: 13,
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            fontWeight: 500, cursor: "pointer", width: "100%", textAlign: "left",
            transition: "background 0.1s", outline: "none",
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
        >
          + New Chat
        </button>

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
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
              fontWeight: activeId === conv.id ? 600 : 400,
              color: "#1C1C1E", overflow: "hidden", textOverflow: "ellipsis",
              whiteSpace: "nowrap", width: "100%",
            }}>
              {conv.title || "New conversation"}
            </div>
            <div style={{ fontSize: 11, color: "#AEAEB2", marginTop: 1, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>
              {relativeTime(conv.last_message_at ?? conv.created_at)}
            </div>
          </button>
        ))}
      </div>
    </div>
  );

  const sections: Record<SectionId, React.ReactNode> = { notes: notesSection, chat: chatSection };

  return (
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
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
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
  );
}
