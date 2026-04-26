import { useState, useEffect } from "react";
import { useFocusesStore } from "../stores/useFocusesStore";
import type { ApiFocus, FocusStatus } from "../services/api";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";

const STATUS_COLORS: Record<FocusStatus, { bg: string; fg: string }> = {
  committed: { bg: "rgba(74, 222, 128, 0.15)", fg: "#16A34A" },
  pending: { bg: "rgba(250, 204, 21, 0.15)", fg: "#A16207" },
  someday: { bg: "rgba(148, 163, 184, 0.18)", fg: "#475569" },
  done: { bg: "rgba(99, 102, 241, 0.15)", fg: "#4338CA" },
};

const STATUS_ORDER: FocusStatus[] = ["committed", "pending", "someday", "done"];

function formatDaysSince(days: number | null): string {
  if (days === null) return "no activity yet";
  if (days === 0) return "worked on today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

export function FocusCard() {
  const { focuses, loaded, fetch, create, update, remove, heartbeat } = useFocusesStore();
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftEndgoal, setDraftEndgoal] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editEndgoal, setEditEndgoal] = useState("");
  const [hoverId, setHoverId] = useState<number | null>(null);

  useEffect(() => {
    if (!loaded) fetch();
  }, [loaded, fetch]);

  // Hide done focuses by default — Daniel can see them via the API if he wants.
  const visible = focuses.filter((f) => f.status !== "done");

  async function handleCreate() {
    const name = draftName.trim();
    const endgoal = draftEndgoal.trim();
    if (!name || !endgoal) return;
    try {
      await create({ name, endgoal, status: "committed" });
      setDraftName("");
      setDraftEndgoal("");
      setAdding(false);
    } catch (e) {
      console.error(e);
    }
  }

  function startEdit(f: ApiFocus) {
    setEditingId(f.id);
    setEditName(f.name);
    setEditEndgoal(f.endgoal);
  }

  async function commitEdit() {
    if (editingId === null) return;
    const name = editName.trim();
    const endgoal = editEndgoal.trim();
    setEditingId(null);
    if (!name || !endgoal) return;
    try {
      await update(editingId, { name, endgoal });
    } catch (e) {
      console.error(e);
    }
  }

  async function cycleStatus(f: ApiFocus) {
    // Click status pill → cycle through committed → pending → someday → done → committed.
    const i = STATUS_ORDER.indexOf(f.status);
    const next = STATUS_ORDER[(i + 1) % STATUS_ORDER.length];
    try {
      await update(f.id, { status: next });
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{
        fontSize: 12, color: "#8E8E93", letterSpacing: 0.6,
        textTransform: "uppercase", marginBottom: 10, fontFamily: FONT,
      }}>focuses</div>

      <div style={{
        background: "#fff", borderRadius: 14, padding: "10px 14px",
        border: "1px solid rgba(0,0,0,0.07)",
      }}>
        {visible.length === 0 && !adding && (
          <p style={{ fontSize: 13, color: "#C7C7CC", fontFamily: FONT, margin: "8px 0" }}>
            No focuses yet — what are you committing to?
          </p>
        )}

        {visible.map((f) => {
          const colors = STATUS_COLORS[f.status];
          const isEditing = editingId === f.id;
          const isHover = hoverId === f.id;
          return (
            <div
              key={f.id}
              onMouseEnter={() => setHoverId(f.id)}
              onMouseLeave={() => setHoverId(null)}
              style={{
                padding: "10px 4px",
                borderBottom: "1px solid rgba(0,0,0,0.04)",
                fontFamily: FONT,
              }}
            >
              {isEditing ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    style={{ fontSize: 14, fontWeight: 500, fontFamily: FONT, border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6, padding: "4px 8px", outline: "none" }}
                  />
                  <textarea
                    value={editEndgoal}
                    onChange={(e) => setEditEndgoal(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commitEdit();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    placeholder="What does done look like?"
                    rows={2}
                    style={{ fontSize: 13, fontFamily: FONT, border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6, padding: "6px 8px", outline: "none", resize: "vertical" }}
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={commitEdit} style={btnStyle("primary")}>Save</button>
                    <button onClick={() => setEditingId(null)} style={btnStyle("ghost")}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      onClick={() => cycleStatus(f)}
                      title={`Status: ${f.status} (click to cycle)`}
                      style={{
                        fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
                        textTransform: "uppercase",
                        background: colors.bg, color: colors.fg,
                        padding: "2px 7px", borderRadius: 999,
                        cursor: "pointer", userSelect: "none",
                      }}
                    >
                      {f.status}
                    </span>
                    <span
                      onClick={() => startEdit(f)}
                      style={{ fontSize: 14, fontWeight: 500, color: "#1C1C1E", cursor: "pointer", flex: 1 }}
                    >
                      {f.name}
                    </span>
                    <span style={{ fontSize: 11, color: "#8E8E93" }}>
                      {formatDaysSince(f.days_since_activity)}
                    </span>
                    {isHover && (
                      <div style={{ display: "flex", gap: 4 }}>
                        <button
                          title="Mark as worked on today"
                          onClick={() => heartbeat(f.id)}
                          style={iconBtnStyle()}
                        >♥</button>
                        <button
                          title="Delete focus"
                          onClick={() => {
                            if (confirm(`Delete focus "${f.name}"?`)) remove(f.id);
                          }}
                          style={iconBtnStyle()}
                        >×</button>
                      </div>
                    )}
                  </div>
                  <div
                    onClick={() => startEdit(f)}
                    style={{
                      fontSize: 12.5, color: "#6E6E73", marginTop: 3,
                      paddingLeft: 0, cursor: "pointer",
                    }}
                  >
                    {f.endgoal}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {adding ? (
          <div style={{ padding: "10px 4px", display: "flex", flexDirection: "column", gap: 6 }}>
            <input
              autoFocus
              placeholder="Focus name (e.g. Ship Gooni v2)"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setAdding(false); }}
              style={{ fontSize: 14, fontWeight: 500, fontFamily: FONT, border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6, padding: "4px 8px", outline: "none" }}
            />
            <textarea
              placeholder="Endgoal — what does done look like?"
              value={draftEndgoal}
              onChange={(e) => setDraftEndgoal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleCreate();
                if (e.key === "Escape") setAdding(false);
              }}
              rows={2}
              style={{ fontSize: 13, fontFamily: FONT, border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6, padding: "6px 8px", outline: "none", resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleCreate} style={btnStyle("primary")}>Add focus</button>
              <button onClick={() => { setAdding(false); setDraftName(""); setDraftEndgoal(""); }} style={btnStyle("ghost")}>Cancel</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            style={{
              width: "100%", padding: "8px 4px", textAlign: "left",
              border: "none", background: "transparent", color: "#8E8E93",
              fontSize: 13, fontFamily: FONT, cursor: "pointer",
            }}
          >
            + add focus
          </button>
        )}
      </div>
    </div>
  );
}

function btnStyle(variant: "primary" | "ghost"): React.CSSProperties {
  if (variant === "primary") {
    return {
      background: "#1C1C1E", color: "#fff",
      border: "none", borderRadius: 6, padding: "5px 12px",
      fontFamily: FONT, fontSize: 12, fontWeight: 500, cursor: "pointer",
    };
  }
  return {
    background: "transparent", color: "#6E6E73",
    border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6, padding: "5px 12px",
    fontFamily: FONT, fontSize: 12, cursor: "pointer",
  };
}

function iconBtnStyle(): React.CSSProperties {
  return {
    width: 22, height: 22, borderRadius: 6,
    border: "none", background: "transparent",
    color: "#8E8E93", cursor: "pointer", fontSize: 14,
    display: "flex", alignItems: "center", justifyContent: "center",
  };
}
