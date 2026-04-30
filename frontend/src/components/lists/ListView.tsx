import { useEffect, useMemo, useRef, useState } from "react";
import { useListsStore } from "../../stores/useListsStore";
import type { ApiListItem, ListType } from "../../services/api";
import { ItemModal } from "./ItemModal";
import { getPrimaryDragBus } from "../PrimaryFocusCard";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
const CONTENT_MAX_WIDTH = 720;

interface ListViewProps {
  listId: number;
  onOpenSourceNote?: (noteId: number) => void;
}

function copyForType(type: ListType): { composer: string; doneLabel: string; emptyHint: string } {
  switch (type) {
    case "todo":
      return {
        composer: "Add a todo…",
        doneLabel: "done",
        emptyHint: "No todos yet. Add one below.",
      };
    case "backlog":
      return {
        composer: "Add to backlog…",
        doneLabel: "shipped",
        emptyHint: "Backlog is empty. Items appear here when Gooni hits a capability gap.",
      };
    default:
      return {
        composer: "Add an item…",
        doneLabel: "done",
        emptyHint: "List is empty.",
      };
  }
}

function formatDueDate(iso: string): string {
  const due = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueDay = new Date(due);
  dueDay.setHours(0, 0, 0, 0);
  const diff = Math.round((dueDay.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 0 && diff <= 7) return `In ${diff} days`;
  if (diff < 0) return `${Math.abs(diff)}d late`;
  return due.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  // Backend ISO strings come without trailing Z — treat them as UTC.
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}mo ago`;
  return `${Math.floor(month / 12)}y ago`;
}

export function ListView({ listId, onOpenSourceNote }: ListViewProps) {
  const list = useListsStore((s) => s.lists.find((l) => l.id === listId));
  const items = useListsStore((s) => s.itemsByListId[listId] || []);
  const selectList = useListsStore((s) => s.selectList);
  const addItem = useListsStore((s) => s.addItem);
  const updateItem = useListsStore((s) => s.updateItem);
  const deleteItem = useListsStore((s) => s.deleteItem);
  const updateList = useListsStore((s) => s.updateList);
  const deleteList = useListsStore((s) => s.deleteList);
  const reorder = useListsStore((s) => s.reorder);

  const [composer, setComposer] = useState("");
  const [composerKind, setComposerKind] = useState<"task" | "idea">("task");
  const [flashId, setFlashId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [confirmingListDelete, setConfirmingListDelete] = useState(false);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropBeforeId, setDropBeforeId] = useState<number | null>(null);
  const [modalItemId, setModalItemId] = useState<number | null>(null);
  // Tick every minute so relative timestamps stay fresh without per-row state.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setNowTick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const composerRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => { selectList(listId); }, [listId, selectList]);

  const copy = useMemo(() => copyForType(list?.type || "generic"), [list?.type]);

  // Open vs done split — ideas (non-actionable) live in `open` regardless of `done`.
  const { open, done } = useMemo(() => {
    const open: ApiListItem[] = [];
    const done: ApiListItem[] = [];
    for (const it of items) {
      if (it.actionable && it.done) done.push(it);
      else open.push(it);
    }
    open.sort((a, b) => a.sort_order - b.sort_order);
    done.sort((a, b) => (b.completed_at || "").localeCompare(a.completed_at || ""));
    return { open, done };
  }, [items]);

  async function handleAdd() {
    const text = composer.trim();
    if (!text) return;
    setComposer("");
    try {
      const created = await addItem(listId, text, { actionable: composerKind === "task" });
      composerRef.current?.focus();
      // Scroll to + flash the new row so user sees it land.
      requestAnimationFrame(() => {
        const el = itemRefs.current.get(created.id);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        setFlashId(created.id);
        window.setTimeout(() => {
          setFlashId((curr) => (curr === created.id ? null : curr));
        }, 1100);
      });
    } catch (e) {
      console.error("addItem failed", e);
      setComposer(text);
    }
  }

  if (!list) {
    return (
      <div style={{ flex: 1, padding: 40, fontFamily: FONT, color: "#8E8E93" }}>
        Loading…
      </div>
    );
  }

  function handleDrop(targetId: number | null) {
    if (draggingId == null) return;
    // Reorder within OPEN section only — done items stay grouped at bottom.
    const ids = open.map((it) => it.id);
    const fromIdx = ids.indexOf(draggingId);
    if (fromIdx === -1) {
      setDraggingId(null);
      setDropBeforeId(null);
      return;
    }
    ids.splice(fromIdx, 1);
    const toIdx = targetId == null ? ids.length : ids.indexOf(targetId);
    ids.splice(toIdx === -1 ? ids.length : toIdx, 0, draggingId);
    setDraggingId(null);
    setDropBeforeId(null);
    reorder(listId, ids).catch((e) => console.error("reorder failed", e));
  }

  const renderRow = (it: ApiListItem, opts: { draggable: boolean }) => (
    <ListItemRow
      key={it.id}
      item={it}
      onToggle={() => updateItem(it.id, { done: !it.done })}
      onDelete={() => deleteItem(it.id)}
      onToggleActionable={() => updateItem(it.id, { actionable: !it.actionable })}
      onOpenSourceNote={onOpenSourceNote}
      onOpenDetail={() => setModalItemId(it.id)}
      onMakePrimary={(list?.type as string) === "focus" ? () => {
        updateItem(it.id, { is_primary: true });
        window.dispatchEvent(new CustomEvent("gooni-primary-changed"));
      } : undefined}
      doneLabel={copy.doneLabel}
      flashing={flashId === it.id}
      registerRef={(el) => {
        if (el) itemRefs.current.set(it.id, el);
        else itemRefs.current.delete(it.id);
      }}
      draggable={opts.draggable}
      isDragging={draggingId === it.id}
      dropIndicator={dropBeforeId === it.id}
      onDragStart={() => {
        setDraggingId(it.id);
        if ((list?.type as string) === "focus") {
          getPrimaryDragBus().current = { id: it.id };
        }
      }}
      onDragEnd={() => {
        setDraggingId(null);
        setDropBeforeId(null);
        getPrimaryDragBus().current = null;
      }}
      onDragOverRow={() => { if (draggingId != null && draggingId !== it.id) setDropBeforeId(it.id); }}
      onDropRow={() => handleDrop(it.id)}
    />
  );

  const modalItem = modalItemId == null ? null : items.find((it) => it.id === modalItemId) || null;

  // Canonical singletons (todo / backlog / focus) are recreated on next boot,
  // so the backend refuses to delete them. Hide the trash for those.
  const canDeleteList = !["todo", "backlog", "focus"].includes(list.type as string);

  function startEditTitle() {
    setTitleDraft(list?.name ?? "");
    setEditingTitle(true);
  }

  async function commitTitleEdit() {
    setEditingTitle(false);
    const next = titleDraft.trim();
    if (!list || !next || next === list.name) return;
    try {
      await updateList(list.id, { name: next });
    } catch (e) {
      console.error("rename list failed", e);
    }
  }

  async function handleDeleteList() {
    if (!list) return;
    try {
      await deleteList(list.id);
    } catch (e) {
      console.error("delete list failed", e);
      alert(e instanceof Error ? e.message : "Failed to delete list");
    }
  }

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#FFFFFF",
        fontFamily: FONT,
        overflowY: "auto",
      }}
    >
      <div style={{ width: "100%", maxWidth: CONTENT_MAX_WIDTH, margin: "0 auto", padding: "0 24px" }}>
        <div style={{ padding: "32px 0 16px", borderBottom: "1px solid #F2F2F7" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {list.emoji && <span style={{ fontSize: 22 }}>{list.emoji}</span>}
            {editingTitle ? (
              <input
                value={titleDraft}
                autoFocus
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitleEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTitleEdit();
                  if (e.key === "Escape") { setTitleDraft(list.name); setEditingTitle(false); }
                }}
                style={{
                  fontSize: 24,
                  fontWeight: 600,
                  color: "#1C1C1E",
                  fontFamily: FONT,
                  border: "none",
                  outline: "none",
                  background: "#F2F2F7",
                  borderRadius: 6,
                  padding: "2px 6px",
                  minWidth: 200,
                }}
              />
            ) : (
              <h1
                onClick={startEditTitle}
                title="Click to rename"
                style={{
                  fontSize: 24,
                  fontWeight: 600,
                  color: "#1C1C1E",
                  margin: 0,
                  cursor: "text",
                  padding: "2px 6px",
                  marginLeft: -6,
                  borderRadius: 6,
                  transition: "background 120ms",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLHeadingElement).style.background = "#F2F2F7"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLHeadingElement).style.background = "transparent"; }}
              >
                {list.name}
              </h1>
            )}
            <span
              style={{
                marginLeft: 6,
                fontSize: 11,
                color: "#8E8E93",
                textTransform: "uppercase",
                letterSpacing: 0.5,
                background: "#F2F2F7",
                padding: "2px 8px",
                borderRadius: 999,
              }}
            >
              {list.type}
            </span>
            {canDeleteList && (
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                {confirmingListDelete ? (
                  <>
                    <span style={{ fontSize: 12, color: "#9CA3AF" }}>Delete this list?</span>
                    <button
                      onClick={handleDeleteList}
                      style={{
                        border: "none",
                        background: "#DC2626",
                        color: "#FFFFFF",
                        fontFamily: FONT,
                        fontSize: 12,
                        fontWeight: 600,
                        padding: "4px 12px",
                        borderRadius: 6,
                        cursor: "pointer",
                      }}
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setConfirmingListDelete(false)}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "#6B7280",
                        fontFamily: FONT,
                        fontSize: 12,
                        padding: "4px 8px",
                        borderRadius: 6,
                        cursor: "pointer",
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmingListDelete(true)}
                    title="Delete list"
                    aria-label="Delete list"
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background = "#FEE2E2";
                      (e.currentTarget as HTMLButtonElement).style.color = "#DC2626";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                      (e.currentTarget as HTMLButtonElement).style.color = "#6B7280";
                    }}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "#6B7280",
                      cursor: "pointer",
                      padding: 6,
                      borderRadius: 6,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      transition: "background 120ms, color 120ms",
                    }}
                  >
                    <TrashIcon />
                  </button>
                )}
              </div>
            )}
          </div>
          <div style={{ marginTop: 6, fontSize: 13, color: "#8E8E93" }}>
            {open.length} open · {done.length} {copy.doneLabel}
          </div>
        </div>

        {(list.type as string) === "focus" && (
          <PrimaryFocusDropStrip
            items={items}
            onPromote={(id) => {
              updateItem(id, { is_primary: true });
              window.dispatchEvent(new CustomEvent("gooni-primary-changed"));
            }}
            onUnset={(id) => {
              updateItem(id, { is_primary: false });
              window.dispatchEvent(new CustomEvent("gooni-primary-changed"));
            }}
          />
        )}

        <div style={{ padding: "12px 0 4px" }}>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              background: "#F2F2F7",
              borderRadius: 12,
              padding: "8px 12px",
            }}
          >
            <button
              onClick={() => setComposerKind((k) => (k === "task" ? "idea" : "task"))}
              title={composerKind === "task" ? "Switch to idea (no checkbox)" : "Switch to task (checkbox)"}
              style={{
                border: "none",
                background: composerKind === "task" ? "#E5E5EA" : "#FEF3C7",
                color: composerKind === "task" ? "#1C1C1E" : "#92400E",
                fontFamily: FONT,
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                padding: "3px 8px",
                borderRadius: 6,
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              {composerKind === "task" ? "task" : "idea"}
            </button>
            <input
              ref={composerRef}
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              placeholder={copy.composer}
              style={{
                flex: 1,
                border: "none",
                outline: "none",
                background: "transparent",
                fontFamily: FONT,
                fontSize: 14,
                color: "#1C1C1E",
              }}
            />
            {composer.trim() && (
              <button
                onClick={handleAdd}
                style={{
                  border: "none",
                  background: "#1C1C1E",
                  color: "#FFFFFF",
                  padding: "4px 12px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontFamily: FONT,
                  cursor: "pointer",
                }}
              >
                Add
              </button>
            )}
          </div>
        </div>

        <div style={{ padding: "4px 0 24px" }}>
          {items.length === 0 && (
            <div style={{ padding: "20px 0", color: "#8E8E93", fontSize: 14 }}>
              {copy.emptyHint}
            </div>
          )}

          {open.map((it) => renderRow(it, { draggable: true }))}
          {/* Bottom drop zone — drop here to send to end of open section. */}
          {draggingId != null && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDropBeforeId(null); }}
              onDrop={(e) => { e.preventDefault(); handleDrop(null); }}
              style={{
                height: 24,
                borderTop: dropBeforeId == null ? "2px solid #3B82F6" : "2px solid transparent",
                transition: "border-color 100ms",
              }}
            />
          )}

          {done.length > 0 && (
            <div
              style={{
                padding: "18px 0 6px",
                fontSize: 11,
                color: "#9CA3AF",
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {copy.doneLabel}
            </div>
          )}
          {done.map((it) => renderRow(it, { draggable: false }))}
        </div>
      </div>

      <style>{`
        @keyframes gooni-row-flash {
          0%   { background: #DCFCE7; }
          100% { background: transparent; }
        }
      `}</style>

      {modalItem && (
        <ItemModal
          item={modalItem}
          isPrimary={modalItem.is_primary}
          onClose={() => setModalItemId(null)}
          onSave={(patch) => updateItem(modalItem.id, patch)}
          onDelete={() => deleteItem(modalItem.id)}
        />
      )}
    </div>
  );
}

interface RowProps {
  item: ApiListItem;
  onToggle: () => void;
  onDelete: () => void;
  onToggleActionable: () => void;
  onOpenSourceNote?: (noteId: number) => void;
  onOpenDetail: () => void;
  onMakePrimary?: () => void;
  doneLabel: string;
  flashing: boolean;
  registerRef: (el: HTMLDivElement | null) => void;
  draggable: boolean;
  isDragging: boolean;
  dropIndicator: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverRow: () => void;
  onDropRow: () => void;
}

function ListItemRow({
  item, onToggle, onDelete, onToggleActionable, onOpenSourceNote, onOpenDetail, onMakePrimary, flashing, registerRef,
  draggable, isDragging, dropIndicator, onDragStart, onDragEnd, onDragOverRow, onDropRow,
}: RowProps) {
  const [hover, setHover] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Auto-bail confirm if mouse leaves row.
  useEffect(() => {
    if (!hover && confirmingDelete) {
      const t = window.setTimeout(() => setConfirmingDelete(false), 600);
      return () => window.clearTimeout(t);
    }
  }, [hover, confirmingDelete]);

  return (
    <div
      ref={registerRef}
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) return;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(item.id));
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        if (!draggable) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOverRow();
      }}
      onDrop={(e) => {
        if (!draggable) return;
        e.preventDefault();
        onDropRow();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "10px 8px",
        borderTop: dropIndicator ? "2px solid #3B82F6" : "2px solid transparent",
        borderBottom: "1px solid #F2F2F7",
        opacity: isDragging ? 0.4 : (item.actionable && item.done ? 0.55 : 1),
        borderRadius: 6,
        animation: flashing ? "gooni-row-flash 1100ms ease-out" : undefined,
        cursor: draggable && hover ? "grab" : "default",
      }}
    >
      {item.actionable ? (
        <button
          onClick={onToggle}
          aria-label={item.done ? "Mark as not done" : "Mark as done"}
          style={{
            marginTop: 2,
            width: 18,
            height: 18,
            borderRadius: 999,
            border: item.done ? "none" : "1.5px solid #C7C7CC",
            background: item.done ? "#34C759" : "transparent",
            color: "#FFFFFF",
            fontSize: 11,
            cursor: "pointer",
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {item.done ? "✓" : ""}
        </button>
      ) : (
        <button
          onClick={onToggleActionable}
          aria-label="Convert idea to task"
          title="Idea — click to convert to task"
          style={{
            marginTop: 2,
            width: 18,
            height: 18,
            borderRadius: 999,
            border: "none",
            background: "transparent",
            color: "#9CA3AF",
            cursor: "pointer",
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            fontSize: 18,
            lineHeight: 1,
          }}
        >
          ·
        </button>
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          onClick={onOpenDetail}
          title="Click to open details"
          style={{
            display: "flex", alignItems: "center", gap: 6,
            fontSize: 14,
            color: item.actionable ? "#1C1C1E" : "#3F3F46",
            fontStyle: item.actionable ? "normal" : "italic",
            textDecoration: item.actionable && item.done ? "line-through" : "none",
            cursor: "pointer",
            wordBreak: "break-word",
          }}
        >
          {item.is_primary && (
            <span title="Primary focus" style={{ color: "#F59E0B", fontSize: 14, lineHeight: 1, flexShrink: 0 }}>★</span>
          )}
          <span>{item.text}</span>
        </div>

        {item.subtitle && (
          <div style={{ marginTop: 3, fontSize: 12.5, color: "#8E8E93", lineHeight: 1.45 }}>
            {item.subtitle}
          </div>
        )}

        {(item.due_date || item.source_note_id || !item.actionable) && (
          <div style={{ marginTop: 4, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {!item.actionable && (
              <span
                style={{
                  fontSize: 10,
                  color: "#92400E",
                  background: "#FEF3C7",
                  padding: "2px 6px",
                  borderRadius: 999,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  fontWeight: 600,
                }}
              >
                idea
              </span>
            )}
            {item.due_date && (
              <span
                style={{
                  fontSize: 11,
                  color: "#636366",
                  background: "#F2F2F7",
                  padding: "2px 8px",
                  borderRadius: 999,
                }}
              >
                {formatDueDate(item.due_date)}
              </span>
            )}
            {item.source_note_id && (
              <button
                onClick={() => onOpenSourceNote?.(item.source_note_id!)}
                style={{
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                  fontSize: 11,
                  color: "#0EA5E9",
                  padding: 0,
                }}
              >
                ↗ from note #{item.source_note_id}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Right-side meta column: timestamp (always) + hover actions. */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0, minWidth: 90 }}>
        <div style={{ fontSize: 11, color: "#9CA3AF", whiteSpace: "nowrap" }}>
          {item.actionable && item.done && item.completed_at
            ? `done ${relativeTime(item.completed_at)}`
            : relativeTime(item.created_at)}
        </div>
        {hover && (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {onMakePrimary && !item.is_primary && !confirmingDelete && (
              <button
                onClick={onMakePrimary}
                title="Make this the primary focus"
                aria-label="Make primary"
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "#FEF3C7";
                  (e.currentTarget as HTMLButtonElement).style.color = "#B45309";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                  (e.currentTarget as HTMLButtonElement).style.color = "#6B7280";
                }}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "#6B7280",
                  cursor: "pointer",
                  padding: "3px 7px",
                  borderRadius: 6,
                  fontFamily: FONT,
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  transition: "background 120ms, color 120ms",
                  display: "flex",
                  alignItems: "center",
                  gap: 3,
                }}
              >
                ★ make primary
              </button>
            )}
            {item.actionable && !confirmingDelete && (
              <button
                onClick={onToggleActionable}
                title="Demote to idea (no checkbox)"
                aria-label="Demote to idea"
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "#FEF3C7";
                  (e.currentTarget as HTMLButtonElement).style.color = "#92400E";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                  (e.currentTarget as HTMLButtonElement).style.color = "#6B7280";
                }}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "#6B7280",
                  cursor: "pointer",
                  padding: "3px 7px",
                  borderRadius: 6,
                  fontFamily: FONT,
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  transition: "background 120ms, color 120ms",
                }}
              >
                → idea
              </button>
            )}
          {confirmingDelete ? (
            <>
              <span style={{ fontSize: 12, color: "#9CA3AF" }}>Delete?</span>
              <button
                onClick={onDelete}
                style={{
                  border: "none",
                  background: "#DC2626",
                  color: "#FFFFFF",
                  cursor: "pointer",
                  fontSize: 12,
                  fontFamily: FONT,
                  padding: "3px 10px",
                  borderRadius: 6,
                  fontWeight: 600,
                }}
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmingDelete(false)}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "#6B7280",
                  cursor: "pointer",
                  fontSize: 12,
                  fontFamily: FONT,
                  padding: "3px 6px",
                  borderRadius: 6,
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmingDelete(true)}
              aria-label="Delete item"
              title="Delete item"
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "#FEE2E2";
                (e.currentTarget as HTMLButtonElement).style.color = "#DC2626";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                (e.currentTarget as HTMLButtonElement).style.color = "#6B7280";
              }}
              style={{
                border: "none",
                background: "transparent",
                color: "#6B7280",
                cursor: "pointer",
                padding: 6,
                borderRadius: 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "background 120ms, color 120ms",
              }}
            >
              <TrashIcon />
            </button>
          )}
          </div>
        )}
      </div>
    </div>
  );
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 4h11" />
      <path d="M6 4V2.5h4V4" />
      <path d="M3.75 4l.75 9.25a1 1 0 0 0 1 .92h5a1 1 0 0 0 1-.92L12.25 4" />
      <path d="M6.5 7v5" />
      <path d="M9.5 7v5" />
    </svg>
  );
}

// Inline drop strip for the focus ListView. Lets a user drag a focus row
// onto it to set as primary — needed because the dashboard's PrimaryFocusCard
// isn't visible while the list view is open (mutually exclusive layouts).
function PrimaryFocusDropStrip({
  items, onPromote, onUnset,
}: {
  items: ApiListItem[];
  onPromote: (id: number) => void;
  onUnset: (id: number) => void;
}) {
  const [hover, setHover] = useState(false);
  const primary = items.find((it) => it.is_primary) || null;
  return (
    <div
      onDragOver={(e) => {
        const bus = getPrimaryDragBus();
        if (bus.current) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setHover(true);
        }
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        const bus = getPrimaryDragBus();
        const src = bus.current;
        bus.current = null;
        if (src) onPromote(src.id);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        margin: "12px 0 4px",
        padding: "10px 14px",
        borderRadius: 10,
        border: hover
          ? "2px dashed #F59E0B"
          : primary
          ? "1px solid #FCD34D"
          : "1px dashed rgba(0,0,0,0.18)",
        background: primary ? "#FFFBEB" : "transparent",
        transition: "border-color 160ms, background 160ms",
      }}
    >
      <span style={{ fontSize: 16, color: "#F59E0B", flexShrink: 0 }}>★</span>
      <span style={{
        fontSize: 11, color: primary ? "#92400E" : "#8E8E93",
        letterSpacing: 0.5, textTransform: "uppercase", fontWeight: 700,
        flexShrink: 0,
      }}>
        Primary
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: primary ? "#1C1C1E" : "#9CA3AF", fontWeight: primary ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {primary ? primary.text : "Drag a focus here to set as primary"}
      </span>
      {primary && (
        <button
          onClick={() => onUnset(primary.id)}
          style={{
            border: "none", background: "transparent", color: "#92400E",
            fontFamily: FONT, fontSize: 11, fontWeight: 600, cursor: "pointer",
            padding: "3px 8px", borderRadius: 6, flexShrink: 0,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(146,64,14,0.08)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
        >
          Unset
        </button>
      )}
    </div>
  );
}
