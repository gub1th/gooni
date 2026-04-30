import { useEffect, useRef, useState } from "react";
import {
  type ApiItemNode, updateItem, deleteItem, createItem,
} from "../services/api";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

export interface FocusModalProps {
  node: ApiItemNode;
  onChange: () => void;
  onClose: () => void;
}

function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fromDateInputValue(v: string): string | null {
  if (!v) return null;
  return new Date(`${v}T00:00:00`).toISOString();
}

export function FocusModal({ node, onChange, onClose }: FocusModalProps) {
  const [text, setText] = useState(node.text);
  const [subtitle, setSubtitle] = useState(node.subtitle ?? "");
  const [endgoal, setEndgoal] = useState(node.endgoal ?? "");
  const [done, setDone] = useState(node.done);
  const [isPrimary, setIsPrimary] = useState(node.is_primary);
  const [dueDate, setDueDate] = useState(toDateInputValue(node.due_date));
  const [children, setChildren] = useState(node.children);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLInputElement>(null);

  useEffect(() => { textRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); save(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, subtitle, endgoal, done, dueDate]);

  const hasChildren = children.length > 0;

  async function save() {
    const patch: Parameters<typeof updateItem>[1] = {};
    const t = text.trim();
    if (t && t !== node.text) patch.text = t;
    const sub = subtitle.trim();
    if ((sub || null) !== (node.subtitle ?? null)) patch.subtitle = sub || null;
    const eg = endgoal.trim();
    if ((eg || null) !== (node.endgoal ?? null)) patch.endgoal = eg || null;
    if (!hasChildren && done !== node.done) patch.done = done;
    if (isPrimary !== node.is_primary) patch.is_primary = isPrimary;
    const nextDue = fromDateInputValue(dueDate);
    if ((nextDue || null) !== (node.due_date || null)) patch.due_date = nextDue;
    if (Object.keys(patch).length > 0) {
      try { await updateItem(node.id, patch); } catch (e) { console.error(e); }
      onChange();
      // Tell PrimaryFocusCard to refetch when primary toggled in either direction.
      if (isPrimary !== node.is_primary) {
        window.dispatchEvent(new CustomEvent("gooni-primary-changed"));
      }
    }
    onClose();
  }

  async function addStep(stepText: string) {
    const trimmed = stepText.trim();
    if (!trimmed) { setAdding(false); return; }
    try {
      const child = await createItem({ text: trimmed, parent_id: node.id });
      setChildren((c) => [...c, { ...child, children: [], progress: { done: 0, total: 0 }, stale: false }]);
      onChange();
    } catch (e) { console.error(e); }
    setAdding(false);
  }

  async function toggleChild(id: number, currentDone: boolean) {
    setChildren((cs) => cs.map((c) => c.id === id ? { ...c, done: !currentDone } : c));
    try { await updateItem(id, { done: !currentDone }); onChange(); }
    catch (e) { console.error(e); }
  }

  async function removeChild(id: number) {
    setChildren((cs) => cs.filter((c) => c.id !== id));
    try { await deleteItem(id); onChange(); } catch (e) { console.error(e); }
  }

  async function handleDelete() {
    try { await deleteItem(node.id); } catch (e) { console.error(e); }
    onChange();
    onClose();
  }

  const doneCount = children.filter((c) => c.done).length;

  return (
    <div
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) save(); }}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(15, 18, 24, 0.45)",
        zIndex: 10000,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24, animation: "gooni-modal-in 160ms ease-out",
      }}
    >
      <style>{`
        @keyframes gooni-modal-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes gooni-modal-card-in {
          from { opacity: 0; transform: translateY(8px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0)    scale(1);    }
        }
      `}</style>
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 100%)", background: "#FFFFFF",
          borderRadius: 14, boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
          fontFamily: FONT, padding: 24,
          maxHeight: "90vh", overflowY: "auto",
          animation: "gooni-modal-card-in 200ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <span style={{ fontSize: 11, color: "#8E8E93", letterSpacing: 0.5, textTransform: "uppercase" }}>
            Focus
          </span>
          <button
            onClick={save}
            aria-label="Close"
            style={{
              border: "none", background: "transparent", color: "#9CA3AF",
              cursor: "pointer", fontSize: 22, padding: 0, lineHeight: 1,
            }}
          >×</button>
        </div>

        <input
          ref={textRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What's the focus?"
          style={{
            width: "100%", boxSizing: "border-box",
            border: "none", outline: "none",
            fontSize: 20, fontWeight: 600, color: "#1C1C1E",
            background: "transparent",
            padding: "4px 0 8px",
            fontFamily: FONT,
            textDecoration: !hasChildren && done ? "line-through" : "none",
          }}
        />

        <input
          value={endgoal}
          onChange={(e) => setEndgoal(e.target.value)}
          placeholder="What does done look like? (optional)"
          style={{
            width: "100%", boxSizing: "border-box",
            border: "none", outline: "none",
            fontSize: 13, color: "#6B6B70",
            background: "transparent",
            padding: "0 0 12px", fontFamily: FONT, fontStyle: "italic",
          }}
        />

        <textarea
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          placeholder="Notes / description…"
          rows={3}
          style={{
            width: "100%", boxSizing: "border-box",
            border: "none", outline: "none",
            fontSize: 13, color: "#3C3C43",
            background: "#F9FAFB", padding: 12, borderRadius: 8,
            resize: "vertical", fontFamily: FONT, lineHeight: 1.5,
            marginBottom: 16,
          }}
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
          <ToggleRow
            label="Set as primary"
            help={isPrimary ? "Spotlighted at the top of the dashboard." : "Promote this above the rest."}
            value={isPrimary}
            onChange={setIsPrimary}
          />
          {!hasChildren && (
            <ToggleRow
              label="Done"
              help={done ? "Marked complete." : "Active."}
              value={done}
              onChange={setDone}
            />
          )}
          <div>
            <div style={{ fontSize: 13, color: "#1C1C1E", fontWeight: 500, marginBottom: 6 }}>Due date</div>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              style={{
                fontFamily: FONT, fontSize: 13, padding: "6px 10px",
                border: "1px solid #E5E7EB", borderRadius: 8, color: "#1C1C1E", outline: "none",
              }}
            />
            {dueDate && (
              <button
                onClick={() => setDueDate("")}
                style={{
                  marginLeft: 8, border: "none", background: "transparent",
                  color: "#9CA3AF", cursor: "pointer", fontSize: 12, fontFamily: FONT,
                }}
              >Clear</button>
            )}
          </div>
        </div>

        {/* Steps */}
        <div style={{ marginBottom: 18 }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            fontSize: 11, color: "#8E8E93", textTransform: "uppercase", letterSpacing: 0.6,
            fontWeight: 600, marginBottom: 8,
          }}>
            <span>Steps</span>
            {hasChildren && (
              <span style={{ fontVariantNumeric: "tabular-nums", letterSpacing: 0.4 }}>
                {doneCount}/{children.length}
              </span>
            )}
          </div>
          {children.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 6 }}>
              {children.map((c) => (
                <div key={c.id} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "4px 0",
                }}>
                  <input
                    type="checkbox"
                    checked={c.done}
                    onChange={() => toggleChild(c.id, c.done)}
                    style={{ accentColor: "#30D158", flexShrink: 0 }}
                  />
                  <span style={{
                    fontSize: 13, color: c.done ? "#AEAEB2" : "#1C1C1E",
                    textDecoration: c.done ? "line-through" : "none", flex: 1,
                  }}>{c.text}</span>
                  <button
                    onClick={() => removeChild(c.id)}
                    aria-label="delete"
                    style={{
                      background: "transparent", border: "none",
                      color: "#C7C7CC", cursor: "pointer",
                      fontSize: 12, padding: "0 4px",
                    }}
                  >×</button>
                </div>
              ))}
            </div>
          )}
          {adding ? (
            <StepInput onSubmit={addStep} onCancel={() => setAdding(false)} />
          ) : (
            <button
              onClick={() => setAdding(true)}
              style={{
                fontSize: 12, color: "#8E8E93", textAlign: "left",
                background: "transparent", border: "none",
                padding: "4px 0", cursor: "pointer", fontFamily: FONT,
              }}
            >+ add step</button>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          {confirmDelete ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "#9CA3AF" }}>Delete focus?</span>
              <button
                onClick={handleDelete}
                style={{
                  border: "none", background: "#DC2626", color: "#FFF",
                  fontFamily: FONT, fontSize: 12, fontWeight: 600,
                  padding: "6px 12px", borderRadius: 6, cursor: "pointer",
                }}
              >Delete</button>
              <button
                onClick={() => setConfirmDelete(false)}
                style={{
                  border: "none", background: "transparent", color: "#6B7280",
                  fontFamily: FONT, fontSize: 12, padding: "6px 8px", cursor: "pointer",
                }}
              >Cancel</button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              style={{
                border: "none", background: "transparent", color: "#9CA3AF",
                fontFamily: FONT, fontSize: 12, cursor: "pointer", padding: "6px 0",
              }}
            >Delete focus</button>
          )}
          <button
            onClick={save}
            style={{
              border: "none", background: "#1C1C1E", color: "#FFFFFF",
              fontFamily: FONT, fontSize: 13, fontWeight: 600,
              padding: "8px 16px", borderRadius: 8, cursor: "pointer",
            }}
          >Done</button>
        </div>
      </div>
    </div>
  );
}

function StepInput({ onSubmit, onCancel }: { onSubmit: (t: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  return (
    <input
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onSubmit(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit(text);
        if (e.key === "Escape") onCancel();
      }}
      placeholder="step…"
      style={{
        fontSize: 13, padding: "6px 10px", borderRadius: 6,
        border: "1px solid rgba(0,0,0,0.1)", background: "#fff",
        fontFamily: FONT, width: "100%", boxSizing: "border-box",
      }}
    />
  );
}

function ToggleRow({
  label, help, value, onChange,
}: { label: string; help: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, color: "#1C1C1E", fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 11.5, color: "#8E8E93", marginTop: 2 }}>{help}</div>
      </div>
      <button
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        style={{
          width: 38, height: 22, borderRadius: 999,
          border: "none", padding: 2,
          background: value ? "#34C759" : "#E5E7EB",
          cursor: "pointer", flexShrink: 0,
          transition: "background 120ms",
          display: "flex", alignItems: "center",
        }}
      >
        <div style={{
          width: 18, height: 18, borderRadius: 999, background: "#FFFFFF",
          transform: value ? "translateX(16px)" : "translateX(0)",
          transition: "transform 140ms cubic-bezier(0.22, 1, 0.36, 1)",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
        }} />
      </button>
    </div>
  );
}
