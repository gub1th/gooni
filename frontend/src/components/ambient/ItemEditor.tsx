import { useState } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  createPromise,
  patchPromise,
  deletePromise,
} from "../../services/api";
import { FONT } from "../../ui";
import { localToIso } from "./calendarDates";

// The ONE create/edit modal, generalized over the time-anchored primitives that
// live on a day surface. Extracted from CalendarPanel's old EventEditor so both
// the full calendar panel AND the home-dashboard timeline drive the same form.
//
//   event   → Google Calendar (name + date + start/end; all-day = rename only)
//   promise → a v2 Promise given a real due-time (name + date + single time)
//
// Portal-rendered to document.body so the fixed scrim escapes any transformed /
// blurred ancestor (the widget overlay, the dashboard's fixed root).

export type ItemKind = "event" | "promise";

export interface ItemEditorState {
  kind: ItemKind;
  mode: "create" | "edit";
  /** gcal event id (string) or promise id (as string) when mode==="edit". */
  id?: string;
  summary: string;
  dayKey: string; // YYYY-MM-DD (local)
  startTime: string; // HH:MM
  endTime: string; // HH:MM — event only
  allDay: boolean; // event only; editing an all-day event → time locked
}

export function ItemEditor({
  editor,
  onChange,
  onClose,
  onSaved,
}: {
  editor: ItemEditorState;
  onChange: (e: ItemEditorState) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isPromise = editor.kind === "promise";

  async function save() {
    const summary = editor.summary.trim();
    if (!summary) {
      setErr(isPromise ? "Give the promise a name" : "Give the event a name");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      if (isPromise) {
        const due = localToIso(editor.dayKey, editor.startTime);
        if (editor.mode === "create") {
          const p = await createPromise(summary);
          // createPromise has no due param → set the real time in a follow-up
          // patch (same two-step the drag-to-schedule path uses).
          await patchPromise(p.id, { due });
        } else if (editor.id) {
          await patchPromise(Number(editor.id), { text: summary, due });
        }
      } else if (editor.mode === "create") {
        await createCalendarEvent({
          summary,
          start_iso: localToIso(editor.dayKey, editor.startTime),
          end_iso: localToIso(editor.dayKey, editor.endTime),
        });
      } else if (editor.id) {
        await updateCalendarEvent(editor.id, {
          summary,
          // All-day events keep their span — only rename them here.
          ...(editor.allDay
            ? {}
            : {
                start_iso: localToIso(editor.dayKey, editor.startTime),
                end_iso: localToIso(editor.dayKey, editor.endTime),
              }),
        });
      }
      onSaved();
    } catch {
      setErr("Save failed — try again");
      setSaving(false);
    }
  }

  async function del() {
    if (!editor.id) return;
    setSaving(true);
    setErr(null);
    try {
      if (isPromise) await deletePromise(Number(editor.id));
      else await deleteCalendarEvent(editor.id);
      onSaved();
    } catch {
      setErr("Delete failed — try again");
      setSaving(false);
    }
  }

  const title =
    (editor.mode === "create" ? "New " : "Edit ") + (isPromise ? "promise" : "event");

  return createPortal(
    <div onClick={onClose} style={editorScrim}>
      <div onClick={(e) => e.stopPropagation()} style={editorCard}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>{title}</div>

        {/* kind toggle — only when creating; an existing item's kind is fixed */}
        {editor.mode === "create" && (
          <div style={{ display: "flex", gap: 2, background: "rgb(var(--gooni-ink, 244 245 244) / 0.07)", borderRadius: 8, padding: 2, marginBottom: 12 }}>
            {(["event", "promise"] as const).map((k) => {
              const active = editor.kind === k;
              return (
                <button
                  key={k}
                  onClick={() => onChange({ ...editor, kind: k })}
                  style={{
                    flex: 1,
                    border: "none",
                    cursor: "pointer",
                    fontFamily: FONT,
                    fontSize: 12,
                    fontWeight: active ? 600 : 500,
                    padding: "5px 0",
                    borderRadius: 6,
                    color: active ? "rgb(var(--gooni-surf, 11 15 13))" : "rgb(var(--gooni-ink, 244 245 244) / 0.7)",
                    background: active ? GREEN : "transparent",
                  }}
                >
                  {k}
                </button>
              );
            })}
          </div>
        )}

        <input
          autoFocus
          value={editor.summary}
          onChange={(e) => onChange({ ...editor, summary: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") onClose();
          }}
          placeholder={isPromise ? "What did you commit to?" : "What's happening?"}
          style={editorInput}
        />

        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <label style={fieldLabel}>
            Date
            <input
              type="date"
              value={editor.dayKey}
              disabled={editor.allDay}
              onChange={(e) => onChange({ ...editor, dayKey: e.target.value })}
              style={editorSmall}
            />
          </label>
          {!editor.allDay && (
            <>
              <label style={fieldLabel}>
                {isPromise ? "Time" : "Start"}
                <input
                  type="time"
                  value={editor.startTime}
                  onChange={(e) => onChange({ ...editor, startTime: e.target.value })}
                  style={editorSmall}
                />
              </label>
              {!isPromise && (
                <label style={fieldLabel}>
                  End
                  <input
                    type="time"
                    value={editor.endTime}
                    onChange={(e) => onChange({ ...editor, endTime: e.target.value })}
                    style={editorSmall}
                  />
                </label>
              )}
            </>
          )}
        </div>

        {editor.allDay && (
          <div style={{ fontSize: 11, color: "rgb(var(--gooni-ink, 244 245 244) / 0.45)", marginTop: 8 }}>
            All-day event — rename only.
          </div>
        )}

        {err && <div style={{ fontSize: 12, color: "#FF6B6B", marginTop: 10 }}>{err}</div>}

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16 }}>
          {editor.mode === "edit" && (
            <button aria-label="Delete" onClick={del} disabled={saving} style={deleteBtn}>
              <Trash2 size={15} />
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={onClose} disabled={saving} style={ghostBtn}>
            Cancel
          </button>
          <button onClick={save} disabled={saving} style={primaryBtn}>
            {saving ? "…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const GREEN = "rgba(74,222,128,0.9)";

const editorScrim: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 4000,
};

const editorCard: React.CSSProperties = {
  width: 360,
  maxWidth: "calc(100% - 40px)",
  background: "#121715",
  border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.14)",
  borderRadius: 14,
  padding: "18px 18px 16px",
  fontFamily: FONT,
  color: "rgb(var(--gooni-ink, 244 245 244))",
};

const editorInput: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "rgb(var(--gooni-ink, 244 245 244) / 0.06)",
  border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.14)",
  borderRadius: 8,
  padding: "9px 11px",
  color: "rgb(var(--gooni-ink, 244 245 244))",
  fontFamily: FONT,
  fontSize: 14,
  outline: "none",
};

const editorSmall: React.CSSProperties = {
  ...editorInput,
  fontSize: 12.5,
  padding: "7px 9px",
  colorScheme: "dark",
};

const fieldLabel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 10.5,
  color: "rgb(var(--gooni-ink, 244 245 244) / 0.5)",
  textTransform: "uppercase",
  letterSpacing: 0.4,
  flex: 1,
};

const primaryBtn: React.CSSProperties = {
  border: "none",
  cursor: "pointer",
  background: GREEN,
  color: "rgb(var(--gooni-surf, 11 15 13))",
  fontWeight: 600,
  borderRadius: 8,
  padding: "7px 16px",
  fontSize: 13,
  fontFamily: FONT,
};

const ghostBtn: React.CSSProperties = {
  border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.18)",
  cursor: "pointer",
  background: "transparent",
  color: "rgb(var(--gooni-ink, 244 245 244) / 0.75)",
  borderRadius: 8,
  padding: "7px 14px",
  fontSize: 13,
  fontFamily: FONT,
};

const deleteBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  borderRadius: 8,
  border: "1px solid rgba(255,107,107,0.3)",
  background: "transparent",
  color: "#FF6B6B",
  cursor: "pointer",
};
