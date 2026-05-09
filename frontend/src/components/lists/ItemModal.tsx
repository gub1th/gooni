import { useEffect, useRef, useState } from "react";
import type { BoardStatus } from "../../services/api";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

// Structural shape — accepts either ApiListItem (generic) or
// ApiBacklogTicket (board fields filled). Both flows pipe through here so
// the form chrome stays uniform; the parent decides which patch to apply
// via its own store.
export interface ItemModalItem {
  id: number;
  text: string;
  subtitle: string | null;
  done: boolean;
  actionable?: boolean;
  due_date?: string | null;
  board_status?: BoardStatus | null;
  pr_url?: string | null;
  source_note_id: number | null;
}

export interface ItemModalProps {
  item: ItemModalItem;
  // Callers patch fields they own. The modal itself never persists — it just
  // surfaces the diff so the parent can hit the right endpoint (list-items
  // vs backlog-tickets) and update its store.
  onSave: (patch: {
    text?: string;
    subtitle?: string | null;
    done?: boolean;
    actionable?: boolean;
    due_date?: string | null;
    board_status?: BoardStatus | null;
    pr_url?: string | null;
  }) => Promise<void> | void;
  onDelete?: () => void;
  onClose: () => void;
  // True when this item is the primary focus — surfaces a small badge.
  isPrimary?: boolean;
  // True for backlog items — surfaces the Jira board fields (status select +
  // PR link). Hidden for todo / focus / generic lists where they'd just be
  // noise.
  showBoardFields?: boolean;
  // Called when the user clicks the "from note #N" pill. Navigates to
  // that note. Only rendered when item.source_note_id is set.
  onOpenSourceNote?: (noteId: number) => void;
}

function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fromDateInputValue(v: string): string | null {
  if (!v) return null;
  // Treat as midnight UTC so the backend's date-only intent survives
  // round-trips without timezone wobble.
  return new Date(`${v}T00:00:00`).toISOString();
}

export function ItemModal({ item, onSave, onDelete, onClose, isPrimary, showBoardFields, onOpenSourceNote }: ItemModalProps) {
  const [text, setText] = useState(item.text);
  const [subtitle, setSubtitle] = useState(item.subtitle ?? "");
  const [actionable, setActionable] = useState(item.actionable ?? true);
  const [done, setDone] = useState(item.done);
  const [dueDate, setDueDate] = useState(toDateInputValue(item.due_date ?? null));
  const [boardStatus, setBoardStatus] = useState<BoardStatus>(
    (item.board_status as BoardStatus | null) || (item.done ? "done" : "todo")
  );
  const [prUrl, setPrUrl] = useState(item.pr_url ?? "");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLInputElement>(null);

  // Focus the title input on mount so users can immediately start typing.
  useEffect(() => { textRef.current?.focus(); }, []);

  // ESC closes. Capture phase so it beats anything else listening on body.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSave() {
    if (saving) return;
    const patch: Parameters<typeof onSave>[0] = {};
    const trimmedText = text.trim();
    if (trimmedText && trimmedText !== item.text) patch.text = trimmedText;
    const trimmedSub = subtitle.trim();
    const currentSub = item.subtitle ?? "";
    if (trimmedSub !== currentSub) patch.subtitle = trimmedSub || null;
    if (item.actionable !== undefined && actionable !== item.actionable) patch.actionable = actionable;
    if (actionable && done !== item.done) patch.done = done;
    const nextDue = fromDateInputValue(dueDate);
    const currentDue = item.due_date ?? null;
    if ((nextDue || null) !== (currentDue || null)) patch.due_date = nextDue;
    if (showBoardFields) {
      const currentBoard = (item.board_status as BoardStatus | null) || (item.done ? "done" : "todo");
      if (boardStatus !== currentBoard) patch.board_status = boardStatus;
      const trimmedPr = prUrl.trim();
      if ((trimmedPr || null) !== (item.pr_url || null)) patch.pr_url = trimmedPr || null;
    }
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await onSave(patch);
      onClose();
    } catch (e) {
      console.error("ItemModal save failed", e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 18, 24, 0.45)",
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        animation: "gooni-modal-in 160ms ease-out",
      }}
    >
      <style>{`
        @keyframes gooni-modal-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes gooni-modal-card-in {
          from { opacity: 0; transform: translateY(8px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0)    scale(1);    }
        }
      `}</style>
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 100%)",
          background: "#FFFFFF",
          borderRadius: 14,
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
          fontFamily: FONT,
          padding: 24,
          maxHeight: "90vh",
          overflowY: "auto",
          animation: "gooni-modal-card-in 200ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "#8E8E93", letterSpacing: 0.5, textTransform: "uppercase" }}>
              {actionable ? "Task" : "Idea"}
            </span>
            {isPrimary && (
              <span style={{
                fontSize: 10, color: "#92400E", background: "#FEF3C7",
                padding: "2px 8px", borderRadius: 999,
                textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700,
              }}>
                Primary
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              border: "none", background: "transparent", color: "#9CA3AF",
              cursor: "pointer", fontSize: 22, padding: 0, lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        <input
          ref={textRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Title"
          style={{
            width: "100%", boxSizing: "border-box",
            border: "none", outline: "none",
            fontSize: 20, fontWeight: 600, color: "#1C1C1E",
            background: "transparent",
            padding: "4px 0 8px",
            fontFamily: FONT,
            textDecoration: actionable && done ? "line-through" : "none",
          }}
        />

        {/* Source note pill — only rendered when this item was created
            from a note (source_note_id set). Daniel asked that the inline
            "from note #N" reference be hidden on the card and only show
            here, where the user can actually navigate to it. */}
        {item.source_note_id != null && onOpenSourceNote && (
          <button
            onClick={() => { onOpenSourceNote(item.source_note_id!); onClose(); }}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "4px 10px", borderRadius: 999,
              border: "1px solid rgba(0,0,0,0.10)",
              background: "#F5F5F7", color: "#3C3C43",
              fontFamily: FONT, fontSize: 11.5, fontWeight: 500,
              cursor: "pointer",
              marginBottom: 12,
              alignSelf: "flex-start",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#EBEBEF"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#F5F5F7"; }}
          >
            from note #{item.source_note_id} →
          </button>
        )}

        <textarea
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          placeholder="Add a description…"
          rows={4}
          style={{
            width: "100%", boxSizing: "border-box",
            border: "none", outline: "none",
            fontSize: 14, color: "#3C3C43",
            background: "#F9FAFB",
            padding: 12,
            borderRadius: 8,
            resize: "vertical",
            fontFamily: FONT,
            lineHeight: 1.5,
            marginBottom: 16,
          }}
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 18 }}>
          {showBoardFields && (
            <>
              <div>
                <div style={{ fontSize: 13, color: "#1C1C1E", fontWeight: 500, marginBottom: 6 }}>Status</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {(["todo", "in_progress", "done"] as BoardStatus[]).map((s) => (
                    <button
                      key={s}
                      onClick={() => setBoardStatus(s)}
                      style={{
                        padding: "6px 12px", borderRadius: 999,
                        border: boardStatus === s ? "1px solid #1C1C1E" : "1px solid #E5E7EB",
                        background: boardStatus === s ? "#1C1C1E" : "#FFFFFF",
                        color: boardStatus === s ? "#FFFFFF" : "#3C3C43",
                        fontFamily: FONT, fontSize: 12, fontWeight: 500,
                        cursor: "pointer",
                      }}
                    >
                      {s === "todo" ? "Todo" : s === "in_progress" ? "In progress" : "Done"}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 13, color: "#1C1C1E", fontWeight: 500, marginBottom: 6 }}>PR / Reference link</div>
                <input
                  type="url"
                  value={prUrl}
                  onChange={(e) => setPrUrl(e.target.value)}
                  placeholder="https://github.com/..."
                  style={{
                    width: "100%", boxSizing: "border-box",
                    fontFamily: FONT, fontSize: 13, padding: "8px 10px",
                    border: "1px solid #E5E7EB", borderRadius: 8, color: "#1C1C1E",
                    outline: "none",
                  }}
                />
              </div>
            </>
          )}
          {!showBoardFields && (
            <ToggleRow
              label="Task with checkbox"
              help={actionable ? "Item shows a checkbox and can be marked done." : "Item is a bullet idea — no checkbox."}
              value={actionable}
              onChange={setActionable}
            />
          )}
          {!showBoardFields && actionable && (
            <ToggleRow
              label="Marked done"
              help={done ? "Hidden from open list, shown in done section." : "Active item."}
              value={done}
              onChange={setDone}
            />
          )}
          {!showBoardFields && (
            <div>
              <div style={{ fontSize: 13, color: "#1C1C1E", fontWeight: 500, marginBottom: 6 }}>Due date</div>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                style={{
                  fontFamily: FONT, fontSize: 13, padding: "6px 10px",
                  border: "1px solid #E5E7EB", borderRadius: 8, color: "#1C1C1E",
                  outline: "none",
                }}
              />
              {dueDate && (
                <button
                  onClick={() => setDueDate("")}
                  style={{
                    marginLeft: 8, border: "none", background: "transparent",
                    color: "#9CA3AF", cursor: "pointer", fontSize: 12, fontFamily: FONT,
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          {onDelete ? (
            confirmDelete ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "#9CA3AF" }}>Delete?</span>
                <button
                  onClick={() => { onDelete(); onClose(); }}
                  style={{
                    border: "none", background: "#DC2626", color: "#FFF",
                    fontFamily: FONT, fontSize: 12, fontWeight: 600,
                    padding: "6px 12px", borderRadius: 6, cursor: "pointer",
                  }}
                >
                  Delete
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  style={{
                    border: "none", background: "transparent", color: "#6B7280",
                    fontFamily: FONT, fontSize: 12, padding: "6px 8px", borderRadius: 6, cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                style={{
                  border: "none", background: "transparent", color: "#9CA3AF",
                  fontFamily: FONT, fontSize: 12, cursor: "pointer", padding: "6px 0",
                }}
              >
                Delete item
              </button>
            )
          ) : <span />}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              style={{
                border: "1px solid #E5E7EB", background: "#FFFFFF", color: "#1C1C1E",
                fontFamily: FONT, fontSize: 13, fontWeight: 500,
                padding: "8px 14px", borderRadius: 8, cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                border: "none", background: saving ? "#6B7280" : "#1C1C1E", color: "#FFFFFF",
                fontFamily: FONT, fontSize: 13, fontWeight: 600,
                padding: "8px 16px", borderRadius: 8, cursor: saving ? "default" : "pointer",
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
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
