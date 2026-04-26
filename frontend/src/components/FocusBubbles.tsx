import { useEffect, useRef, useState } from "react";
import { useFocusesStore } from "../stores/useFocusesStore";
import type { ApiFocus, FocusStatus } from "../services/api";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";

const STATUS_COLORS: Record<FocusStatus, { bg: string; fg: string; ring: string }> = {
  committed: { bg: "rgba(74, 222, 128, 0.16)", fg: "#16A34A", ring: "rgba(74, 222, 128, 0.5)" },
  pending:   { bg: "rgba(250, 204, 21, 0.16)", fg: "#A16207", ring: "rgba(250, 204, 21, 0.5)" },
  someday:   { bg: "rgba(148, 163, 184, 0.18)", fg: "#475569", ring: "rgba(148, 163, 184, 0.5)" },
  done:      { bg: "rgba(99, 102, 241, 0.15)",  fg: "#4338CA", ring: "rgba(99, 102, 241, 0.5)" },
};

const STATUS_ORDER: FocusStatus[] = ["committed", "pending", "someday", "done"];

// Bubbles version of focuses — meant to live INSIDE the Gooni's Take card so
// "focuses" reads as part of the day's framing, not a separate section.
//
// - Click status pill on a bubble: cycle status
// - Click body of bubble: open inline editor (name + endgoal)
// - Heartbeat / delete actions live in the inline editor (less visual noise)
// - Plus bubble: opens an inline add row at the end of the strip

export function FocusBubbles() {
  const { focuses, loaded, fetch, create, update, remove, heartbeat } = useFocusesStore();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editEndgoal, setEditEndgoal] = useState("");
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftEndgoal, setDraftEndgoal] = useState("");
  const editRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loaded) fetch();
  }, [loaded, fetch]);

  // Hide done by default — Daniel keeps the standalone view via the API for archive needs.
  const visible = focuses.filter((f) => f.status !== "done");

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
    const i = STATUS_ORDER.indexOf(f.status);
    const next = STATUS_ORDER[(i + 1) % STATUS_ORDER.length];
    try { await update(f.id, { status: next }); } catch (e) { console.error(e); }
  }

  async function handleAdd() {
    const name = draftName.trim();
    const endgoal = draftEndgoal.trim();
    if (!name || !endgoal) return;
    try {
      await create({ name, endgoal, status: "committed" });
      setDraftName(""); setDraftEndgoal(""); setAdding(false);
    } catch (e) { console.error(e); }
  }

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px dashed rgba(0,0,0,0.07)" }}>
      <div style={{
        fontSize: 10, color: "#AEAEB2", letterSpacing: 0.7,
        textTransform: "uppercase", marginBottom: 8, fontFamily: FONT,
      }}>focuses</div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {visible.length === 0 && !adding && (
          <span style={{ fontSize: 12, color: "#C7C7CC", fontFamily: FONT, padding: "5px 0" }}>
            no focuses yet — set one to anchor your week
          </span>
        )}

        {visible.map((f) => {
          const c = STATUS_COLORS[f.status];
          return (
            <button
              key={f.id}
              onClick={() => startEdit(f)}
              title={`${f.endgoal} — click to edit`}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "5px 11px 5px 7px",
                borderRadius: 999,
                background: c.bg,
                border: `1px solid ${c.ring}`,
                color: c.fg,
                fontFamily: FONT, fontSize: 12, fontWeight: 500,
                cursor: "pointer",
                transition: "transform 0.1s ease, box-shadow 0.1s ease",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.transform = "translateY(-1px)";
                (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 4px 10px ${c.ring}`;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.transform = "translateY(0)";
                (e.currentTarget as HTMLButtonElement).style.boxShadow = "none";
              }}
            >
              {/* Status dot — click to cycle without entering edit mode */}
              <span
                onClick={(e) => { e.stopPropagation(); cycleStatus(f); }}
                title={`Status: ${f.status} — click to cycle`}
                style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: c.fg, flexShrink: 0,
                  boxShadow: `0 0 0 2px ${c.bg}`,
                }}
              />
              <span>{f.name}</span>
            </button>
          );
        })}

        {/* Add bubble */}
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              padding: "5px 12px",
              borderRadius: 999,
              background: "transparent",
              border: "1px dashed rgba(0,0,0,0.18)",
              color: "#8E8E93",
              fontFamily: FONT, fontSize: 12, fontWeight: 500,
              cursor: "pointer",
            }}
          >
            <span style={{ fontSize: 14, lineHeight: 0.7 }}>+</span>
            <span>add focus</span>
          </button>
        )}
      </div>

      {/* Inline edit drawer — appears below the bubble strip when a bubble is clicked. */}
      {editingId !== null && (
        <div
          ref={editRef}
          style={{
            marginTop: 10,
            padding: 12,
            borderRadius: 10,
            background: "rgba(0,0,0,0.03)",
            border: "1px solid rgba(0,0,0,0.06)",
            display: "flex", flexDirection: "column", gap: 8,
          }}
        >
          <input
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              if (e.key === "Escape") setEditingId(null);
            }}
            style={{
              fontSize: 13.5, fontWeight: 500, fontFamily: FONT,
              border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6,
              padding: "5px 9px", outline: "none",
            }}
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
            style={{
              fontSize: 12.5, fontFamily: FONT,
              border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6,
              padding: "6px 9px", outline: "none", resize: "vertical",
            }}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={commitEdit} style={btnPrimary()}>Save</button>
            <button onClick={() => setEditingId(null)} style={btnGhost()}>Cancel</button>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => { if (editingId !== null) heartbeat(editingId); setEditingId(null); }}
              title="Touched today"
              style={btnGhost()}
            >♥ touched</button>
            <button
              onClick={() => {
                if (editingId === null) return;
                const f = focuses.find((x) => x.id === editingId);
                if (!f) return;
                if (confirm(`Delete focus "${f.name}"?`)) { remove(f.id); setEditingId(null); }
              }}
              style={{ ...btnGhost(), color: "#C76B6B" }}
            >Delete</button>
          </div>
        </div>
      )}

      {/* Inline add drawer */}
      {adding && (
        <div
          style={{
            marginTop: 10,
            padding: 12,
            borderRadius: 10,
            background: "rgba(74,222,128,0.06)",
            border: "1px dashed rgba(74,222,128,0.4)",
            display: "flex", flexDirection: "column", gap: 8,
          }}
        >
          <input
            autoFocus
            placeholder="Focus name (e.g. Ship Gooni v2)"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setAdding(false); }}
            style={{
              fontSize: 13.5, fontWeight: 500, fontFamily: FONT,
              border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6,
              padding: "5px 9px", outline: "none",
            }}
          />
          <textarea
            placeholder="Endgoal — what does done look like?"
            value={draftEndgoal}
            onChange={(e) => setDraftEndgoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAdd();
              if (e.key === "Escape") setAdding(false);
            }}
            rows={2}
            style={{
              fontSize: 12.5, fontFamily: FONT,
              border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6,
              padding: "6px 9px", outline: "none", resize: "vertical",
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleAdd} style={btnPrimary()}>Add focus</button>
            <button
              onClick={() => { setAdding(false); setDraftName(""); setDraftEndgoal(""); }}
              style={btnGhost()}
            >Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function btnPrimary(): React.CSSProperties {
  return {
    background: "#1C1C1E", color: "#fff",
    border: "none", borderRadius: 6, padding: "5px 12px",
    fontFamily: FONT, fontSize: 12, fontWeight: 500, cursor: "pointer",
  };
}
function btnGhost(): React.CSSProperties {
  return {
    background: "transparent", color: "#6E6E73",
    border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6, padding: "5px 12px",
    fontFamily: FONT, fontSize: 12, cursor: "pointer",
  };
}
