import { useMemo, useState } from "react";
import { GripVertical, ExternalLink } from "lucide-react";
import type { ApiListItem, BoardStatus } from "../../services/api";
import { useListsStore } from "../../stores/useListsStore";
import { ItemModal } from "./ItemModal";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

interface BacklogBoardProps {
  listId: number;
  onOpenSourceNote?: (noteId: number) => void;
}

interface Column {
  status: BoardStatus;
  label: string;
  hint: string;
  tint: string;
}

// Three fixed columns. Order chosen so the eye reads left → right matching
// the work flow direction: start in Todo, move right to In progress, finish
// in Done.
const COLUMNS: Column[] = [
  { status: "todo",        label: "Todo",        hint: "Not yet picked up",   tint: "#94A3B8" },
  { status: "in_progress", label: "In progress", hint: "Actively working",    tint: "#F59E0B" },
  { status: "done",        label: "Done",        hint: "Shipped or closed",   tint: "#16A34A" },
];

// Map a stored item → which column it lands in. `done=true` always wins
// over board_status so checking-off via the existing flow doesn't desync
// from the board. Server keeps the two in sync on update_item.
function statusOf(item: ApiListItem): BoardStatus {
  if (item.done) return "done";
  if (item.board_status === "in_progress") return "in_progress";
  return "todo";
}

// Click-vs-drag disambiguation: drag is initiated only on the GripVertical
// handle (per-row), so the rest of the card is click-only. HTML5 native DnD
// handles the lift; we only set/read the dragging item via local state +
// ondragstart payload (item id as string).

export function BacklogBoard({ listId, onOpenSourceNote }: BacklogBoardProps) {
  const items = useListsStore((s) => s.itemsByListId[listId] || []);
  const updateItem = useListsStore((s) => s.updateItem);
  const reorder = useListsStore((s) => s.reorder);
  const deleteItem = useListsStore((s) => s.deleteItem);

  const [dragId, setDragId] = useState<number | null>(null);
  const [hoverColumn, setHoverColumn] = useState<BoardStatus | null>(null);
  // While dragging, an index hint per column where the drop will land.
  // Null when the drag isn't over that column or the index isn't between
  // items (drop-at-end).
  const [hoverIndex, setHoverIndex] = useState<{ status: BoardStatus; index: number } | null>(null);
  const [openItemId, setOpenItemId] = useState<number | null>(null);

  const grouped = useMemo(() => {
    const m: Record<BoardStatus, ApiListItem[]> = { todo: [], in_progress: [], done: [] };
    for (const it of items) m[statusOf(it)].push(it);
    // Within column, sort by sort_order asc (server-managed).
    for (const k of Object.keys(m) as BoardStatus[]) {
      m[k].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    }
    return m;
  }, [items]);

  const openItem = openItemId == null ? null : items.find((i) => i.id === openItemId) ?? null;

  function handleDragStart(e: React.DragEvent, itemId: number) {
    setDragId(itemId);
    try {
      e.dataTransfer.setData("text/plain", String(itemId));
      e.dataTransfer.effectAllowed = "move";
    } catch { /* some browsers throw on certain configs — non-fatal */ }
  }

  function handleDragEnd() {
    setDragId(null);
    setHoverColumn(null);
    setHoverIndex(null);
  }

  async function handleDrop(targetStatus: BoardStatus, targetIndex: number | null) {
    const movingId = dragId;
    setDragId(null);
    setHoverColumn(null);
    setHoverIndex(null);
    if (movingId == null) return;
    const moving = items.find((i) => i.id === movingId);
    if (!moving) return;

    const sourceStatus = statusOf(moving);
    const statusChanged = sourceStatus !== targetStatus;

    // Compute the post-drop item ids in the target column.
    const colItems = grouped[targetStatus].filter((i) => i.id !== movingId);
    const insertAt = targetIndex == null ? colItems.length : Math.max(0, Math.min(targetIndex, colItems.length));
    const beforeIds = colItems.slice(0, insertAt).map((i) => i.id);
    const afterIds = colItems.slice(insertAt).map((i) => i.id);
    const newColIds: number[] = [...beforeIds, movingId, ...afterIds];

    if (statusChanged) {
      // Status flip first, then reorder. Two patches keeps each request
      // payload lean + the reorder endpoint only owns sort_order.
      await updateItem(movingId, { board_status: targetStatus });
    }
    // Persist new order for the target column (and the source column if it
    // was different, since removing the item reshuffles its sort_order).
    await reorder(listId, newColIds);
    if (statusChanged) {
      const sourceIds = grouped[sourceStatus].filter((i) => i.id !== movingId).map((i) => i.id);
      if (sourceIds.length) await reorder(listId, sourceIds);
    }
  }

  return (
    <div
      style={{
        flex: 1,
        height: "100%",
        overflow: "hidden",
        background: "var(--gooni-main, #F7F8FA)",
        fontFamily: FONT,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "20px 28px 12px",
          borderBottom: "1px solid rgba(0,0,0,0.06)",
          background: "var(--gooni-bg, #FFFFFF)",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, color: "var(--gooni-text, #1C1C1E)", letterSpacing: "-0.2px" }}>
          Backlog board
        </div>
        <div style={{ fontSize: 12, color: "var(--gooni-muted, #8E8E93)", marginTop: 2 }}>
          Drag a card to move or reorder. Click to open details.
        </div>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 20,
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(260px, 1fr))",
          gap: 14,
          alignItems: "start",
        }}
      >
        {COLUMNS.map((col) => {
          const colItems = grouped[col.status];
          const isHover = hoverColumn === col.status;
          return (
            <div
              key={col.status}
              onDragOver={(e) => {
                if (dragId == null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (hoverColumn !== col.status) setHoverColumn(col.status);
              }}
              onDragLeave={(e) => {
                // Only clear when leaving the column container itself, not
                // when crossing inner card boundaries.
                if ((e.target as HTMLElement).dataset.column === col.status) {
                  setHoverColumn((c) => (c === col.status ? null : c));
                  setHoverIndex(null);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                void handleDrop(col.status, hoverIndex?.status === col.status ? hoverIndex.index : null);
              }}
              data-column={col.status}
              style={{
                background: "var(--gooni-card, #FFFFFF)",
                borderRadius: 12,
                padding: 12,
                border: `1px solid ${isHover ? col.tint : "rgba(0,0,0,0.06)"}`,
                boxShadow: isHover ? `0 0 0 2px ${col.tint}33` : "none",
                transition: "border-color 0.12s, box-shadow 0.12s",
                minHeight: 200,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 6, borderBottom: "1px solid rgba(0,0,0,0.05)" }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: col.tint }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--gooni-text, #1C1C1E)", textTransform: "uppercase", letterSpacing: 0.6 }}>
                  {col.label}
                </span>
                <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--gooni-muted, #8E8E93)" }}>
                  {colItems.length}
                </span>
              </div>

              {colItems.length === 0 ? (
                <div style={{ padding: "20px 6px", color: "var(--gooni-muted, #B0B0B5)", fontSize: 12, textAlign: "center" }}>
                  {col.hint}
                </div>
              ) : (
                colItems.map((item, idx) => {
                  const isDragging = dragId === item.id;
                  return (
                    <div key={item.id}>
                      {/* Drop indicator above the card when hovering between items */}
                      {hoverIndex?.status === col.status && hoverIndex.index === idx && dragId != null && dragId !== item.id && (
                        <div style={{ height: 2, background: col.tint, borderRadius: 1, margin: "2px 4px" }} />
                      )}
                      <BacklogCard
                        item={item}
                        dragging={isDragging}
                        onDragStart={(e) => handleDragStart(e, item.id)}
                        onDragEnd={handleDragEnd}
                        onCardDragOver={(e) => {
                          if (dragId == null || dragId === item.id) return;
                          e.preventDefault();
                          // Decide insert-before vs insert-after based on Y midpoint.
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          const before = e.clientY < rect.top + rect.height / 2;
                          const targetIdx = before ? idx : idx + 1;
                          if (
                            hoverIndex?.status !== col.status ||
                            hoverIndex.index !== targetIdx
                          ) {
                            setHoverIndex({ status: col.status, index: targetIdx });
                          }
                        }}
                        onClick={() => setOpenItemId(item.id)}
                        onOpenPr={() => {
                          if (item.pr_url) window.open(item.pr_url, "_blank", "noopener,noreferrer");
                        }}
                        onOpenSourceNote={onOpenSourceNote}
                      />
                    </div>
                  );
                })
              )}
            </div>
          );
        })}
      </div>

      {openItem && (
        <ItemModal
          item={openItem}
          showBoardFields
          onClose={() => setOpenItemId(null)}
          onSave={async (patch) => {
            await updateItem(openItem.id, patch);
          }}
          onDelete={() => {
            void deleteItem(openItem.id);
            setOpenItemId(null);
          }}
        />
      )}
    </div>
  );
}

function BacklogCard({
  item,
  dragging,
  onDragStart,
  onDragEnd,
  onCardDragOver,
  onClick,
  onOpenPr,
  onOpenSourceNote,
}: {
  item: ApiListItem;
  dragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onCardDragOver: (e: React.DragEvent) => void;
  onClick: () => void;
  onOpenPr: () => void;
  onOpenSourceNote?: (noteId: number) => void;
}) {
  return (
    <div
      // Whole card is the drag source. Browser naturally suppresses the
      // click event when a drag occurs, so click → modal and drag →
      // reorder/move are exclusive without manual gating. Matches the
      // pattern used by the existing ListView + PrimaryFocusCard.
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onCardDragOver}
      onClick={(e) => {
        // Defensive: clicks on inner action elements (PR pill, source note
        // link) should not open the modal.
        if ((e.target as HTMLElement).closest("[data-card-action]")) return;
        onClick();
      }}
      style={{
        position: "relative",
        background: dragging ? "rgba(0,0,0,0.02)" : "var(--gooni-bg, #FFFFFF)",
        border: "1px solid rgba(0,0,0,0.08)",
        borderRadius: 10,
        padding: "10px 12px 10px 32px",
        cursor: dragging ? "grabbing" : "pointer",
        opacity: dragging ? 0.5 : 1,
        transition: "opacity 0.12s, border-color 0.12s, box-shadow 0.12s",
        userSelect: "none",
      }}
      onMouseEnter={(e) => {
        if (dragging) return;
        (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,0,0,0.16)";
        (e.currentTarget as HTMLElement).style.boxShadow = "0 2px 8px rgba(0,0,0,0.05)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,0,0,0.08)";
        (e.currentTarget as HTMLElement).style.boxShadow = "none";
      }}
    >
      {/* Drag-affordance grip — purely visual now. Whole card is the
          drag source (see `draggable` on the wrapper) which matches the
          existing ListView/PrimaryFocusCard behavior. The grip is a hint
          to the user that the card can be dragged. */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 8,
          top: 10,
          width: 18,
          height: 18,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#B0B0B5",
          pointerEvents: "none",
        }}
      >
        <GripVertical size={14} strokeWidth={1.7} />
      </span>

      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--gooni-text, #1C1C1E)", lineHeight: 1.4 }}>
        #{item.id} {item.text}
      </div>
      {item.subtitle && (
        <div style={{ fontSize: 11.5, color: "var(--gooni-muted, #8E8E93)", marginTop: 4, lineHeight: 1.5,
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
        }}>
          {item.subtitle}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 11, color: "var(--gooni-muted, #8E8E93)" }}>
        {item.pr_url && (
          <button
            data-card-action
            onClick={(e) => { e.stopPropagation(); onOpenPr(); }}
            title={item.pr_url}
            style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              padding: "2px 6px", borderRadius: 4,
              background: "rgba(22,163,74,0.10)", color: "#166534",
              border: "1px solid rgba(22,163,74,0.25)",
              cursor: "pointer", fontSize: 10.5, fontWeight: 600,
            }}
          >
            <ExternalLink size={10} strokeWidth={1.7} />
            PR
          </button>
        )}
        {item.source_note_id && onOpenSourceNote && (
          <button
            data-card-action
            onClick={(e) => { e.stopPropagation(); onOpenSourceNote(item.source_note_id!); }}
            style={{
              border: "none", background: "transparent", color: "var(--gooni-muted, #8E8E93)",
              cursor: "pointer", padding: 0, fontSize: 11,
            }}
          >
            note #{item.source_note_id} →
          </button>
        )}
      </div>
    </div>
  );
}
