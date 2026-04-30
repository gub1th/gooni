import { useEffect, useState } from "react";
import {
  fetchItemTree, fetchTodayItems, createItem,
  type ApiItemTree, type ApiTodayItem,
} from "../services/api";
import { Item, TodayRow } from "./Item";

const FONT = "'Inter', -apple-system, sans-serif";

export function ActivityCard() {
  const [tree, setTree] = useState<ApiItemTree | null>(null);
  const [today, setToday] = useState<ApiTodayItem[]>([]);

  async function refresh() {
    try {
      const [t, td] = await Promise.all([fetchItemTree(), fetchTodayItems()]);
      setTree(t);
      setToday(td);
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
      <TodaySection items={today} onChange={refresh} />
      <FocusesSection
        focuses={tree?.focuses ?? []}
        onChange={refresh}
      />
    </div>
  );
}

// ── Section header (shared dot + uppercase label) ───────────────────────────

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

// ── TODAY ───────────────────────────────────────────────────────────────────

function TodaySection({ items, onChange }: { items: ApiTodayItem[]; onChange: () => void }) {
  const open = items.filter((i) => !i.done);
  const [drafting, setDrafting] = useState(false);
  const [draftText, setDraftText] = useState("");

  async function submitDraft() {
    if (!draftText.trim()) { setDrafting(false); return; }
    const today = new Date();
    const due = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59).toISOString();
    await createItem({ text: draftText.trim(), due_date: due });
    setDraftText("");
    setDrafting(false);
    onChange();
  }

  return (
    <div>
      <SectionHeader dotColor="#30D158" label="Today" right={
        <span style={{ fontSize: 11, color: "#8E8E93", fontWeight: 500 }}>
          {open.length} open
        </span>
      } />
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {items.length === 0 && !drafting ? (
          <span style={{ fontSize: 11.5, color: "#C7C7CC", padding: "4px 0" }}>
            nothing on the docket — add a step or pin a focus to surface its items here.
          </span>
        ) : (
          items.map((item) => (
            <TodayRow key={item.id} item={item} onChange={onChange} />
          ))
        )}
        {drafting ? (
          <input
            autoFocus
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            onBlur={submitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitDraft();
              if (e.key === "Escape") { setDrafting(false); setDraftText(""); }
            }}
            placeholder="quick todo for today…"
            style={{
              fontSize: 12, padding: "4px 8px", borderRadius: 6,
              border: "1px solid rgba(0,0,0,0.1)", background: "#fff",
              fontFamily: FONT, marginTop: 4,
            }}
          />
        ) : (
          <button
            onClick={() => setDrafting(true)}
            style={{
              fontSize: 11.5, color: "#8E8E93", textAlign: "left",
              background: "transparent", border: "none",
              padding: "4px 0", cursor: "pointer", fontFamily: FONT,
            }}
          >+ quick todo</button>
        )}
      </div>
    </div>
  );
}

// ── FOCUSES ─────────────────────────────────────────────────────────────────

function FocusesSection({ focuses, onChange }: {
  focuses: import("../services/api").ApiItemNode[];
  onChange: () => void;
}) {
  const committed = focuses.filter((f) => f.committed);
  const uncommitted = focuses.filter((f) => !f.committed);
  const stale = committed.filter((f) => f.stale).length;
  const [adding, setAdding] = useState(false);

  return (
    <div>
      <SectionHeader dotColor="#1C1C1E" label="Focuses" right={
        <span style={{ fontSize: 11, color: "#8E8E93", fontWeight: 500 }}>
          {committed.length} committed{stale > 0 ? ` · ${stale} stale` : ""}
        </span>
      } />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {committed.length === 0 ? (
          <span style={{ fontSize: 11.5, color: "#C7C7CC", padding: "4px 0" }}>
            no focuses yet — give yourself a north star.
          </span>
        ) : (
          committed.map((f) => (
            <Item key={f.id} node={f} depth={0} onChange={onChange} />
          ))
        )}
        {uncommitted.length > 0 && (
          <details style={{ marginTop: 4 }}>
            <summary style={{
              fontSize: 11, color: "#8E8E93", cursor: "pointer",
              padding: "4px 0", listStyle: "none",
            }}>
              {uncommitted.length} not committed
            </summary>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
              {uncommitted.map((f) => (
                <Item key={f.id} node={f} depth={0} onChange={onChange} />
              ))}
            </div>
          </details>
        )}
        {adding ? (
          <FocusAdder onDone={() => { setAdding(false); onChange(); }} />
        ) : (
          <button
            onClick={() => setAdding(true)}
            style={{
              fontSize: 11.5, color: "#8E8E93", textAlign: "left",
              background: "transparent", border: "none",
              padding: "4px 0", cursor: "pointer", fontFamily: FONT,
              marginTop: 4,
            }}
          >+ add focus</button>
        )}
      </div>
    </div>
  );
}

function FocusAdder({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState("");
  const [endgoal, setEndgoal] = useState("");
  const [step, setStep] = useState<"name" | "endgoal">("name");

  async function submit() {
    if (!text.trim()) { onDone(); return; }
    await createItem({
      text: text.trim(),
      endgoal: endgoal.trim() || null,
      committed: true,
    });
    onDone();
  }

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 6,
      padding: "8px 10px", border: "0.5px solid rgba(0,0,0,0.08)",
      borderRadius: 8, background: "#FDFCFA",
    }}>
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") setStep("endgoal");
          if (e.key === "Escape") onDone();
        }}
        placeholder="focus name…"
        style={{
          fontSize: 12.5, padding: "4px 8px", borderRadius: 6,
          border: "1px solid rgba(0,0,0,0.1)", background: "#fff",
          fontFamily: FONT,
        }}
      />
      {step === "endgoal" && (
        <input
          autoFocus
          value={endgoal}
          onChange={(e) => setEndgoal(e.target.value)}
          onBlur={submit}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onDone();
          }}
          placeholder="what done looks like…"
          style={{
            fontSize: 11.5, padding: "4px 8px", borderRadius: 6,
            border: "1px solid rgba(0,0,0,0.1)", background: "#fff",
            fontFamily: FONT, fontStyle: "italic",
          }}
        />
      )}
    </div>
  );
}

