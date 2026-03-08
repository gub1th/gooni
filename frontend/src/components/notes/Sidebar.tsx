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
  const [showConversations, setShowConversations] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentSpaceId = selectedSpaceId || "general";
  const currentNotes = notes[currentSpaceId] ?? [];

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

  const allSpaces = spaces;

  return (
    <div style={{ width: 275, minWidth: 275, height: "100vh", background: "#F2F2F7", display: "flex", flexDirection: "column", borderRight: "1px solid rgba(0,0,0,0.08)" }}>
      <div style={{ padding: "20px 16px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#1C1C1E" }}>Gooni</div>
          <button onClick={toggleJarvis} title="Toggle Jarvis" style={{ width: 26, height: 26, borderRadius: "50%", border: "none", background: jarvisOpen ? "#34C759" : "transparent", cursor: "pointer" }}>
            💬
          </button>
        </div>
      </div>

      <div style={{ padding: "4px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600, color: "#8E8E93", textTransform: "uppercase" }}>
          Notes
          <button
            onClick={async () => {
              const newNote = await createNoteInStore(currentSpaceId);
              if (newNote) selectNote(newNote.id);
            }}
            style={{ border: "none", background: "transparent", cursor: "pointer" }}
          >
            +
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {currentNotes.map((note) => (
          <div key={note.id} onClick={() => selectNote(note.id)} style={{ padding: "10px 16px", background: activeNoteId === note.id ? "rgba(29,155,240,0.08)" : "transparent", cursor: "pointer" }}>
            <div style={{ fontSize: 14, fontWeight: 500 }}>{note.title || "Untitled"}</div>
          </div>
        ))}
      </div>

      <div style={{ padding: "0 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600, color: "#8E8E93", textTransform: "uppercase" }}>
          Conversations
          <button onClick={() => setShowConversations((v) => !v)} style={{ border: "none", background: "transparent", cursor: "pointer" }}>
            {showConversations ? "˅" : ">"}
          </button>
        </div>
      </div>

      {showConversations && (
        <div style={{ maxHeight: 180, overflowY: "auto" }}>
          {(feedEntries[currentSpaceId] ?? []).map((entry) => (
            <div key={entry.id} style={{ padding: "8px 16px", fontSize: 13, color: "#333" }}>
              💬 {entry.title ?? "Untitled conversation"}
            </div>
          ))}
        </div>
      )}

      <div style={{ padding: "8px 16px 0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600, color: "#8E8E93", textTransform: "uppercase" }}>
          Spaces
          <button onClick={startAdding} style={{ border: "none", background: "transparent", cursor: "pointer" }}>+</button>
        </div>
        {adding && (
          <input
            ref={inputRef}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={submitNewSpace}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitNewSpace();
              if (e.key === "Escape") setAdding(false);
            }}
            placeholder="Space name..."
            style={{ marginTop: 8, width: "100%" }}
          />
        )}
      </div>

      <div style={{ padding: "8px 8px 12px", overflowY: "auto" }}>
        {allSpaces.map((space) => {
          const selected = currentSpaceId === String(space.id);
          return (
            <div key={space.id} onClick={() => selectSpace(String(space.id))} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px", borderRadius: 8, cursor: "pointer", background: selected ? "rgba(0,0,0,0.09)" : "transparent" }}>
              {space.id === "general" ? <span>📥</span> : <TargetIcon />}
              <span style={{ fontSize: 13.5, fontWeight: selected ? 600 : 400 }}>{space.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
