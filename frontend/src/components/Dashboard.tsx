import { useState, useEffect } from "react";
import { createFocus, fetchDashboardStats, type DashboardStats, type FocusItem } from "../services/api";

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
const DISPLAY_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";
const COMMITMENTS: FocusItem["commitment"][] = ["committed", "pending", "someday"];

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function getDateStr(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function relativeTime(isoStr: string | null): string {
  if (!isoStr) return "—";
  const diffDays = Math.floor((Date.now() - new Date(isoStr).getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return "1 week ago";
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  return `${Math.floor(diffDays / 30)} months ago`;
}

function FocusCard({ focus, tint }: { focus: FocusItem; tint: "pink" | "orange" }) {
  const bg = tint === "pink" ? "#FFF5F7" : "#FFF8F0";
  const border = tint === "pink" ? "rgba(255,45,85,0.18)" : "rgba(255,149,0,0.25)";
  const commentaryBg = tint === "pink" ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.7)";

  return (
    <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: 12, padding: "18px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 10 }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "#1C1C1E", lineHeight: 1.3 }}>{focus.name}</div>
        <div style={{ fontSize: 11, color: "#AEAEB2", display: "flex", alignItems: "center", gap: 3, flexShrink: 0, paddingTop: 2 }}>
          <span>◷</span><span>{relativeTime(focus.updated_at)}</span>
        </div>
      </div>

      {focus.overdue && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 10 }}>
          <span style={{ color: "#FF3B30", fontSize: 11 }}>⊙</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#FF3B30" }}>Overdue</span>
        </div>
      )}
      {!focus.overdue && focus.due_soon && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 10 }}>
          <span style={{ color: "#FF9500", fontSize: 11 }}>⊙</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#FF9500" }}>Due soon</span>
        </div>
      )}

      {focus.commentary && (
        <div style={{
          background: commentaryBg,
          borderRadius: 8,
          padding: "12px 14px",
          fontSize: 13,
          color: "#3C3C43",
          lineHeight: 1.65,
          border: "1px solid rgba(0,0,0,0.06)",
        }}>
          {focus.commentary}
        </div>
      )}
    </div>
  );
}

function AspirationCard({ focus }: { focus: FocusItem }) {
  return (
    <div style={{
      background: "#fff",
      border: "1px solid rgba(0,0,0,0.08)",
      borderRadius: 12,
      padding: "14px 16px",
      display: "flex",
      alignItems: "center",
      gap: 12,
    }}>
      <span style={{ fontSize: 14, flexShrink: 0, color: "#8E8E93" }}>✦</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#1C1C1E", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {focus.name}
        </div>
        <div style={{ fontSize: 11, color: "#AEAEB2", marginTop: 2, display: "flex", alignItems: "center", gap: 3 }}>
          <span>◷</span><span>{relativeTime(focus.updated_at)}</span>
        </div>
      </div>
      <button style={{
        width: 24, height: 24, borderRadius: "50%", border: "1px solid rgba(0,0,0,0.1)",
        background: "transparent", color: "#AEAEB2", fontSize: 11, cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
      }}>?</button>
    </div>
  );
}

function AddFocusModal({ onClose, onAdd }: { onClose: () => void; onAdd: () => void }) {
  const [name, setName] = useState("");
  const [commitment, setCommitment] = useState<FocusItem["commitment"]>("committed");
  const [dueDate, setDueDate] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      await createFocus(name.trim(), commitment, dueDate || null);
      onAdd();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 16, padding: 28, width: 420, boxShadow: "0 20px 60px rgba(0,0,0,0.18)", fontFamily: FONT }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, color: "#1C1C1E", marginBottom: 20 }}>Add a focus</div>

        <form onSubmit={handleSubmit}>
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="What are you focusing on?"
            style={{
              width: "100%", padding: "10px 12px", borderRadius: 8,
              border: "1px solid rgba(0,0,0,0.15)", fontSize: 14, fontFamily: FONT,
              color: "#1C1C1E", outline: "none", boxSizing: "border-box", marginBottom: 14,
            }}
          />

          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            {COMMITMENTS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setCommitment(c)}
                style={{
                  flex: 1, padding: "8px 0", borderRadius: 8, cursor: "pointer",
                  border: `1px solid ${commitment === c ? "#1C1C1E" : "rgba(0,0,0,0.1)"}`,
                  background: commitment === c ? "#1C1C1E" : "transparent",
                  color: commitment === c ? "#fff" : "#636366",
                  fontSize: 13, fontFamily: FONT, textTransform: "capitalize",
                  transition: "background 0.15s, color 0.15s",
                }}
              >{c}</button>
            ))}
          </div>

          <input
            type="date"
            value={dueDate}
            onChange={e => setDueDate(e.target.value)}
            style={{
              width: "100%", padding: "10px 12px", borderRadius: 8,
              border: "1px solid rgba(0,0,0,0.15)", fontSize: 14, fontFamily: FONT,
              color: dueDate ? "#1C1C1E" : "#AEAEB2", outline: "none",
              boxSizing: "border-box", marginBottom: 22, background: "#fff",
            }}
          />

          <div style={{ display: "flex", gap: 10 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                flex: 1, padding: "10px 0", borderRadius: 8,
                border: "1px solid rgba(0,0,0,0.1)", background: "transparent",
                color: "#636366", fontSize: 14, fontFamily: FONT, cursor: "pointer",
              }}
            >Cancel</button>
            <button
              type="submit"
              disabled={!name.trim() || submitting}
              style={{
                flex: 1, padding: "10px 0", borderRadius: 8, border: "none",
                background: name.trim() ? "#1C1C1E" : "rgba(0,0,0,0.06)",
                color: name.trim() ? "#fff" : "#AEAEB2",
                fontSize: 14, fontFamily: FONT, fontWeight: 500,
                cursor: name.trim() ? "pointer" : "default",
                transition: "background 0.15s",
              }}
            >{submitting ? "Adding..." : "Add focus"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  function loadStats() {
    fetchDashboardStats().then(setStats).catch(console.error);
  }

  useEffect(() => { loadStats(); }, []);

  const committed = stats?.focuses?.filter(f => f.commitment === "committed") ?? [];
  const pending = stats?.focuses?.filter(f => f.commitment === "pending") ?? [];
  const someday = stats?.focuses?.filter(f => f.commitment === "someday") ?? [];

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "#FAFAFA", fontFamily: FONT }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "48px 52px 120px" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ fontSize: 38, fontWeight: 700, fontFamily: DISPLAY_FONT, color: "#1C1C1E", letterSpacing: "-0.5px", lineHeight: 1.15 }}>
            {getGreeting()}, Daniel.
          </div>
          <div style={{ fontSize: 13, color: "#8E8E93", display: "flex", alignItems: "center", gap: 5, paddingTop: 10 }}>
            <span>◷</span><span>{getDateStr()}</span>
          </div>
        </div>

        {/* Gooni's Take */}
        <div style={{ border: "2px solid #1C1C1E", borderRadius: 14, padding: "20px 24px", marginTop: 28, background: "#fff" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <div style={{
              width: 28, height: 28, borderRadius: "50%", background: "#1C1C1E",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#fff", fontSize: 13, fontWeight: 700, flexShrink: 0,
            }}>G</div>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#1C1C1E" }}>Gooni's Take</span>
          </div>
          <p style={{ fontSize: 15, color: "#1C1C1E", lineHeight: 1.7, margin: 0 }}>
            {stats?.gooni_take ?? "Loading your briefing…"}
          </p>
        </div>

        {/* Two-column: committed + pending */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 36, marginTop: 44 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1C1C1E", marginBottom: 14, letterSpacing: "-0.1px" }}>
              Your current active focuses
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {committed.map(f => <FocusCard key={f.id} focus={f} tint="pink" />)}
              {stats && committed.length === 0 && (
                <div style={{ fontSize: 13, color: "#C7C7CC", padding: "16px 0" }}>No active focuses yet.</div>
              )}
            </div>
          </div>

          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1C1C1E", marginBottom: 14, letterSpacing: "-0.1px" }}>
              Your current one-off focuses
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {pending.map(f => <FocusCard key={f.id} focus={f} tint="orange" />)}
              {stats && pending.length === 0 && (
                <div style={{ fontSize: 13, color: "#C7C7CC", padding: "16px 0" }}>No one-off focuses yet.</div>
              )}
            </div>
          </div>
        </div>

        {/* Aspirations */}
        {someday.length > 0 && (
          <div style={{ marginTop: 52 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1C1C1E", marginBottom: 14, letterSpacing: "-0.1px" }}>
              Your aspirations
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {someday.map(f => <AspirationCard key={f.id} focus={f} />)}
            </div>
          </div>
        )}
      </div>

      {/* Floating add button */}
      <button
        onClick={() => setModalOpen(true)}
        style={{
          position: "fixed", bottom: 32, right: 32,
          width: 44, height: 44, borderRadius: "50%",
          background: "#1C1C1E", color: "#fff", border: "none",
          fontSize: 22, cursor: "pointer", zIndex: 50,
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
        }}
      >+</button>

      {modalOpen && <AddFocusModal onClose={() => setModalOpen(false)} onAdd={loadStats} />}
    </div>
  );
}
