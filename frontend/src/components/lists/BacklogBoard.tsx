import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { GripVertical, ExternalLink, ListChecks, Plus, Search, X, Bot } from "lucide-react";
import type { ApiBacklogTicket, BoardStatus } from "../../services/api";
import {
  promoteBacklogTicket, demoteBacklogTicket,
  promoteBacklogToPrimary, clearPrimaryBacklog,
} from "../../services/api";
import { useBacklogStore } from "../../stores/useBacklogStore";
import { ItemModal } from "./ItemModal";
import { color as ctok, FONT } from "../../ui";


interface BacklogBoardProps {
  // listId kept on the props for backward compatibility w/ the route caller
  // — backlog tickets aren't list-bound anymore (own table), but the route
  // still resolves a "Backlog" list to anchor the sidebar entry.
  listId?: number;
  onOpenSourceNote?: (noteId: number) => void;
}

interface Column {
  status: BoardStatus;
  label: string;
  hint: string;
  tint: string;
}

const COLUMNS: Column[] = [
  { status: "not_yet", label: "Todo",        hint: "Not yet picked up",   tint: "#94A3B8" },
  { status: "doing",   label: "In progress", hint: "Actively working",    tint: "#F59E0B" },
  { status: "done",    label: "Done",        hint: "Shipped or closed",   tint: "#16A34A" },
];

// Auto-generated eval tickets carry a recognizable prefix. We mute them
// visually so the human eye instantly distinguishes "real" feature work
// from background eval triage rows.
function isAutoEvalTicket(t: ApiBacklogTicket): boolean {
  return /eval\s+segment/i.test(t.text);
}

// Map a stored ticket → which column it lands in. `done=true` always wins
// over board_status so checking-off via the existing flow doesn't desync
// from the board. Server keeps the two in sync on update.
function statusOf(t: ApiBacklogTicket): BoardStatus {
  if (t.done) return "done";
  if (t.board_status === "doing") return "doing";
  return "not_yet";
}

const TODO_PRIORITY_LIMIT = 6;
const DONE_RECENT_LIMIT = 8;

export function BacklogBoard({ onOpenSourceNote }: BacklogBoardProps) {
  const tickets = useBacklogStore((s) => s.tickets);
  const refresh = useBacklogStore((s) => s.refresh);
  const updateTicket = useBacklogStore((s) => s.updateTicket);
  const reorder = useBacklogStore((s) => s.reorder);
  const deleteTicket = useBacklogStore((s) => s.deleteTicket);
  const qc = useQueryClient();

  async function onPromote(ticketId: number) {
    try {
      await promoteBacklogTicket(ticketId);
      await refresh();
      qc.invalidateQueries({ queryKey: ["todos-bundle"] });
    } catch (e) { console.error("promote failed", e); }
  }
  async function onDemote(ticketId: number) {
    try {
      await demoteBacklogTicket(ticketId);
      await refresh();
      qc.invalidateQueries({ queryKey: ["todos-bundle"] });
    } catch (e) { console.error("demote failed", e); }
  }

  useEffect(() => { void refresh(); }, [refresh]);

  const [dragId, setDragId] = useState<number | null>(null);
  const [hoverColumn, setHoverColumn] = useState<BoardStatus | null>(null);
  const [hoverIndex, setHoverIndex] = useState<{ status: BoardStatus; index: number } | null>(null);
  const [openItemId, setOpenItemId] = useState<number | null>(null);

  // Debounced search across title + subtitle. 300ms keeps the input
  // responsive without thrashing on every keystroke.
  const [searchRaw, setSearchRaw] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchRaw.trim().toLowerCase()), 300);
    return () => clearTimeout(id);
  }, [searchRaw]);
  const searching = search.length > 0;

  // Per-column expansion toggles for the "show more" rows. Auto-flipped
  // open while a search is active so matches don't hide inside the
  // collapsed sections.
  const [todoExpanded, setTodoExpanded] = useState(false);
  const [doneExpanded, setDoneExpanded] = useState(false);

  const grouped = useMemo(() => {
    const m: Record<BoardStatus, ApiBacklogTicket[]> = { not_yet: [], doing: [], done: [] };
    for (const t of tickets) m[statusOf(t)].push(t);
    for (const k of Object.keys(m) as BoardStatus[]) {
      m[k].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    }
    return m;
  }, [tickets]);

  function applySearch(items: ApiBacklogTicket[]): ApiBacklogTicket[] {
    if (!searching) return items;
    return items.filter((t) =>
      t.text.toLowerCase().includes(search) ||
      (t.subtitle ?? "").toLowerCase().includes(search)
    );
  }

  // Todo column is split into a small priority slice (real tickets, most
  // recently created) + a collapsed rest. Auto-generated eval rows always
  // land in the collapsed pile so they don't crowd the next-up section.
  const todoFiltered = applySearch(grouped.not_yet);
  const todoReal = todoFiltered.filter((t) => !isAutoEvalTicket(t));
  const todoAuto = todoFiltered.filter(isAutoEvalTicket);
  const todoPriority = todoReal.slice(0, TODO_PRIORITY_LIMIT);
  const todoRest = [...todoReal.slice(TODO_PRIORITY_LIMIT), ...todoAuto];

  const doneFiltered = applySearch(grouped.done);
  const doneRecent = doneFiltered.slice(0, DONE_RECENT_LIMIT);
  const doneRest = doneFiltered.slice(DONE_RECENT_LIMIT);

  const doingFiltered = applySearch(grouped.doing);

  // Empty In Progress collapses to a thin strip — saves a third of the
  // board from being wasted on placeholder text. Search collapses it
  // back open the moment a match lands here.
  const doingEmpty = doingFiltered.length === 0 && !searching;

  const openItem = openItemId == null ? null : tickets.find((i) => i.id === openItemId) ?? null;

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
    const moving = tickets.find((i) => i.id === movingId);
    if (!moving) return;

    const sourceStatus = statusOf(moving);
    const statusChanged = sourceStatus !== targetStatus;

    const colItems = grouped[targetStatus].filter((i) => i.id !== movingId);
    const insertAt = targetIndex == null ? colItems.length : Math.max(0, Math.min(targetIndex, colItems.length));
    const beforeIds = colItems.slice(0, insertAt).map((i) => i.id);
    const afterIds = colItems.slice(insertAt).map((i) => i.id);
    const newColIds: number[] = [...beforeIds, movingId, ...afterIds];

    if (statusChanged) {
      const patch: { board_status: BoardStatus; done?: boolean } = { board_status: targetStatus };
      if (targetStatus === "done") patch.done = true;
      else if (moving.done) patch.done = false;
      await updateTicket(movingId, patch);
    }
    await reorder(newColIds);
    if (statusChanged) {
      const sourceIds = grouped[sourceStatus].filter((i) => i.id !== movingId).map((i) => i.id);
      if (sourceIds.length) await reorder(sourceIds);
    }
  }

  // Visible items per column drive the drop-target ordering. Hidden
  // items (collapsed sections) keep their server-side order; dragging
  // into the visible slice inserts at the visible index, which is
  // computed against the same filtered list.
  const visiblePerColumn: Record<BoardStatus, ApiBacklogTicket[]> = {
    not_yet: todoExpanded || searching ? [...todoPriority, ...todoRest] : todoPriority,
    doing: doingFiltered,
    done: doneExpanded || searching ? [...doneRecent, ...doneRest] : doneRecent,
  };

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
          padding: "16px 24px 12px",
          borderBottom: "1px solid rgba(0,0,0,0.06)",
          background: "var(--gooni-bg, #FFFFFF)",
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--gooni-text, #1C1C1E)", letterSpacing: "-0.2px" }}>
            Backlog board
          </div>
          <div style={{ fontSize: 11, color: "var(--gooni-muted, #8E8E93)", marginTop: 2 }}>
            Drag a card to move. Click to open.
          </div>
        </div>
        <div style={{
          marginLeft: "auto",
          display: "flex", alignItems: "center", gap: 6,
          background: "rgba(0,0,0,0.04)",
          border: "1px solid rgba(0,0,0,0.06)",
          borderRadius: 8,
          padding: "5px 10px",
          minWidth: 220,
        }}>
          <Search size={13} strokeWidth={1.8} color="#8E8E93" />
          <input
            value={searchRaw}
            onChange={(e) => setSearchRaw(e.target.value)}
            placeholder="Search tickets…"
            style={{
              flex: 1, minWidth: 0,
              border: "none", outline: "none", background: "transparent",
              fontFamily: FONT, fontSize: 12.5,
              color: "var(--gooni-text, #1C1C1E)",
            }}
          />
          {searchRaw && (
            <button
              onClick={() => setSearchRaw("")}
              style={{
                background: "transparent", border: "none", cursor: "pointer",
                padding: 0, color: ctok.muted, display: "inline-flex",
              }}
              title="Clear search"
            >
              <X size={12} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          padding: 16,
          display: "grid",
          // Empty In Progress collapses to a thin column so Todo + Done get
          // the breathing room. Stays a drop target — dragging onto it just
          // expands it back to normal width.
          gridTemplateColumns: doingEmpty
            ? "minmax(260px, 1fr) 80px minmax(260px, 1fr)"
            : "repeat(3, minmax(260px, 1fr))",
          gap: 12,
          alignItems: "stretch",
          transition: "grid-template-columns 160ms ease",
        }}
      >
        {COLUMNS.map((col) => {
          const visible = visiblePerColumn[col.status];
          const isHover = hoverColumn === col.status;
          const isDoingStrip = col.status === "doing" && doingEmpty;

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
                borderRadius: 10,
                padding: isDoingStrip ? "10px 6px" : 10,
                border: `1px solid ${isHover ? col.tint : "rgba(0,0,0,0.06)"}`,
                boxShadow: isHover ? `0 0 0 2px ${col.tint}33` : "none",
                transition: "border-color 0.12s, box-shadow 0.12s, padding 160ms ease",
                minHeight: 200,
                height: "100%",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                overflow: "hidden",
              }}
            >
              <ColumnHeader
                col={col}
                count={grouped[col.status].length}
                compact={isDoingStrip}
              />

              {isDoingStrip ? (
                // Strip mode: vertical dotted spine. Still a drop target via
                // the parent div's onDragOver/onDrop, so dragging a card
                // onto it expands the column (after the drop reflows the
                // grouped data).
                <div style={{
                  flex: 1,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "var(--gooni-muted, #B0B0B5)",
                  fontSize: 10,
                  writingMode: "vertical-rl",
                  textTransform: "uppercase",
                  letterSpacing: 1.5,
                  opacity: dragId != null ? 1 : 0.6,
                }}>
                  drop to start
                </div>
              ) : (
                <div style={{
                  flex: 1, minHeight: 0, overflowY: "auto",
                  display: "flex", flexDirection: "column", gap: 6,
                  paddingRight: 4,
                  // Scroll body sits above the pinned AddCard footer —
                  // long columns no longer push the add affordance off-screen.
                }}>
                  {col.status === "not_yet" ? (
                    <TodoColumnBody
                      priority={todoPriority}
                      rest={todoRest}
                      expanded={todoExpanded || searching}
                      onToggle={() => setTodoExpanded((v) => !v)}
                      searching={searching}
                      onOpen={setOpenItemId}
                      onPromote={onPromote}
                      onDemote={onDemote}
                      dragId={dragId}
                      hoverIndex={hoverIndex?.status === col.status ? hoverIndex.index : null}
                      onCardDragOver={(e, idx) => {
                        if (dragId == null) return;
                        e.preventDefault();
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        const before = e.clientY < rect.top + rect.height / 2;
                        const targetIdx = before ? idx : idx + 1;
                        if (hoverIndex?.status !== col.status || hoverIndex.index !== targetIdx) {
                          setHoverIndex({ status: col.status, index: targetIdx });
                        }
                      }}
                      onDragStartCard={handleDragStart}
                      onDragEndCard={handleDragEnd}
                      colTint={col.tint}
                    />
                  ) : col.status === "done" ? (
                    <DoneColumnBody
                      recent={doneRecent}
                      rest={doneRest}
                      expanded={doneExpanded || searching}
                      onToggle={() => setDoneExpanded((v) => !v)}
                      searching={searching}
                      onOpen={setOpenItemId}
                      onPromote={onPromote}
                      onDemote={onDemote}
                      dragId={dragId}
                      hoverIndex={hoverIndex?.status === col.status ? hoverIndex.index : null}
                      onCardDragOver={(e, idx) => {
                        if (dragId == null) return;
                        e.preventDefault();
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        const before = e.clientY < rect.top + rect.height / 2;
                        const targetIdx = before ? idx : idx + 1;
                        if (hoverIndex?.status !== col.status || hoverIndex.index !== targetIdx) {
                          setHoverIndex({ status: col.status, index: targetIdx });
                        }
                      }}
                      onDragStartCard={handleDragStart}
                      onDragEndCard={handleDragEnd}
                      colTint={col.tint}
                    />
                  ) : (
                    <StandardColumnBody
                      items={visible}
                      hint={col.hint}
                      searching={searching}
                      onOpen={setOpenItemId}
                      onPromote={onPromote}
                      onDemote={onDemote}
                      dragId={dragId}
                      hoverIndex={hoverIndex?.status === col.status ? hoverIndex.index : null}
                      onCardDragOver={(e, idx) => {
                        if (dragId == null) return;
                        e.preventDefault();
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        const before = e.clientY < rect.top + rect.height / 2;
                        const targetIdx = before ? idx : idx + 1;
                        if (hoverIndex?.status !== col.status || hoverIndex.index !== targetIdx) {
                          setHoverIndex({ status: col.status, index: targetIdx });
                        }
                      }}
                      onDragStartCard={handleDragStart}
                      onDragEndCard={handleDragEnd}
                      colTint={col.tint}
                    />
                  )}
                </div>
              )}
              {!isDoingStrip && (
                <AddCardFooter
                  status={col.status}
                  tint={col.tint}
                />
              )}
            </div>
          );
        })}
      </div>

      {openItem && (
        <ItemModal
          item={openItem}
          showBoardFields
          isPrimary={openItem.is_primary}
          onOpenSourceNote={onOpenSourceNote}
          onClose={() => setOpenItemId(null)}
          onSetPrimary={async (next) => {
            if (next) await promoteBacklogToPrimary(openItem.id);
            else await clearPrimaryBacklog();
            // Refresh the board store + the dashboard banner cache so the
            // north-star pin reflects the change without a reload.
            await refresh();
            qc.invalidateQueries({ queryKey: ["primary-backlog"] });
          }}
          onSave={async (patch) => {
            await updateTicket(openItem.id, {
              text: patch.text,
              subtitle: patch.subtitle,
              done: patch.done,
              board_status: patch.board_status,
              pr_url: patch.pr_url,
            });
          }}
          onDelete={() => {
            void deleteTicket(openItem.id);
            setOpenItemId(null);
          }}
        />
      )}
    </div>
  );
}

function ColumnHeader({ col, count, compact }: { col: Column; count: number; compact: boolean }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      paddingBottom: 5, borderBottom: "1px solid rgba(0,0,0,0.05)", flexShrink: 0,
      writingMode: compact ? "vertical-rl" : "horizontal-tb",
      transform: compact ? "rotate(180deg)" : "none",
      justifyContent: compact ? "center" : "flex-start",
    }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: col.tint }} />
      <span style={{
        fontSize: 11, fontWeight: 600,
        color: "var(--gooni-text, #1C1C1E)",
        textTransform: "uppercase", letterSpacing: 0.6,
      }}>
        {col.label}
      </span>
      <span style={{
        marginLeft: compact ? 0 : "auto",
        fontSize: 10.5, color: "var(--gooni-muted, #8E8E93)",
      }}>
        · {count}
      </span>
    </div>
  );
}

// Render a single card with drag wiring + drop-indicator slot. Pulled out
// so the three column-body variants don't re-implement the per-card
// scaffolding.
function CardRow({
  item, idx, dragId, hoverIndex, colTint,
  onOpen, onPromote, onDemote, onDragStartCard, onDragEndCard, onCardDragOver,
}: {
  item: ApiBacklogTicket;
  idx: number;
  dragId: number | null;
  hoverIndex: number | null;
  colTint: string;
  onOpen: (id: number) => void;
  onPromote: (id: number) => void;
  onDemote: (id: number) => void;
  onDragStartCard: (e: React.DragEvent, id: number) => void;
  onDragEndCard: () => void;
  onCardDragOver: (e: React.DragEvent, idx: number) => void;
}) {
  return (
    <div>
      {hoverIndex === idx && dragId != null && dragId !== item.id && (
        <div style={{ height: 2, background: colTint, borderRadius: 1, margin: "1px 3px" }} />
      )}
      <BacklogCard
        item={item}
        dragging={dragId === item.id}
        onDragStart={(e) => onDragStartCard(e, item.id)}
        onDragEnd={onDragEndCard}
        onCardDragOver={(e) => onCardDragOver(e, idx)}
        onClick={() => onOpen(item.id)}
        onOpenPr={() => {
          if (item.pr_url) window.open(item.pr_url, "_blank", "noopener,noreferrer");
        }}
        onPromote={() => onPromote(item.id)}
        onDemote={() => onDemote(item.id)}
      />
    </div>
  );
}

type CommonColumnBodyProps = {
  searching: boolean;
  onOpen: (id: number) => void;
  onPromote: (id: number) => void;
  onDemote: (id: number) => void;
  dragId: number | null;
  hoverIndex: number | null;
  onCardDragOver: (e: React.DragEvent, idx: number) => void;
  onDragStartCard: (e: React.DragEvent, id: number) => void;
  onDragEndCard: () => void;
  colTint: string;
};

function StandardColumnBody({
  items, hint, ...rest
}: CommonColumnBodyProps & { items: ApiBacklogTicket[]; hint: string }) {
  if (items.length === 0) {
    return (
      <div style={{ padding: "16px 6px", color: "var(--gooni-muted, #B0B0B5)", fontSize: 12, textAlign: "center" }}>
        {rest.searching ? "no matches" : hint}
      </div>
    );
  }
  return (
    <>
      {items.map((item, idx) => (
        <CardRow key={item.id} item={item} idx={idx} {...rest} />
      ))}
    </>
  );
}

function TodoColumnBody({
  priority, rest, expanded, onToggle, ...common
}: CommonColumnBodyProps & {
  priority: ApiBacklogTicket[];
  rest: ApiBacklogTicket[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const showRest = expanded;
  if (priority.length === 0 && rest.length === 0) {
    return (
      <div style={{ padding: "16px 6px", color: "var(--gooni-muted, #B0B0B5)", fontSize: 12, textAlign: "center" }}>
        {common.searching ? "no matches" : "Not yet picked up"}
      </div>
    );
  }
  return (
    <>
      {priority.map((item, idx) => (
        <CardRow key={item.id} item={item} idx={idx} {...common} />
      ))}
      {rest.length > 0 && (
        <>
          {!showRest && (
            <button
              onClick={onToggle}
              style={{
                marginTop: 2,
                padding: "6px 8px", borderRadius: 6,
                background: "transparent",
                border: "1px dashed rgba(0,0,0,0.10)",
                cursor: "pointer",
                fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
                fontFamily: FONT, textAlign: "left",
              }}
            >
              {rest.length} more →
            </button>
          )}
          {showRest && rest.map((item, idx) => (
            <CardRow
              key={item.id}
              item={item}
              idx={priority.length + idx}
              {...common}
            />
          ))}
          {showRest && (
            <button
              onClick={onToggle}
              style={{
                marginTop: 2,
                padding: "4px 8px",
                background: "transparent", border: "none", cursor: "pointer",
                fontSize: 10.5, color: "var(--gooni-muted, #8E8E93)",
                fontFamily: FONT, textAlign: "left",
              }}
            >
              ↑ collapse
            </button>
          )}
        </>
      )}
    </>
  );
}

function DoneColumnBody({
  recent, rest, expanded, onToggle, ...common
}: CommonColumnBodyProps & {
  recent: ApiBacklogTicket[];
  rest: ApiBacklogTicket[];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (recent.length === 0 && rest.length === 0) {
    return (
      <div style={{ padding: "16px 6px", color: "var(--gooni-muted, #B0B0B5)", fontSize: 12, textAlign: "center" }}>
        {common.searching ? "no matches" : "Shipped or closed"}
      </div>
    );
  }
  return (
    <>
      {recent.map((item, idx) => (
        <CardRow key={item.id} item={item} idx={idx} {...common} />
      ))}
      {rest.length > 0 && !expanded && (
        <button
          onClick={onToggle}
          style={{
            marginTop: 2,
            padding: "6px 8px", borderRadius: 6,
            background: "transparent",
            border: "1px dashed rgba(0,0,0,0.10)",
            cursor: "pointer",
            fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
            fontFamily: FONT, textAlign: "left",
          }}
        >
          Show all {recent.length + rest.length} completed →
        </button>
      )}
      {rest.length > 0 && expanded && rest.map((item, idx) => (
        <CardRow
          key={item.id}
          item={item}
          idx={recent.length + idx}
          {...common}
        />
      ))}
      {rest.length > 0 && expanded && (
        <button
          onClick={onToggle}
          style={{
            marginTop: 2,
            padding: "4px 8px",
            background: "transparent", border: "none", cursor: "pointer",
            fontSize: 10.5, color: "var(--gooni-muted, #8E8E93)",
            fontFamily: FONT, textAlign: "left",
          }}
        >
          ↑ show recent only
        </button>
      )}
    </>
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
  onPromote,
  onDemote,
}: {
  item: ApiBacklogTicket;
  dragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onCardDragOver: (e: React.DragEvent) => void;
  onClick: () => void;
  onOpenPr: () => void;
  onPromote: () => void;
  onDemote: () => void;
}) {
  const linkedToTodo = item.todo_id != null;
  const isAuto = isAutoEvalTicket(item);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onCardDragOver}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-card-action]")) return;
        onClick();
      }}
      style={{
        position: "relative",
        background: dragging ? "rgba(0,0,0,0.02)" : "var(--gooni-bg, #FFFFFF)",
        // Auto-generated eval tickets get a gray left border; real tickets
        // get a faint teal accent so the eye instantly distinguishes them
        // even before reading the title.
        border: "1px solid rgba(0,0,0,0.08)",
        borderLeft: `2px solid ${isAuto ? "#CBD5E1" : "#5EEAD4"}`,
        borderRadius: 8,
        padding: "6px 8px 6px 22px",
        cursor: dragging ? "grabbing" : "pointer",
        opacity: dragging ? 0.5 : isAuto ? 0.65 : 1,
        transition: "opacity 0.12s, border-color 0.12s, box-shadow 0.12s",
        userSelect: "none",
      }}
      onMouseEnter={(e) => {
        if (dragging) return;
        (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,0,0,0.16)";
        (e.currentTarget as HTMLElement).style.boxShadow = "0 1px 4px rgba(0,0,0,0.04)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = "rgba(0,0,0,0.08)";
        (e.currentTarget as HTMLElement).style.boxShadow = "none";
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 4, top: 7,
          width: 14, height: 14,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          color: "#B0B0B5",
          pointerEvents: "none",
        }}
      >
        <GripVertical size={12} strokeWidth={1.7} />
      </span>

      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        minWidth: 0,
      }}>
        <div style={{
          flex: 1, minWidth: 0,
          fontSize: isAuto ? 11.5 : 12.5,
          fontWeight: isAuto ? 400 : 500,
          color: "var(--gooni-text, #1C1C1E)",
          lineHeight: 1.35,
          // Single-line title — long titles truncate w/ ellipsis. Click
          // the card to see the full text in the modal.
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}>
          #{item.id} {item.text}
        </div>
        {/* Agent attribution pill — set on a ticket by an autonomous worker
            (Claude Code stamps claimed_by="claude" at task start). Backend
            auto-clears on done so the pill is implicitly live-only. */}
        {item.claimed_by && !item.done && (
          <span
            data-card-action
            title={`${item.claimed_by} is driving this ticket`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              padding: "2px 6px", borderRadius: 4,
              background: "rgba(217,70,239,0.10)", color: "#86198F",
              border: "1px solid rgba(217,70,239,0.30)",
              fontSize: 10.5, fontWeight: 600,
              flexShrink: 0,
            }}
          >
            <Bot size={10} strokeWidth={1.9} />
            {item.claimed_by} picked up
          </span>
        )}
        {/* Right-aligned action slot — single icon-only button. Promote
            (+todo) is the common case; demote (X next to "todo" pill)
            collapses into the same slot when already linked. */}
        {linkedToTodo ? (
          <span
            data-card-action
            title={`Linked to todo #${item.todo_id} — click X to unlink`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 2,
              padding: "1px 5px", borderRadius: 4,
              background: "rgba(59,130,246,0.10)", color: "#1D4ED8",
              border: "1px solid rgba(59,130,246,0.25)",
              fontSize: 9.5, fontWeight: 600,
              flexShrink: 0,
            }}
          >
            <ListChecks size={9} strokeWidth={1.7} />
            <button
              onClick={(e) => { e.stopPropagation(); onDemote(); }}
              title="Unlink (deletes the linked todo)"
              style={{
                display: "inline-flex", alignItems: "center",
                background: "transparent", border: "none",
                color: "#1D4ED8", cursor: "pointer", padding: 0,
              }}
            >
              <X size={9} strokeWidth={2} />
            </button>
          </span>
        ) : (
          <button
            data-card-action
            onClick={(e) => { e.stopPropagation(); onPromote(); }}
            title="Promote to todo on the dashboard"
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 18, height: 18, padding: 0, borderRadius: 4,
              background: "transparent", color: ctok.muted,
              border: "1px dashed rgba(0,0,0,0.18)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <Plus size={10} strokeWidth={2} />
          </button>
        )}
        {item.pr_url && (
          <button
            data-card-action
            onClick={(e) => { e.stopPropagation(); onOpenPr(); }}
            title={item.pr_url}
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 18, height: 18, padding: 0, borderRadius: 4,
              background: "rgba(22,163,74,0.10)", color: "#166534",
              border: "1px solid rgba(22,163,74,0.25)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <ExternalLink size={10} strokeWidth={1.7} />
          </button>
        )}
      </div>
      {item.subtitle && (
        <div style={{
          fontSize: 10.5, color: "var(--gooni-muted, #8E8E93)",
          marginTop: 2, lineHeight: 1.35,
          // Single-line subtitle — modal owns the full body.
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}>
          {item.subtitle}
        </div>
      )}
    </div>
  );
}

// Jira-style "+ Add card" pinned at the bottom of each column. Sits
// outside the scroll body so a long column doesn't push the affordance
// off-screen. Collapsed → pill; click → inline textarea + Save button.
// Enter saves, Shift+Enter newline, Escape cancels.
function AddCardFooter({ status, tint }: { status: BoardStatus; tint: string }) {
  const createTicket = useBacklogStore((s) => s.createTicket);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) taRef.current?.focus();
  }, [open]);

  async function commit() {
    const v = text.trim();
    if (!v) { setOpen(false); return; }
    setSaving(true);
    try {
      // board_status is null for not_yet (the implicit default state in
      // the legacy schema). Doing/done get explicit values.
      const board_status = status === "not_yet" ? null : status;
      await createTicket(v, { board_status });
      setText("");
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          width: "100%", padding: "7px 9px",
          background: "transparent",
          border: "none",
          borderRadius: 6,
          color: "var(--gooni-muted, #8E8E93)",
          cursor: "pointer", textAlign: "left",
          fontFamily: FONT, fontSize: 12,
          transition: "background 0.12s, color 0.12s",
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--gooni-text, #1C1C1E)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--gooni-muted, #8E8E93)";
        }}
      >
        <Plus size={12} strokeWidth={2} />
        Add card
      </button>
    );
  }

  return (
    <div
      style={{
        flexShrink: 0,
        background: "var(--gooni-bg, #FFFFFF)",
        border: `1px solid ${tint}`,
        borderRadius: 6,
        padding: 6,
        display: "flex", flexDirection: "column", gap: 6,
      }}
    >
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setText("");
            setOpen(false);
          }
        }}
        placeholder="What needs doing?"
        rows={2}
        style={{
          width: "100%", resize: "none",
          border: "none", outline: "none",
          background: "transparent",
          fontFamily: FONT, fontSize: 12.5,
          color: "var(--gooni-text, #1C1C1E)",
          padding: "2px 4px",
        }}
      />
      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
        <button
          onClick={() => { setText(""); setOpen(false); }}
          style={{
            padding: "3px 8px", borderRadius: 4,
            border: "none", background: "transparent",
            color: "var(--gooni-muted, #8E8E93)",
            fontFamily: FONT, fontSize: 11.5, cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          onClick={() => void commit()}
          disabled={saving || !text.trim()}
          style={{
            padding: "3px 10px", borderRadius: 4,
            border: "none",
            background: text.trim() && !saving ? tint : "rgba(0,0,0,0.10)",
            color: text.trim() && !saving ? "#FFFFFF" : "var(--gooni-muted, #8E8E93)",
            fontFamily: FONT, fontSize: 11.5, fontWeight: 600,
            cursor: text.trim() && !saving ? "pointer" : "default",
          }}
        >
          {saving ? "…" : "Add"}
        </button>
      </div>
    </div>
  );
}
