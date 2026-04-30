import { useEffect, useState } from "react";
import {
  fetchItemTree, createItem,
  type ApiItemTree, type ApiItemNode,
} from "../services/api";
import { Item } from "./Item";

const FONT = "'Inter', -apple-system, sans-serif";

export function ActivityCard() {
  const [tree, setTree] = useState<ApiItemTree | null>(null);

  async function refresh() {
    try {
      const t = await fetchItemTree();
      setTree(t);
    } catch (e) { console.error(e); }
  }

  useEffect(() => { refresh(); }, []);

  return (
    <div style={{
      background: "#fff",
      border: "0.5px solid rgba(0,0,0,0.08)",
      borderRadius: 12,
      padding: "16px 18px",
      marginBottom: 16,
      fontFamily: FONT,
      display: "flex", flexDirection: "column", gap: 18,
    }}>
      <FocusesSection
        focuses={tree?.focuses ?? []}
        onChange={refresh}
      />
    </div>
  );
}

function SectionHeader({ dotColor, label, right }: {
  dotColor: string;
  label: string;
  right?: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: "50%", background: dotColor,
      }} />
      <span style={{
        fontSize: 11, color: "#8E8E93", textTransform: "uppercase",
        letterSpacing: 0.6, fontWeight: 600,
      }}>{label}</span>
      {right && (
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#1C1C1E" }}>
          {right}
        </span>
      )}
    </div>
  );
}

function FocusesSection({ focuses, onChange }: {
  focuses: ApiItemNode[];
  onChange: () => void;
}) {
  const committed = focuses.filter((f) => f.committed && !f.done);
  const uncommitted = focuses.filter((f) => !f.committed && !f.done);
  const completed = focuses.filter((f) => f.done);
  const stale = committed.filter((f) => f.stale).length;

  return (
    <div>
      <SectionHeader dotColor="#1C1C1E" label="Focuses" right={
        <span style={{ fontSize: 11, color: "#8E8E93", fontWeight: 500 }}>
          {committed.length} active{stale > 0 ? ` · ${stale} stale` : ""}
        </span>
      } />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {committed.length === 0 ? (
          <span style={{ fontSize: 11.5, color: "#C7C7CC", padding: "4px 0" }}>
            no focuses yet — what's on your plate?
          </span>
        ) : (
          committed.map((f) => (
            <Item key={f.id} node={f} onChange={onChange} />
          ))
        )}

        <FocusAdder onCreated={onChange} />

        {uncommitted.length > 0 && (
          <details style={{ marginTop: 6 }}>
            <summary style={{
              fontSize: 11, color: "#8E8E93", cursor: "pointer",
              padding: "4px 0", listStyle: "none",
            }}>
              {uncommitted.length} not committed
            </summary>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
              {uncommitted.map((f) => (
                <Item key={f.id} node={f} onChange={onChange} />
              ))}
            </div>
          </details>
        )}

        {completed.length > 0 && (
          <details style={{ marginTop: 4 }}>
            <summary style={{
              fontSize: 11, color: "#8E8E93", cursor: "pointer",
              padding: "4px 0", listStyle: "none",
            }}>
              {completed.length} done
            </summary>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
              {completed.map((f) => (
                <Item key={f.id} node={f} onChange={onChange} />
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function FocusAdder({ onCreated }: { onCreated: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      await createItem({ text: t, committed: true });
      setText("");
      onCreated();
    } catch (e) { console.error(e); }
    finally { setBusy(false); }
  }

  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !busy) submit();
        if (e.key === "Escape") setText("");
      }}
      placeholder="+ add focus"
      style={{
        fontSize: 12.5, padding: "8px 12px", borderRadius: 8,
        border: "1px dashed rgba(0,0,0,0.12)", background: "transparent",
        fontFamily: FONT, color: "#1C1C1E",
        outline: "none", marginTop: 2,
        width: "100%", boxSizing: "border-box",
      }}
      onFocus={(e) => { (e.currentTarget as HTMLInputElement).style.borderStyle = "solid"; (e.currentTarget as HTMLInputElement).style.borderColor = "rgba(0,0,0,0.18)"; }}
      onBlur={(e) => { (e.currentTarget as HTMLInputElement).style.borderStyle = "dashed"; (e.currentTarget as HTMLInputElement).style.borderColor = "rgba(0,0,0,0.12)"; }}
    />
  );
}
