import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { patchPromise, type ApiPromise, type PromiseState } from "../../services/api";
import { parseServerDate } from "../../utils/date";
import { Modal, FONT, color as ctok } from "../../ui";

// Full-details view for a promise — mirrors TodoEditModal / HabitDetailModal.
// Edit the display text + deadline, flip state (active/kept/broken), and
// see provenance (slip history, source message). `text` rewrites the
// promise summary; the raw utterance is preserved server-side.

const STATES: { value: PromiseState; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "kept", label: "Kept" },
  { value: "broken", label: "Broken" },
];

const STATE_COLOR: Record<PromiseState, string> = {
  active: ctok.accent,
  kept: "#15803D",
  broken: "#B91C1C",
};

// inferred_due is stored naive-UTC; the datetime-local input is naive-local.
// Convert both ways so the wall-clock the user sees matches what's stored.
function toLocalInputValue(iso: string | null): string {
  const d = parseServerDate(iso);
  if (!d) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInputValue(v: string): string | null {
  if (!v) return null;
  // new Date(naive) reads as local; toISOString → UTC. Drop millis so the
  // backend's fromisoformat parse stays simple.
  return new Date(v).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function PromiseDetailModal({
  promise,
  onClose,
  onChanged,
}: {
  promise: ApiPromise;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [text, setText] = useState(promise.summary || promise.utterance);
  const [state, setState] = useState<PromiseState>(promise.state);
  const [due, setDue] = useState(toLocalInputValue(promise.inferred_due));
  const [saving, setSaving] = useState(false);

  const origText = promise.summary || promise.utterance;
  const origDue = toLocalInputValue(promise.inferred_due);
  const dirty = text.trim() !== origText || state !== promise.state || due !== origDue;

  async function onSave() {
    if (saving || !text.trim() || !dirty) return;
    setSaving(true);
    try {
      const patch: { text?: string; due?: string | null; state?: PromiseState } = {};
      if (text.trim() !== origText) patch.text = text.trim();
      if (due !== origDue) patch.due = fromLocalInputValue(due);
      if (state !== promise.state) patch.state = state;
      await patchPromise(promise.id, patch);
      onChanged();
      onClose();
    } catch (e) {
      console.error("save promise failed", e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Promise" width={460} disableBackdropClose
      footer={
        <>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button
            onClick={() => void onSave()}
            disabled={saving || !text.trim() || !dirty}
            style={{
              ...btnPrimary,
              opacity: saving || !text.trim() || !dirty ? 0.5 : 1,
              cursor: saving || !text.trim() || !dirty ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 18, fontFamily: FONT }}>
        <Field label="Promise">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. hit the gym tonight"
            rows={2}
            style={{ ...inputStyle, resize: "vertical", minHeight: 48, lineHeight: 1.5 }}
          />
        </Field>

        <Field label="State">
          <div style={{ display: "flex", gap: 6 }}>
            {STATES.map((s) => {
              const active = state === s.value;
              return (
                <button
                  key={s.value}
                  onClick={() => setState(s.value)}
                  style={{
                    flex: 1, padding: "8px 10px", borderRadius: 8,
                    border: active ? `1px solid ${STATE_COLOR[s.value]}` : "0.5px solid rgba(0,0,0,0.10)",
                    background: active ? `${STATE_COLOR[s.value]}14` : "transparent",
                    color: active ? STATE_COLOR[s.value] : ctok.muted,
                    fontWeight: active ? 600 : 500, fontSize: 13,
                    cursor: "pointer", fontFamily: FONT,
                  }}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Due">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              style={{ ...inputStyle, width: "auto" }}
            />
            {due && (
              <button
                onClick={() => setDue("")}
                style={{
                  border: "none", background: "transparent", color: ctok.muted,
                  cursor: "pointer", fontSize: 12, fontFamily: FONT,
                }}
              >
                Clear
              </button>
            )}
          </div>
        </Field>

        {/* Meta — slip history + provenance. Read-only. */}
        <div style={{
          display: "flex", flexWrap: "wrap", gap: 16,
          fontSize: 11, color: ctok.muted,
          paddingTop: 8, borderTop: "0.5px solid rgba(0,0,0,0.06)",
        }}>
          {promise.slip_count >= 2 && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#D97706" }}>
              <AlertTriangle size={11} strokeWidth={2.2} />
              slipped ×{promise.slip_count} before
            </span>
          )}
          {promise.source_message_id != null && <span>from message #{promise.source_message_id}</span>}
          {promise.created_at && <span>captured {fmtMeta(promise.created_at)}</span>}
          {promise.resolved_at && <span>resolved {fmtMeta(promise.resolved_at)}</span>}
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{
        fontSize: 10, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase",
        color: ctok.muted,
      }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function fmtMeta(iso: string): string {
  const d = parseServerDate(iso);
  if (!d) return iso;
  const diffSec = (Date.now() - d.getTime()) / 1000;
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.round(diffSec / 86400)}d ago`;
  return d.toLocaleDateString();
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 8,
  border: "0.5px solid rgba(0,0,0,0.14)",
  background: "var(--gooni-card, #fff)", color: "var(--gooni-text, #1C1C1E)",
  fontSize: 13, fontFamily: FONT, outline: "none", boxSizing: "border-box",
};

const btnSecondary: React.CSSProperties = {
  padding: "8px 14px", borderRadius: 8,
  border: "0.5px solid rgba(0,0,0,0.12)", background: "transparent",
  color: "var(--gooni-text, #1C1C1E)", fontSize: 13, fontWeight: 500,
  cursor: "pointer", fontFamily: FONT,
};

const btnPrimary: React.CSSProperties = {
  padding: "8px 16px", borderRadius: 8, border: "none",
  background: "#0F172A", color: "#fff", fontSize: 13, fontWeight: 600,
  cursor: "pointer", fontFamily: FONT,
};
