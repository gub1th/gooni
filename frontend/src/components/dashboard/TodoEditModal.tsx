import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, Crown, Trash2, X } from "lucide-react";
import {
  deleteTodo, updateTodo, promoteTodoToPrimary,
  type ApiTodo, type ApiFocus, type TodoChainMeta, type TodoState,
} from "../../services/api";
import { resolveFocusColor } from "../../utils/focusColors";
import { FONT } from "../../ui";

// Modal surface for editing every persisted field on a Todo. Inline
// controls (checkbox cycle, crown, age pill, delete) still work in the
// list; this is the "full details" view per Daniel's ask.


const STATES: { value: TodoState; label: string }[] = [
  { value: "not_yet", label: "Not yet" },
  { value: "doing",   label: "Doing" },
  { value: "done",    label: "Done" },
];

interface Props {
  todo: ApiTodo;
  focuses: ApiFocus[];
  chainMeta?: TodoChainMeta;
  onClose: () => void;
  onOpenChain?: (todoId: number) => void;
}

export function TodoEditModal({ todo, focuses, chainMeta, onClose, onOpenChain }: Props) {
  const qc = useQueryClient();
  const [text, setText] = useState(todo.text);
  const [subtitle, setSubtitle] = useState(todo.subtitle ?? "");
  const [state, setState] = useState<TodoState>(todo.state);
  const [focusId, setFocusId] = useState<number | null>(todo.focus_id);
  const [dueDate, setDueDate] = useState(todo.due_date ?? "");
  const [isPrimary, setIsPrimary] = useState(todo.is_primary);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void onSave();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, subtitle, state, focusId, dueDate, isPrimary]);

  function dirty(): boolean {
    return (
      text !== todo.text ||
      (subtitle || "") !== (todo.subtitle ?? "") ||
      state !== todo.state ||
      focusId !== todo.focus_id ||
      (dueDate || "") !== (todo.due_date ?? "") ||
      isPrimary !== todo.is_primary
    );
  }

  async function onSave() {
    if (saving) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      // is_primary is a singleton; promote endpoint clears the previous
      // crown atomically, so use it when flipping false → true. Demote
      // (true → false) is just a regular PATCH.
      if (isPrimary && !todo.is_primary) {
        await promoteTodoToPrimary(todo.id);
      }
      await updateTodo(todo.id, {
        text: trimmed,
        subtitle: subtitle.trim() || null,
        state,
        focus_id: focusId,
        due_date: dueDate || null,
        ...(isPrimary === todo.is_primary ? {} : { is_primary: isPrimary }),
      });
      qc.invalidateQueries({ queryKey: ["todos-bundle"] });
      onClose();
    } catch (e) {
      console.error("save todo failed", e);
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    try {
      await deleteTodo(todo.id);
      qc.invalidateQueries({ queryKey: ["todos-bundle"] });
      onClose();
    } catch (e) {
      console.error("delete todo failed", e);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(15,23,42,0.55)",
        zIndex: 100,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: FONT,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--gooni-card, #fff)",
          borderRadius: 16,
          width: "min(560px, 92vw)",
          maxHeight: "88vh",
          overflowY: "auto",
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
          color: "var(--gooni-text, #1C1C1E)",
        }}
      >
        {/* Header */}
        <div style={{
          padding: "16px 20px 12px",
          borderBottom: "0.5px solid rgba(0,0,0,0.08)",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
            textTransform: "uppercase",
            color: "var(--gooni-muted, #8E8E93)",
            flex: 1,
          }}>
            Edit todo
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none", border: "none", cursor: "pointer",
              padding: 4, color: "var(--gooni-muted, #8E8E93)",
              display: "flex",
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 20 }}>
          <Field label="Title">
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What needs doing?"
              style={inputStyle}
            />
          </Field>

          <Field label="Subtitle">
            <textarea
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              placeholder="Optional notes"
              rows={2}
              style={{ ...inputStyle, resize: "vertical", minHeight: 48, fontFamily: FONT }}
            />
          </Field>

          <Field label="State">
            <div style={{ display: "flex", gap: 6 }}>
              {STATES.map((s) => {
                const active = state === s.value;
                // Subtle dark slate active (was over-saturated green).
                // Matches Claude minimal — color signals selection, not
                // a status verdict.
                return (
                  <button
                    key={s.value}
                    onClick={() => setState(s.value)}
                    style={{
                      flex: 1,
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: active
                        ? "1px solid rgba(15,23,42,0.85)"
                        : "0.5px solid rgba(0,0,0,0.10)",
                      background: active ? "rgba(15,23,42,0.05)" : "transparent",
                      color: active ? "#0F172A" : "var(--gooni-muted, #6B7280)",
                      fontWeight: active ? 600 : 500,
                      fontSize: 13,
                      cursor: "pointer",
                      fontFamily: FONT,
                      transition: "all 0.15s",
                    }}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </Field>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Field label="Due date">
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                style={inputStyle}
              />
            </Field>

            <Field label="Focus">
              <select
                value={focusId ?? ""}
                onChange={(e) => setFocusId(e.target.value ? Number(e.target.value) : null)}
                style={inputStyle}
              >
                <option value="">— None —</option>
                {focuses.map((f) => (
                  <option key={f.id} value={f.id}>{f.text}</option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Primary">
            <button
              onClick={() => setIsPrimary((v) => !v)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                padding: "8px 12px", borderRadius: 8,
                // Muted slate when active (was warm-yellow chip).
                // Crown icon does the visual lifting; color stays calm.
                border: isPrimary
                  ? "1px solid rgba(15,23,42,0.85)"
                  : "0.5px solid rgba(0,0,0,0.10)",
                background: isPrimary ? "rgba(15,23,42,0.05)" : "transparent",
                color: isPrimary ? "#0F172A" : "var(--gooni-muted, #6B7280)",
                fontWeight: 500, fontSize: 13,
                cursor: "pointer", fontFamily: FONT,
              }}
            >
              <Crown size={14} fill={isPrimary ? "currentColor" : "none"} />
              {isPrimary ? "Crowned as primary" : "Make primary"}
            </button>
          </Field>

          {/* G3.5-polish: Lineage section. Shows parent + spawned-children
              when chainMeta is present, with a single click-through to
              the full chain view for inline editing (link/unlink/add).
              Absent chainMeta = todo has no lineage edges; section
              hides entirely so the modal doesn't carry empty noise. */}
          {chainMeta && (chainMeta.parent_id || chainMeta.children_total > 0) && (
            <Field label="Lineage">
              <div style={{
                display: "flex", flexDirection: "column", gap: 6,
                padding: "10px 12px",
                borderRadius: 8,
                background: "rgba(15,23,42,0.025)",
                border: "0.5px solid rgba(0,0,0,0.06)",
              }}>
                {chainMeta.parent_id && (
                  <div style={{
                    display: "flex", alignItems: "center", gap: 6,
                    fontSize: 12, color: "var(--gooni-muted, #6B7280)",
                  }}>
                    <ArrowLeft size={11} />
                    <span style={{ flexShrink: 0 }}>from:</span>
                    <span style={{
                      color: "var(--gooni-text, #1C1C1E)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {chainMeta.parent_text || `todo #${chainMeta.parent_id}`}
                    </span>
                  </div>
                )}
                {chainMeta.children_total > 0 && (
                  <div style={{
                    display: "flex", alignItems: "center", gap: 6,
                    fontSize: 12, color: "var(--gooni-muted, #6B7280)",
                  }}>
                    <ArrowUpRight size={11} />
                    <span>
                      spawned {chainMeta.children_total}
                      {chainMeta.children_done > 0 && (
                        <span style={{ marginLeft: 6 }}>
                          · {chainMeta.children_done} done
                        </span>
                      )}
                    </span>
                  </div>
                )}
                {onOpenChain && (
                  <button
                    onClick={() => onOpenChain(todo.id)}
                    style={{
                      alignSelf: "flex-start",
                      marginTop: 2,
                      background: "none", border: "none",
                      padding: 0, cursor: "pointer",
                      fontSize: 11, fontWeight: 500,
                      color: "var(--gooni-text, #1C1C1E)",
                      textDecoration: "underline",
                      fontFamily: FONT,
                    }}
                  >
                    view chain →
                  </button>
                )}
              </div>
            </Field>
          )}

          {focusId != null && (() => {
            const f = focuses.find((x) => x.id === focusId);
            if (!f) return null;
            const dot = resolveFocusColor(f.color, f.id);
            return (
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                fontSize: 12, color: "var(--gooni-muted, #6B7280)",
              }}>
                <span style={{
                  width: 8, height: 8, borderRadius: "50%", background: dot,
                }} />
                Linked to focus: {f.text}
              </div>
            );
          })()}

          {/* Meta */}
          <div style={{
            display: "flex", flexWrap: "wrap", gap: 16,
            fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
            paddingTop: 8,
            borderTop: "0.5px solid rgba(0,0,0,0.06)",
          }}>
            {todo.created_at && <span>created {fmtMeta(todo.created_at)}</span>}
            {todo.updated_at && <span>updated {fmtMeta(todo.updated_at)}</span>}
            {todo.completed_at && <span>completed {fmtMeta(todo.completed_at)}</span>}
            {todo.source_note_id != null && <span>from note #{todo.source_note_id}</span>}
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: "14px 24px 18px",
          borderTop: "0.5px solid rgba(0,0,0,0.06)",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          {confirmDel ? (
            <>
              <span style={{
                fontSize: 12, color: "#791F1F", flex: 1,
              }}>
                Delete this todo?
              </span>
              <button
                onClick={() => setConfirmDel(false)}
                style={btnSecondary}
              >
                Cancel
              </button>
              <button
                onClick={onDelete}
                style={{ ...btnDanger }}
              >
                Delete
              </button>
            </>
          ) : (
            <>
              {/* Destructive action de-amplified: small muted text link
                  on the left (was a loud red button). Confirm flow still
                  surfaces the destructive color when explicit. */}
              <button
                onClick={() => setConfirmDel(true)}
                title="Delete todo"
                style={{
                  background: "none", border: "none",
                  padding: 0, cursor: "pointer",
                  fontSize: 12,
                  color: "var(--gooni-muted, #8E8E93)",
                  display: "inline-flex", alignItems: "center", gap: 5,
                  fontFamily: FONT,
                }}
              >
                <Trash2 size={12} />
                delete
              </button>
              <div style={{ flex: 1 }} />
              <button onClick={onClose} style={btnSecondary}>Cancel</button>
              <button
                onClick={() => void onSave()}
                disabled={saving || !text.trim() || !dirty()}
                style={{
                  ...btnPrimary,
                  opacity: (saving || !text.trim() || !dirty()) ? 0.5 : 1,
                  cursor: (saving || !text.trim() || !dirty()) ? "not-allowed" : "pointer",
                }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{
        fontSize: 10, fontWeight: 600, letterSpacing: 0.5,
        textTransform: "uppercase",
        color: "var(--gooni-muted, #8E8E93)",
      }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function fmtMeta(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = Date.now();
  const diffSec = (now - d.getTime()) / 1000;
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.round(diffSec / 86400)}d ago`;
  return d.toLocaleDateString();
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "0.5px solid rgba(0,0,0,0.14)",
  background: "var(--gooni-card, #fff)",
  color: "var(--gooni-text, #1C1C1E)",
  fontSize: 13,
  fontFamily: FONT,
  outline: "none",
  boxSizing: "border-box",
};

const btnSecondary: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "0.5px solid rgba(0,0,0,0.12)",
  background: "transparent",
  color: "var(--gooni-text, #1C1C1E)",
  fontSize: 13, fontWeight: 500,
  cursor: "pointer",
  fontFamily: FONT,
};

const btnPrimary: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: 8,
  border: "none",
  // Dark slate instead of green — primary CTA is monochrome per Claude
  // aesthetic. Color reserved for status signals (age pill, doing dot).
  background: "#0F172A",
  color: "#fff",
  fontSize: 13, fontWeight: 600,
  cursor: "pointer",
  fontFamily: FONT,
};

const btnDanger: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "none",
  background: "#C76B6B",
  color: "#fff",
  fontSize: 13, fontWeight: 600,
  cursor: "pointer",
  fontFamily: FONT,
};
