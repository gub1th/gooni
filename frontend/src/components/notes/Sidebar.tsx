import { useRef, useState } from "react";
import { useSpacesStore } from "../../stores/useSpacesStore";
import { useNotesContentStore } from "../../stores/useNotesContentStore";

export function Sidebar() {
  const { spaces, create: createSpace } = useSpacesStore();
  const { selectedSpaceId, selectSpace, loadNotes } = useNotesContentStore();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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

  const allSpaces = [
    { id: "general", name: "General" },
    ...spaces.filter((s) => s.id !== "general").map((s) => ({ id: String(s.id), name: s.name })),
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
      {/* Header — matches NotesList header height */}
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
        <span
          style={{
            fontSize: 15,
            fontWeight: 700,
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
            color: "#1C1C1E",
          }}
        >
          Gooni
        </span>
        <button
          onClick={startAdding}
          title="New space"
          style={{
            width: 26,
            height: 26,
            borderRadius: "50%",
            background: "rgba(0,0,0,0.06)",
            border: "none",
            cursor: "pointer",
            fontSize: 18,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#1C1C1E",
            padding: 0,
            flexShrink: 0,
            transition: "background 0.1s ease",
          }}
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
            style={{
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
        </div>
      )}

      {/* Spaces list */}
      <div style={{ padding: "6px 6px", flex: 1, overflowY: "auto" }}>
        {allSpaces.map((space) => {
          const selected = selectedSpaceId === space.id;
          return (
            <div
              key={space.id}
              onClick={() => handleSelectSpace(space.id)}
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
              onMouseEnter={(e) => {
                if (!selected) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.05)";
              }}
              onMouseLeave={(e) => {
                if (!selected) (e.currentTarget as HTMLDivElement).style.background = "transparent";
              }}
            >
              <span style={{ fontSize: 14, flexShrink: 0 }}>
                {space.id === "general" ? "📥" : "🗂️"}
              </span>
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
