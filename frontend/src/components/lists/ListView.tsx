import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useListsStore } from "../../stores/useListsStore";
import type { ApiListItem, ListType } from "../../services/api";
import { ItemModal } from "./ItemModal";
import { color as ctok, FONT } from "../../ui";
import { parseServerDate } from "../../utils/date";

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

// Age tier for an open item, by days since created_at. Drives the subtle
// colored dot that flags todos that have been sitting around. Tiers:
//   <7d   → none (item is fresh, no nudge)
//   7–14d → gray-amber dot ("aging")
//   15–29d → amber dot ("stale")
//   ≥30d  → red dot ("old")
function ageIndicator(iso: string | null): { color: string; label: string } | null {
  const d = parseServerDate(iso);
  if (!d) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 7) return null;
  if (days < 15) return { color: "#FCD34D", label: `${days}d old — aging` };
  if (days < 30) return { color: "#F59E0B", label: `${days}d old — stale` };
  return { color: "#DC2626", label: `${days}d old — sitting too long` };
}

function relativeTime(iso: string | null): string {
  const d = parseServerDate(iso);
  if (!d) return "";
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
  const [flashId, setFlashId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [confirmingListDelete, setConfirmingListDelete] = useState(false);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropBeforeId, setDropBeforeId] = useState<number | null>(null);
  const [modalItemId, setModalItemId] = useState<number | null>(null);
  const [sortMode, setSortMode] = useState<"manual" | "recent">("manual");
  // Tick every minute so relative timestamps stay fresh without per-row state.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setNowTick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const composerRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoscrollFrame = useRef<number | null>(null);

  useEffect(() => { selectList(listId); }, [listId, selectList]);

  // Cancel any in-flight autoscroll rAF on unmount. MUST live up here with
  // the other hooks — NOT after the `if (!list) return` early return below.
  // Deleting a list flips `list` undefined on a still-mounted instance, the
  // early return fires, and a hook placed after it gets skipped → fewer
  // hooks than the prior render → React error #300 (crashes the whole tree).
  // stopAutoscroll is a hoisted function declaration, so referencing it here
  // before its textual definition is fine.
  useEffect(() => stopAutoscroll, []);

  const copy = useMemo(() => copyForType(list?.type || "generic"), [list?.type]);

  // Open vs done split — gated by list kind. In an idea list, nothing is
  // ever "done" so the done section disappears entirely (the per-item
  // done bit is preserved in the DB so flipping the list back to tasks
  // restores prior state).
  const listKindForSplit = list?.kind ?? "tasks";
  const { open, done } = useMemo(() => {
    const open: ApiListItem[] = [];
    const done: ApiListItem[] = [];
    for (const it of items) {
      if (listKindForSplit === "tasks" && it.done) done.push(it);
      else open.push(it);
    }
    if (sortMode === "recent") {
      // Newest first by created_at; null timestamps sink to the bottom.
      open.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    } else {
      open.sort((a, b) => a.sort_order - b.sort_order);
    }
    done.sort((a, b) => (b.completed_at || "").localeCompare(a.completed_at || ""));
    return { open, done };
  }, [items, listKindForSplit, sortMode]);

  async function handleAdd() {
    const text = composer.trim();
    if (!text) return;
    setComposer("");
    try {
      const created = await addItem(listId, text);
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
      <div style={{ flex: 1, padding: 40, fontFamily: FONT, color: ctok.muted }}>
        Loading…
      </div>
    );
  }

  // Drag near container edges → autoscroll. Browsers don't natively scroll
  // an overflow-y:auto container during HTML5 drag, so dragging an item to a
  // row that's offscreen is impossible. We sample the cursor's Y on each
  // dragOver and, if it's within EDGE px of the container's top/bottom,
  // scroll proportionally on a rAF tick.
  function handleContainerDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (draggingId == null) return;
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const EDGE = 64;
    const MAX_STEP = 18;
    const fromTop = e.clientY - rect.top;
    const fromBottom = rect.bottom - e.clientY;
    let delta = 0;
    if (fromTop < EDGE) delta = -Math.ceil(((EDGE - fromTop) / EDGE) * MAX_STEP);
    else if (fromBottom < EDGE) delta = Math.ceil(((EDGE - fromBottom) / EDGE) * MAX_STEP);
    if (delta === 0) {
      if (autoscrollFrame.current != null) {
        cancelAnimationFrame(autoscrollFrame.current);
        autoscrollFrame.current = null;
      }
      return;
    }
    if (autoscrollFrame.current != null) return;
    const step = () => {
      el.scrollBy({ top: delta });
      autoscrollFrame.current = requestAnimationFrame(step);
    };
    autoscrollFrame.current = requestAnimationFrame(step);
  }

  function stopAutoscroll() {
    if (autoscrollFrame.current != null) {
      cancelAnimationFrame(autoscrollFrame.current);
      autoscrollFrame.current = null;
    }
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

  // List-level kind drives whether items render as tasks (with checkbox)
  // or ideas (bullet only). Per-item `actionable` lingers in the DB but is
  // no longer surfaced or edited by the UI.
  const listKind = list.kind ?? "tasks";
  const isTaskList = listKind === "tasks";

  const renderRow = (it: ApiListItem, opts: { draggable: boolean }) => (
    <ListItemRow
      key={it.id}
      item={it}
      isTaskList={isTaskList}
      onToggle={() => updateItem(it.id, { done: !it.done })}
      onDelete={() => deleteItem(it.id)}
      onOpenSourceNote={onOpenSourceNote}
      onOpenDetail={() => setModalItemId(it.id)}
      onMakePrimary={undefined}
      doneLabel={copy.doneLabel}
      flashing={flashId === it.id}
      registerRef={(el) => {
        if (el) itemRefs.current.set(it.id, el);
        else itemRefs.current.delete(it.id);
      }}
      draggable={opts.draggable}
      isDragging={draggingId === it.id}
      onDragStart={() => {
        setDraggingId(it.id);
      }}
      onDragEnd={() => {
        setDraggingId(null);
        setDropBeforeId(null);
        stopAutoscroll();
      }}
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
      ref={scrollRef}
      onDragOver={handleContainerDragOver}
      onDragLeave={stopAutoscroll}
      onDrop={stopAutoscroll}
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
        {/* Sticky header so the list title + meta stay visible while scrolling
            through long lists. Lives inside the centered 720px column so the
            list items below scroll under it cleanly. Opaque background covers
            scrolling content; matches the outer container background.
            position:sticky resolves against the outer overflow-y:auto. */}
        <div style={{
          position: "sticky", top: 0, zIndex: 5,
          background: "#FFFFFF",
          padding: "32px 0 16px",
          borderBottom: "1px solid #F2F2F7",
        }}>
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
                  color: ctok.text,
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
                  color: ctok.text,
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
            {/* Type label + toggles previously rendered as 3 always-visible
                pills (GENERIC / TASKS / MANUAL). Daniel flagged the visual
                as ambiguous — the toggles didn't read as interactive. Now
                folded into a kebab dropdown next to the title; the GENERIC
                type label is dropped entirely (redundant: sidebar already
                shows which list this is). */}
            <ListSettingsMenu
              isTaskList={isTaskList}
              sortMode={sortMode}
              onToggleKind={() => updateList(list.id, { kind: isTaskList ? "ideas" : "tasks" })}
              onToggleSort={() => setSortMode((m) => (m === "manual" ? "recent" : "manual"))}
            />
            {canDeleteList && (
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                {confirmingListDelete ? (
                  <>
                    <span style={{ fontSize: 12, color: ctok.muted }}>Delete this list?</span>
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
          <div style={{ marginTop: 6, fontSize: 13, color: ctok.muted }}>
            {open.length} open · {done.length} {copy.doneLabel}
          </div>
        </div>

        {/* Primary focus drop strip lived here for focus-type lists; focus
            rows live in their own table now (see focus_service / FocusFlow).
            Generic lists never get this affordance. */}

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
            <span style={{ color: ctok.muted, fontSize: 14, lineHeight: 1, marginRight: 2 }}>+</span>
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
                color: ctok.text,
              }}
            />
            {composer.trim() && (
              <button
                onClick={handleAdd}
                style={{
                  border: "none",
                  background: ctok.text,
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
            <div style={{ padding: "20px 0", color: ctok.muted, fontSize: 14 }}>
              {copy.emptyHint}
            </div>
          )}

          {/* Drop slots between rows — fully separate elements that show a
              clean horizontal line at the insertion point. Shown only while a
              drag is in flight to avoid layout shift the rest of the time. */}
          {open.length === 0 && draggingId != null && (
            <DropSlot
              active={dropBeforeId === null}
              onEnter={() => setDropBeforeId(null)}
              onDrop={() => handleDrop(null)}
            />
          )}
          {open.map((it, idx) => (
            <div key={it.id}>
              {idx === 0 && draggingId != null && draggingId !== it.id && (
                <DropSlot
                  active={dropBeforeId === it.id}
                  onEnter={() => setDropBeforeId(it.id)}
                  onDrop={() => handleDrop(it.id)}
                />
              )}
              {renderRow(it, { draggable: sortMode === "manual" })}
              {/* Slot beneath this row points at the next item, or null if
                  this is the last row (drop = send to end). */}
              {draggingId != null && draggingId !== it.id && idx < open.length - 1 && (
                <DropSlot
                  active={dropBeforeId === open[idx + 1].id}
                  onEnter={() => setDropBeforeId(open[idx + 1].id)}
                  onDrop={() => handleDrop(open[idx + 1].id)}
                />
              )}
              {draggingId != null && idx === open.length - 1 && (
                <DropSlot
                  active={dropBeforeId === null}
                  onEnter={() => setDropBeforeId(null)}
                  onDrop={() => handleDrop(null)}
                />
              )}
            </div>
          ))}

          {done.length > 0 && (
            <div
              style={{
                padding: "18px 0 6px",
                fontSize: 11,
                color: ctok.muted,
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
  isTaskList: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onOpenSourceNote?: (noteId: number) => void;
  onOpenDetail: () => void;
  onMakePrimary?: () => void;
  doneLabel: string;
  flashing: boolean;
  registerRef: (el: HTMLDivElement | null) => void;
  draggable: boolean;
  isDragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}

function ListItemRow({
  item, isTaskList, onToggle, onDelete, onOpenSourceNote, onOpenDetail, onMakePrimary: _onMakePrimary, flashing, registerRef,
  draggable, isDragging, onDragStart, onDragEnd,
}: RowProps) {
  const [hover, setHover] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
      setConfirmingDelete(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { setMenuOpen(false); setConfirmingDelete(false); }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

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
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "10px 8px",
        borderBottom: "1px solid #F2F2F7",
        opacity: isDragging ? 0.55 : (isTaskList && item.done ? 0.55 : 1),
        borderRadius: 6,
        // Lift the dragged row visually: subtle scale-down + tinted background
        // + dashed outline so the user can clearly track which row is in
        // flight, even when the OS drag image is muted by the browser.
        transform: isDragging ? "scale(0.985)" : "none",
        background: isDragging ? "rgba(59,130,246,0.06)" : "transparent",
        outline: isDragging ? "1.5px dashed rgba(59,130,246,0.55)" : "none",
        outlineOffset: isDragging ? -2 : 0,
        transition: "transform 120ms ease, background 120ms, outline-color 120ms",
        animation: flashing ? "gooni-row-flash 1100ms ease-out" : undefined,
        cursor: draggable && hover ? "grab" : "default",
      }}
    >
      {isTaskList ? (
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
        <span
          aria-hidden
          style={{
            marginTop: 9,
            width: 6, height: 6, borderRadius: "50%",
            background: ctok.muted,
            flexShrink: 0,
          }}
        />
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          onClick={onOpenDetail}
          title="Click to open details"
          style={{
            display: "flex", alignItems: "center", gap: 6,
            fontSize: 14,
            color: isTaskList ? ctok.text : "#3F3F46",
            fontStyle: isTaskList ? "normal" : "italic",
            textDecoration: isTaskList && item.done ? "line-through" : "none",
            cursor: "pointer",
            wordBreak: "break-word",
          }}
        >
          <span>{item.text}</span>
          {/* ID tag — surfaces the row's numeric id so Daniel can paste
              "#42" into Claude Code instead of reading the substring back.
              Click copies the id to clipboard. Stops propagation so it
              doesn't open the detail modal. */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard?.writeText(`#${item.id}`).catch(() => {});
            }}
            title={`#${item.id} — click to copy`}
            style={{
              flexShrink: 0,
              border: "none",
              background: "rgba(0,0,0,0.04)",
              color: ctok.muted,
              fontFamily: "'SF Mono', Menlo, monospace",
              fontSize: 10.5,
              padding: "1px 6px",
              borderRadius: 999,
              cursor: "pointer",
              lineHeight: 1.4,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.08)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)"; }}
          >
            #{item.id}
          </button>
        </div>

        {item.subtitle && (
          <div style={{ marginTop: 3, fontSize: 12.5, color: ctok.muted, lineHeight: 1.45 }}>
            {item.subtitle}
          </div>
        )}

        {item.source_note_id && (
          <div style={{ marginTop: 4, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
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

      {/* Right-side meta row: age dot + ⋯ menu + timestamp. Menu always present
          so the row height never changes on hover; timestamp stays at the far
          right. The age dot appears only on open task items that have been
          sitting for ≥7 days, as a subtle nudge. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, minWidth: 90, justifyContent: "flex-end" }}>
        {isTaskList && !item.done && (() => {
          const age = ageIndicator(item.created_at);
          if (!age) return null;
          return (
            <span
              title={age.label}
              aria-label={age.label}
              style={{
                width: 7, height: 7, borderRadius: "50%",
                background: age.color, flexShrink: 0,
                boxShadow: `0 0 0 2px ${age.color}22`,
              }}
            />
          );
        })()}
        <div ref={menuRef} style={{ position: "relative" }}>
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); setConfirmingDelete(false); }}
            aria-label="Item actions"
            title="Item actions"
            style={{
              border: "none",
              background: menuOpen ? "rgba(0,0,0,0.06)" : "transparent",
              color: ctok.muted,
              cursor: "pointer",
              padding: "2px 4px",
              borderRadius: 6,
              fontSize: 16,
              lineHeight: 1,
              opacity: hover || menuOpen ? 1 : 0.55,
              transition: "opacity 120ms, background 120ms",
              fontFamily: FONT,
            }}
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              role="menu"
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                right: 0,
                minWidth: 160,
                background: "#FFFFFF",
                border: "0.5px solid rgba(0,0,0,0.10)",
                borderRadius: 8,
                boxShadow: "0 8px 20px rgba(0,0,0,0.10), 0 2px 4px rgba(0,0,0,0.04)",
                padding: 4,
                zIndex: 30,
                fontFamily: FONT,
              }}
            >
              {/* "Make primary" was a focus-only action; primary lives on
                  Focus rows now (extracted from list_items). Generic list
                  rows can't be primary. */}
              {confirmingDelete ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "6px 8px" }}>
                  <span style={{ fontSize: 12, color: "#6B7280" }}>Delete this item?</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={() => { setMenuOpen(false); setConfirmingDelete(false); onDelete(); }}
                      style={{
                        flex: 1,
                        border: "none",
                        background: "#DC2626",
                        color: "#FFFFFF",
                        cursor: "pointer",
                        fontSize: 12,
                        fontFamily: FONT,
                        padding: "4px 10px",
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
                        padding: "4px 8px",
                        borderRadius: 6,
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <MenuItem
                  onClick={() => setConfirmingDelete(true)}
                  color="#DC2626"
                  icon={<TrashIcon />}
                  label="Delete"
                />
              )}
            </div>
          )}
        </div>
        <div style={{ fontSize: 11, color: ctok.muted, whiteSpace: "nowrap" }}>
          {isTaskList && item.done && item.completed_at
            ? `done ${relativeTime(item.completed_at)}`
            : relativeTime(item.created_at)}
        </div>
      </div>
    </div>
  );
}

function MenuItem({
  onClick, color, icon, label,
}: { onClick: () => void; color: string; icon: ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        width: "100%",
        border: "none",
        background: "transparent",
        color,
        cursor: "pointer",
        fontSize: 13,
        fontFamily: FONT,
        padding: "6px 10px",
        borderRadius: 6,
        textAlign: "left",
        transition: "background 100ms",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
    >
      <span style={{ width: 16, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{icon}</span>
      <span>{label}</span>
    </button>
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

// Discrete drop target rendered between rows during drag. Renders as a 6px
// gap that lights up to a 2px blue line at the insertion point. Independent
// from row borders so we don't get the rounded-corner artifacts the row's
// own borderTop produced.
function DropSlot({
  active, onEnter, onDrop,
}: { active: boolean; onEnter: () => void; onDrop: () => void }) {
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; onEnter(); }}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
      style={{
        position: "relative",
        height: active ? 12 : 8,
        margin: "1px 0",
        transition: "height 120ms ease",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0, right: 0,
          top: active ? 4 : 3,
          height: active ? 3 : 2,
          background: active ? "#3B82F6" : "transparent",
          borderRadius: 2,
          boxShadow: active ? "0 0 0 3px rgba(59,130,246,0.18)" : "none",
          transition: "background 100ms, height 120ms ease, top 120ms ease, box-shadow 120ms",
        }}
      />
      {active && (
        <>
          <div style={{
            position: "absolute", left: -4, top: 1,
            width: 9, height: 9, borderRadius: "50%",
            background: "#3B82F6",
            boxShadow: "0 0 0 3px rgba(59,130,246,0.18)",
          }} />
          <div style={{
            position: "absolute", right: -4, top: 1,
            width: 9, height: 9, borderRadius: "50%",
            background: "#3B82F6",
            boxShadow: "0 0 0 3px rgba(59,130,246,0.18)",
          }} />
        </>
      )}
    </div>
  );
}

// Kebab dropdown holding list-level settings that previously rendered as
// always-visible pills next to the title. Hidden behind a •••  button so
// the header reads as "title + actions" instead of "title + cryptic pill
// row". Each menu row's right-hand chip surfaces the current value so the
// user can read state at a glance without opening it.
function ListSettingsMenu({
  isTaskList,
  sortMode,
  onToggleKind,
  onToggleSort,
}: {
  isTaskList: boolean;
  sortMode: "manual" | "recent";
  onToggleKind: () => void;
  onToggleSort: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", marginLeft: 6 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="List settings"
        aria-label="List settings"
        style={{
          width: 28, height: 28, borderRadius: 6,
          border: "none",
          background: open ? "rgba(0,0,0,0.06)" : "transparent",
          color: "#6B7280",
          cursor: "pointer",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          padding: 0,
          transition: "background 120ms",
        }}
        onMouseEnter={(e) => { if (!open) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)"; }}
        onMouseLeave={(e) => { if (!open) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="2.5" r="1.2" fill="currentColor" />
          <circle cx="7" cy="7"   r="1.2" fill="currentColor" />
          <circle cx="7" cy="11.5" r="1.2" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            background: "var(--gooni-card, #FFFFFF)",
            border: "1px solid rgba(0,0,0,0.08)",
            borderRadius: 10,
            boxShadow: "0 12px 32px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)",
            minWidth: 220,
            zIndex: 50,
            padding: 6,
            fontFamily: FONT,
          }}
        >
          <MenuRow
            label="List kind"
            value={isTaskList ? "Tasks" : "Ideas"}
            onClick={() => { onToggleKind(); setOpen(false); }}
            help={isTaskList ? "Items show checkboxes. Click to switch to Ideas (bullet style)." : "Items render as bullets. Click to switch to Tasks (checkboxes)."}
          />
          <MenuRow
            label="Sort"
            value={sortMode === "manual" ? "Manual (drag)" : "Recent first"}
            onClick={() => { onToggleSort(); setOpen(false); }}
            help={sortMode === "manual" ? "Click to sort by most recently added." : "Click to restore manual drag-order."}
          />
        </div>
      )}
    </div>
  );
}

function MenuRow({
  label, value, onClick, help,
}: { label: string; value: string; onClick: () => void; help?: string }) {
  return (
    <button
      onClick={onClick}
      title={help}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        width: "100%", gap: 14,
        padding: "8px 10px",
        background: "transparent",
        border: "none",
        borderRadius: 6,
        cursor: "pointer",
        fontFamily: FONT,
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
    >
      <span style={{ fontSize: 13, color: ctok.text }}>{label}</span>
      <span style={{
        fontSize: 11.5, color: "#3C3C43",
        background: "rgba(0,0,0,0.05)",
        padding: "2px 8px", borderRadius: 999,
        fontWeight: 500,
      }}>
        {value}
      </span>
    </button>
  );
}
