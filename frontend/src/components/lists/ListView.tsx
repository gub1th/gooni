import { useEffect, useMemo, useRef, useState } from "react";
import { useListsStore } from "../../stores/useListsStore";
import type { ApiListItem, ListType } from "../../services/api";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";

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

export function ListView({ listId, onOpenSourceNote }: ListViewProps) {
  const list = useListsStore((s) => s.lists.find((l) => l.id === listId));
  const items = useListsStore((s) => s.itemsByListId[listId] || []);
  const selectList = useListsStore((s) => s.selectList);
  const addItem = useListsStore((s) => s.addItem);
  const updateItem = useListsStore((s) => s.updateItem);
  const deleteItem = useListsStore((s) => s.deleteItem);

  const [composer, setComposer] = useState("");
  const composerRef = useRef<HTMLInputElement>(null);

  useEffect(() => { selectList(listId); }, [listId, selectList]);

  const copy = useMemo(() => copyForType(list?.type || "generic"), [list?.type]);

  const { open, done } = useMemo(() => {
    const open: ApiListItem[] = [];
    const done: ApiListItem[] = [];
    for (const it of items) (it.done ? done : open).push(it);
    open.sort((a, b) => a.sort_order - b.sort_order);
    done.sort((a, b) => (b.completed_at || "").localeCompare(a.completed_at || ""));
    return { open, done };
  }, [items]);

  async function handleAdd() {
    const text = composer.trim();
    if (!text) return;
    setComposer("");
    try {
      await addItem(listId, text);
      composerRef.current?.focus();
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

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#FFFFFF",
        fontFamily: FONT,
      }}
    >
      <div
        style={{
          padding: "32px 48px 16px",
          borderBottom: "1px solid #F2F2F7",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {list.emoji && <span style={{ fontSize: 22 }}>{list.emoji}</span>}
          <h1 style={{ fontSize: 24, fontWeight: 600, color: "#1C1C1E", margin: 0 }}>
            {list.name}
          </h1>
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
        </div>
        <div style={{ marginTop: 6, fontSize: 13, color: "#8E8E93" }}>
          {open.length} open · {done.length} {copy.doneLabel}
        </div>
      </div>

      <div style={{ padding: "12px 48px 4px" }}>
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
          <span style={{ color: "#8E8E93", fontSize: 16 }}>＋</span>
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

      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0 24px" }}>
        {items.length === 0 && (
          <div style={{ padding: "20px 48px", color: "#8E8E93", fontSize: 14 }}>
            {copy.emptyHint}
          </div>
        )}

        {open.map((it) => (
          <ListItemRow
            key={it.id}
            item={it}
            onToggle={() => updateItem(it.id, { done: !it.done })}
            onDelete={() => deleteItem(it.id)}
            onChangeText={(text) => updateItem(it.id, { text })}
            onOpenSourceNote={onOpenSourceNote}
            doneLabel={copy.doneLabel}
          />
        ))}

        {done.length > 0 && (
          <div
            style={{
              padding: "18px 48px 6px",
              fontSize: 11,
              color: "#9CA3AF",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            {copy.doneLabel}
          </div>
        )}
        {done.map((it) => (
          <ListItemRow
            key={it.id}
            item={it}
            onToggle={() => updateItem(it.id, { done: !it.done })}
            onDelete={() => deleteItem(it.id)}
            onChangeText={(text) => updateItem(it.id, { text })}
            onOpenSourceNote={onOpenSourceNote}
            doneLabel={copy.doneLabel}
          />
        ))}
      </div>
    </div>
  );
}

interface RowProps {
  item: ApiListItem;
  onToggle: () => void;
  onDelete: () => void;
  onChangeText: (t: string) => void;
  onOpenSourceNote?: (noteId: number) => void;
  doneLabel: string;
}

function ListItemRow({ item, onToggle, onDelete, onChangeText, onOpenSourceNote }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [hover, setHover] = useState(false);

  useEffect(() => { setDraft(item.text); }, [item.text]);

  function commit() {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== item.text) onChangeText(next);
    else setDraft(item.text);
  }

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "10px 48px",
        borderBottom: "1px solid #F2F2F7",
        opacity: item.done ? 0.55 : 1,
      }}
    >
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

      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <input
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") { setDraft(item.text); setEditing(false); }
            }}
            style={{
              width: "100%",
              border: "none",
              outline: "none",
              background: "transparent",
              fontFamily: FONT,
              fontSize: 14,
              color: "#1C1C1E",
              textDecoration: item.done ? "line-through" : "none",
            }}
          />
        ) : (
          <div
            onClick={() => setEditing(true)}
            style={{
              fontSize: 14,
              color: "#1C1C1E",
              textDecoration: item.done ? "line-through" : "none",
              cursor: "text",
              wordBreak: "break-word",
            }}
          >
            {item.text}
          </div>
        )}

        {item.subtitle && (
          <div style={{ marginTop: 3, fontSize: 12.5, color: "#8E8E93", lineHeight: 1.45 }}>
            {item.subtitle}
          </div>
        )}

        {(item.due_date || item.source_note_id) && (
          <div style={{ marginTop: 4, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
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

      {hover && (
        <button
          onClick={onDelete}
          aria-label="Delete item"
          style={{
            border: "none",
            background: "transparent",
            color: "#8E8E93",
            cursor: "pointer",
            fontSize: 14,
            padding: "0 4px",
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
