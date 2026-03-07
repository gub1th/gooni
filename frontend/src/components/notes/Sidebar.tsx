import { useRef, useState } from "react";
import { useNotesStore } from "../../stores/notesStore";
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

function ActivityDots({ days }: { days: boolean[] }) {
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
      {days.slice(-7).map((active, i) => (
        <div
          key={i}
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: active ? "#34C759" : "#D1D1D6",
          }}
        />
      ))}
    </div>
  );
}

export function Sidebar() {
  const { feedEntries, selectedSpaceId, selectSpace } = useNotesStore();
  const { spaces, create: createSpace } = useSpacesStore();
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

  // useSpacesStore already injects General at index 0, with streak data from API
  const allSpaces = spaces.map((s) => ({
    id: String(s.id),
    name: s.name,
    streak: s.streak,
    last7days: s.last_7_days,
  }));

  const totalNotes = Object.values(feedEntries).reduce((acc, arr) => acc + arr.length, 0);

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
            Notes
          </div>
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
        <div
          style={{
            fontSize: 12,
            color: "#8E8E93",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
            marginTop: 1,
          }}
        >
          {totalNotes} notes
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

      {/* Spaces */}
      <div style={{ padding: "4px 6px" }}>
        {allSpaces.map((space) => {
          const selected = selectedSpaceId === space.id;
          const count = feedEntries[space.id]?.length ?? 0;
          return (
            <div
              key={space.id}
              onClick={() => selectSpace(space.id.toString())}
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
                userSelect: "none",
              }}
              onMouseEnter={(e) => {
                if (!selected) (e.currentTarget as HTMLDivElement).style.background = "rgba(0,0,0,0.05)";
              }}
              onMouseLeave={(e) => {
                if (!selected) (e.currentTarget as HTMLDivElement).style.background = "transparent";
              }}
            >
              <div style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
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
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                <ActivityDots days={space.last7days} />
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
