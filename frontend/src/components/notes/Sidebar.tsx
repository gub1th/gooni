import { useRef, useState } from "react";
import { useNotesStore } from "../../stores/notesStore";
import { useJarvisStore } from "../../stores/useJarvisStore";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useSpacesStore } from "../../stores/useSpacesStore";

function TargetIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="9" cy="9" r="7" stroke="#FF453A" strokeWidth="1.3" />
      <circle cx="9" cy="9" r="4" stroke="#FF453A" strokeWidth="1.3" />
      <circle cx="9" cy="9" r="1.5" fill="#FF453A" />
    </svg>
  );
}

export function Sidebar() {
  const { feedEntries, selectedSpaceId, selectSpace } = useNotesStore();
  const { notes, activeNoteId, selectNote, createNote: createNoteInStore } = useNotesContentStore();
  const { isOpen: jarvisOpen, toggle: toggleJarvis } = useJarvisStore();
  const { spaces, create: createSpace } = useSpacesStore();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedSpaceIdForNotes = selectedSpaceId || "general";

  const currentNotes = notes.notes[selectedSpaceIdForNotes] ?? [];

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

  const allSpaces = [
    { id: "general", name: "General", streak: 0, last7days: [] as boolean[] },
    ...spaces.map((s) => ({ ...s, streak: 0, last7days: [] as boolean[] })), // TODO: add streak data to spaces
  ];

  const totalNotes = Object.values(notes.notes).reduce((acc, arr: any) => acc + arr.length, 0);

  return (
    <div
      style={{
        width: 275,
        minWidth: 275,
        height: "100vh",
        background: "#F2F2F7",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        borderRight: "1px solid rgba(0,0,0,0.08)",
        boxSizing: "border-box",
      }}
    >
      {/* Header */}
      <div style={{ padding: "20px 16px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
              color: "#1C1C1E",
            }}
          >
            Gooni
          </div>
          <button
            onClick={toggleJarvis}
            title="Toggle Jarvis"
            style={{
              width: 26,
              height: 26,
              borderRadius: "50%",
              border: "none",
              background: jarvisOpen ? "#34C759" : "transparent",
              color: jarvisOpen ? "#fff" : "#8E8E93",
              cursor: "pointer",
              fontSize: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            💬
          </button>
        </div>
        <div
          style={{
            fontSize: 12,
            color: "#8E8E93",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            marginTop: 1,
          }}
        >
          {totalNotes > 0 ? `${totalNotes} notes` : ""}
        </div>
        {adding && (
          <input
            ref={inputRef}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={submitNewSpace}
            placeholder="Space name..."
            style={{
              marginTop: 8,
              width: "100%",
              boxSizing: "border-box",
              padding: "5px 8px",
              borderRadius: 6,
              border: "1px solid rgba(0,0,0,0.15)",
              fontSize: 13,
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
              outline: "none",
              background: "#fff",
              color: "#1C1C1E",
            }}
          />
        )}
      </div>

      {/* Notes Section */}
      <div style={{ flexShrink: 0, padding: "4px 16px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 13,
            fontWeight: 600,
            color: "#8E8E93",
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            padding: "0 4px",
          }}
        >
          Notes
          <button
            onClick={async () => {
              const newNote = await createNoteInStore(selectedSpaceIdForNotes);
              if (newNote) {
                selectNote(newNote.id);
              }
            }}
            style={{
              padding: "4px 8px",
              border: "none",
              background: "transparent",
              color: "#8E8E93",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            +
          </button>
        </div>
      </div>

      {/* Notes List */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {currentNotes.map((note: any) => (
          <div
            key={note.id}
            onClick={() => selectNote(note.id)}
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid rgba(0,0,0,0.06)",
              background: activeNoteId === note.id ? "rgba(29,155,240,0.04)" : "transparent",
              cursor: "pointer",
              transition: "background 0.1s",
            }}
          >
            <div style={{ fontSize: 15, color: "#0f1419", fontWeight: 500 }}>
              {note.title || "Untitled"}
            </div>
            <div
              style={{
                fontSize: 13,
                color: "#536471",
                marginTop: 4,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                textOverflow: "ellipsis",
                wordBreak: "break-word",
              }}
            >
              {note.content}
            </div>
          </div>
        ))}
      </div>

      {/* Conversations Section */}
      <div style={{ flexShrink: 0, padding: "0 16px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 13,
            fontWeight: 600,
            color: "#8E8E93",
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            padding: "0 4px",
          }}
        >
          Conversations
        </div>
      </div>

      {/* Conversations List */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {feedEntries[selectedSpaceIdForNotes]?.map((entry: any) => (
          <div
            key={entry.id}
            onClick={() => {
              // TODO: Could open expanded view or link out
              console.log("Open conversation:", entry.id);
            }}
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid rgba(0,0,0,0.06)",
              cursor: "pointer",
              transition: "background 0.1s",
            }}
          >
            <div style={{ fontSize: 15, color: "#0f1419", fontWeight: 500 }}>
              💬 {entry.title ?? "Untitled conversation"}
            </div>
          </div>
        ))}
      </div>

      {/* Spaces Section */}
      <div style={{ flexShrink: 0, padding: "0 16px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 13,
            fontWeight: 600,
            color: "#8E8E93",
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            padding: "0 4px",
          }}
        >
          Spaces
          <button
            onClick={startAdding}
            style={{
              padding: "4px 8px",
              border: "none",
              background: "transparent",
              color: "#8E8E93",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            +
          </button>
        </div>
      </div>

      {/* Spaces List */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {allSpaces.map((space) => {
          const selected = selectedSpaceId === space.id;
          const count = feedEntries[space.id]?.length ?? 0;
          return (
            <div
              key={space.id}
              onClick={() => selectSpace(String(space.id))}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 10px",
                height: 34,
                borderRadius: 8,
                cursor: "pointer",
                background: selected ? "rgba(0,0,0,0.09)" : "transparent",
                transition: "background 0.12s",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                {space.id === "general" ? (
                  <span style={{ fontSize: 16 }}>📥</span>
                ) : (
                  <TargetIcon />
                )}
              </div>
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
              <span
                style={{
                  fontSize: 13,
                  fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
                  color: "#8E8E93",
                  minWidth: 16,
                  textAlign: "right",
                }}
              >
                {count > 0 ? count : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
