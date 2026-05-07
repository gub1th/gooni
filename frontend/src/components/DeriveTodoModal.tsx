import { useEffect, useState } from "react";
import { Modal, modalCancelBtn, modalPrimaryBtn } from "./Modal";
import { deriveTodoFromFocus } from "../services/api";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

interface DeriveTodoModalProps {
  open: boolean;
  focusId: number | null;     // null guards against rendering w/o context
  focusTitle?: string;        // shown as helper text so user knows what they're deriving from
  onClose: () => void;
  onCreated: () => void;      // caller invalidates today-todos query etc.
}

type DueChoice = "today" | "tomorrow" | null;

export function DeriveTodoModal({
  open,
  focusId,
  focusTitle,
  onClose,
  onCreated,
}: DeriveTodoModalProps) {
  const [text, setText] = useState("");
  const [due, setDue] = useState<DueChoice>("today");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on each open so re-deriving from a different focus doesn't show
  // the previous title.
  useEffect(() => {
    if (open) {
      setText("");
      setDue("today");
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  async function submit() {
    const t = text.trim();
    if (!t || focusId == null) return;
    setSubmitting(true);
    setError(null);
    try {
      await deriveTodoFromFocus(focusId, t, due);
      onCreated();
      onClose();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Derive todo"
      footer={
        <>
          <button onClick={onClose} style={modalCancelBtn} disabled={submitting}>
            Cancel
          </button>
          <button
            onClick={submit}
            style={{ ...modalPrimaryBtn, opacity: text.trim() && !submitting ? 1 : 0.5 }}
            disabled={!text.trim() || submitting}
          >
            {submitting ? "Saving…" : "Create"}
          </button>
        </>
      }
    >
      {focusTitle && (
        <div style={{
          fontSize: 12, color: "var(--gooni-muted, #8E8E93)", marginBottom: 10,
          fontFamily: FONT,
        }}>
          From focus <strong style={{ color: "var(--gooni-text, #1C1C1E)" }}>{focusTitle}</strong>
        </div>
      )}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void submit(); }
        }}
        placeholder="What's the todo?"
        style={{
          width: "100%", boxSizing: "border-box",
          padding: "10px 12px",
          border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.15))",
          borderRadius: 8,
          fontSize: 14, fontFamily: FONT,
          color: "var(--gooni-text, #1C1C1E)",
          background: "var(--gooni-card, #FFF)",
          outline: "none",
        }}
      />
      <div style={{
        display: "flex", gap: 6, marginTop: 12,
      }}>
        {(["today", "tomorrow", null] as DueChoice[]).map((opt) => {
          const active = due === opt;
          const label = opt === null ? "No date" : opt === "today" ? "Today" : "Tomorrow";
          return (
            <button
              key={String(opt)}
              type="button"
              onClick={() => setDue(opt)}
              style={{
                padding: "4px 11px", borderRadius: 999,
                border: `0.5px solid ${active ? "rgba(74,222,128,0.55)" : "var(--gooni-border, rgba(0,0,0,0.15))"}`,
                background: active ? "rgba(74,222,128,0.14)" : "transparent",
                color: active ? "#15803D" : "var(--gooni-text, #1C1C1E)",
                fontSize: 12, fontWeight: 500, fontFamily: FONT,
                cursor: "pointer",
                transition: "background 0.12s, border-color 0.12s, color 0.12s",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
      {error && (
        <div style={{
          marginTop: 10, fontSize: 12, color: "#C44",
          fontFamily: FONT,
        }}>
          {error}
        </div>
      )}
    </Modal>
  );
}
