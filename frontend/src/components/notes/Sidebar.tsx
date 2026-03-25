import { useEffect, useState } from "react";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useConversationsStore } from "../../stores/useConversationsStore";
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

  const [recentNotes, setRecentNotes] = useState<ApiNote[]>([]);

  useEffect(() => {
    fetchRecentNotes(5).then(setRecentNotes).catch(() => {});
  }, []);

  function handleAllNotes() {
    selectSpace("general");
    loadNotes("general");
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

  const isAllNotes = selectedSpaceId === "general" || selectedSpaceId === null;

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
                  onClick={() => { selectConversation(conv.id); onConversationSelect(); }}
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

        {/* Notes section */}
        <div style={{ padding: "6px 6px 4px" }}>
          {/* All Notes button */}
          <div
            onClick={handleAllNotes}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "0 10px",
              height: 32,
              borderRadius: 8,
              cursor: "pointer",
              background: isAllNotes ? "rgba(0,0,0,0.09)" : "transparent",
              transition: "background 0.12s",
              userSelect: "none",
              marginBottom: 2,
            }}
            onMouseEnter={(e) => { if (!isAllNotes) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.05)"; }}
            onMouseLeave={(e) => { if (!isAllNotes) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
          >
            <span style={{ fontSize: 14, flexShrink: 0 }}>📋</span>
            <span style={{
              flex: 1,
              fontSize: 13.5,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
              fontWeight: isAllNotes ? 600 : 400,
              color: "#1C1C1E",
            }}>
              All Notes
            </span>
          </div>

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
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      width: "100%",
                      padding: "5px 10px",
                      borderRadius: 8,
                      border: "none",
                      background: selected ? "rgba(0,0,0,0.08)" : "transparent",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)"; }}
                    onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                  >
                    <span style={{
                      fontSize: 13,
                      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
                      fontWeight: selected ? 600 : 400,
                      color: "#1C1C1E",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      width: "100%",
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

      </div>{/* end scrollable content */}
    </div>
  );
}
