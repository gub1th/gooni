import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Wind, Crown, HelpCircle } from "lucide-react";
import {
  fetchItemTree, createItem, updateItem, deleteItem, reorderItems, suggestFocus,
  fetchTodayTodos,
  type ApiItemTree, type ApiItemNode, type FocusScale,
  type TodayTodo, type FocusChip,
} from "../services/api";
import { ListPlus } from "lucide-react";
import { DeriveTodoModal } from "./DeriveTodoModal";
import { FocusOverlay, loadFocusMode, saveFocusMode, clearFocusMode } from "./FocusOverlay";

// Focus Flow — primary spotlight + Quick/Slow sections + add-focus modal +
// lock animation + completion celebration. Replaces the old ActivityCard
// "Focuses" block; mounts at the same dashboard slot.
//
// Data model lives in `list_items`: status ∈ {committed, someday}, scale ∈
// {quick, slow}, health/confidence/start_at/end_at all nullable. The focus
// pill (existing FocusOverlay distraction mode) is wired on every committed
// row + the spotlight, not just the primary, per design.

const FONT = "'Inter', -apple-system, sans-serif";

type Tone = "playful" | "warm" | "direct";
const TONE_COPY: Record<Tone, {
  name: string; commit: string; schedule: string;
  yes: string; yesSub: string; no: string; noSub: string;
  placeholder: string;
}> = {
  playful: {
    name: "What are we locking in?",
    commit: "Are we locking this in?",
    schedule: "When does this thing live and die?",
    yes: "Yes", yesSub: "Lock it in",
    no: "Not yet", noSub: "Save as someday",
    placeholder: "the thing you're going to do…",
  },
  warm: {
    name: "What's pulling on you?",
    commit: "Are you committed to this?",
    schedule: "When should this start and end?",
    yes: "Yes", yesSub: "I'm in",
    no: "Not yet", noSub: "Park it for someday",
    placeholder: "what's on your mind…",
  },
  direct: {
    name: "Name your focus.",
    commit: "Commit to this focus?",
    schedule: "Set a window.",
    yes: "Yes", yesSub: "Commit",
    no: "No", noSub: "Save as someday",
    placeholder: "Focus name",
  },
};

// 0 → red, 50 → amber, 100 → green via oklch hue lerp. Returns null when
// either input is missing or confidence is too low — caller renders a
// neutral dot in that case.
function healthColor(health: number | null, confidence: number | null): string | null {
  if (health == null || confidence == null || confidence < 35) return null;
  const t = Math.max(0, Math.min(100, health)) / 100;
  const hue = 25 + (145 - 25) * t;
  const light = 0.66 + 0.06 * t;
  const chroma = 0.18 - 0.02 * t;
  return `oklch(${light} ${chroma} ${hue})`;
}

function fmtWindow(start: string | null, end: string | null): string {
  if (!start && !end) return "";
  const fmt = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const today = new Date(); today.setHours(0,0,0,0);
    const target = new Date(d); target.setHours(0,0,0,0);
    const diff = Math.round((target.getTime() - today.getTime()) / 86400000);
    if (diff === 0) {
      const h = d.getHours() % 12 || 12;
      const ap = d.getHours() >= 12 ? "PM" : "AM";
      return `Today ${h}:${String(d.getMinutes()).padStart(2, "0")} ${ap}`;
    }
    if (diff === 1) return "Tomorrow";
    if (diff === -1) return "Yesterday";
    if (diff > 0 && diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  return `${start ? fmt(start) : "—"} → ${end ? fmt(end) : "—"}`;
}

// Lock the local-tz ISO datetime-local input into "YYYY-MM-DDTHH:MM" so
// roundtripping through <input type="datetime-local"> doesn't drift on TZ.
function toLocalISO(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function defaultStart(): string {
  return toLocalISO(new Date());
}
function defaultEnd(): string {
  const d = new Date(); d.setHours(23, 59, 0, 0);
  return toLocalISO(d);
}
// Convert local datetime string ("YYYY-MM-DDTHH:MM") to a UTC ISO string
// the backend will round-trip cleanly via fromisoformat.
function localToISO(local: string): string {
  return new Date(local).toISOString();
}

// ── Days-since + primary timer ────────────────────────────────────────────

// "since X" copy. Days for >24h, hours for fresh focuses, "today" for <1h.
function fmtSince(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const ms = Date.now() - d.getTime();
  if (ms < 0) return "starts soon";
  const h = Math.floor(ms / (1000 * 60 * 60));
  if (h < 1) return "just now";
  if (h < 24) return `${h}h in`;
  const days = Math.floor(h / 24);
  if (days === 1) return "1 day in";
  return `${days} days in`;
}

// Primary timer: when the user pins a focus as primary, we stash the
// timestamp keyed by id in localStorage. No server schema needed for now;
// upgrading to a `primary_set_at` column is an easy follow-up.
const PRIMARY_STARTS_KEY = "gooni-primary-starts-v1";

function loadPrimaryStarts(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PRIMARY_STARTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function setPrimaryStart(id: number, ts: number) {
  try {
    const map = loadPrimaryStarts();
    map[String(id)] = ts;
    localStorage.setItem(PRIMARY_STARTS_KEY, JSON.stringify(map));
  } catch { /* swallow — non-critical UX */ }
}
function clearPrimaryStart(id: number) {
  try {
    const map = loadPrimaryStarts();
    delete map[String(id)];
    localStorage.setItem(PRIMARY_STARTS_KEY, JSON.stringify(map));
  } catch { /* swallow */ }
}

// Subscribe to a re-render every minute so "X days in primary" + "N days in"
// stay live without forcing a full query refetch.
function useNowMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// ── Component ──────────────────────────────────────────────────────────────

// Drop indicator state — captures which row's edge the cursor is over.
// `before` = drop above the row; `after` = drop below.
type DropTarget = { id: number; edge: "before" | "after" } | null;

export function FocusFlow() {
  const queryClient = useQueryClient();
  const { data: tree, isLoading } = useQuery<ApiItemTree>({
    queryKey: ["item-tree"],
    queryFn: fetchItemTree,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["item-tree"] });

  // Optimistic local override: drag-reorder mutates this immediately so the
  // visible order matches the cursor; the server reorder + refetch then
  // catch up. Cleared when tree data changes (new query payload arrives).
  const [optimistic, setOptimistic] = useState<ApiItemNode[] | null>(null);
  useEffect(() => { setOptimistic(null); }, [tree]);

  const focuses = (optimistic ?? tree?.focuses ?? []).filter((f) => !f.done);
  const primary = focuses.find((f) => f.is_primary);
  const active = focuses.filter((f) => f.status !== "someday");
  const someday = focuses.filter((f) => f.status === "someday");
  const quick = active
    .filter((f) => (f.scale ?? "slow") === "quick")
    .sort((a, b) => a.sort_order - b.sort_order);
  const slow = active
    .filter((f) => (f.scale ?? "slow") === "slow")
    .sort((a, b) => a.sort_order - b.sort_order);

  const [showModal, setShowModal] = useState(false);
  const [seed, setSeed] = useState<{ text: string; endgoal: string | null; scale: FocusScale | null } | null>(null);
  const [lockShown, setLockShown] = useState<{ caption: string } | null>(null);
  const [celebration, setCelebration] = useState<{ kind: "primary" | "row"; title: string } | null>(null);
  const [newId, setNewId] = useState<number | null>(null);
  // Undo toast for any focus completion. Pending completion stays in
  // server state (we don't fire the mutation until the toast expires) so
  // an Undo within the window is a pure local revert.
  const [pendingDone, setPendingDone] = useState<{ node: ApiItemNode } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Drag state — held at the parent so cross-section drops know what they
  // started with.
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [drop, setDrop] = useState<DropTarget>(null);

  async function handleSuggest() {
    try {
      const s = await suggestFocus();
      if (s.text) {
        setSeed({ text: s.text, endgoal: s.endgoal, scale: s.scale });
        setShowModal(true);
      }
    } catch (e) { console.error(e); }
  }

  async function handleCreate(payload: {
    title: string;
    type: FocusScale;
    status: "committed" | "someday";
    start_at: string | null;
    end_at: string | null;
    health: number | null;
    confidence: number | null;
  }) {
    try {
      const created = await createItem({
        text: payload.title,
        endgoal: seed?.endgoal || null,
        scale: payload.type,
        status: payload.status,
        committed: payload.status === "committed",
        health: payload.health,
        confidence: payload.confidence,
        start_at: payload.start_at,
        end_at: payload.end_at,
      });
      setShowModal(false);
      setSeed(null);
      setNewId(created.id);
      if (payload.status === "committed") {
        setLockShown({
          caption: payload.type === "quick" ? "Quick. Locked in." : "Locked in.",
        });
        setTimeout(() => setLockShown(null), 1500);
      }
      setTimeout(() => setNewId(null), 1200);
      refresh();
    } catch (e) { console.error(e); }
  }

  // Promote to primary AND auto-move the row to position 0 in its scale
  // section. Server reorder is best-effort: if it fails we still set the
  // primary flag so the spotlight reflects the change.
  async function handleSetPrimary(id: number) {
    const node = focuses.find((f) => f.id === id);
    try {
      await updateItem(id, { is_primary: true });
      setPrimaryStart(id, Date.now());
      // Also rewrite sort_order so this row is the first one in its scale
      // bucket. The reorder endpoint takes the whole list — we send all
      // active focuses with the promoted one bumped to the front of its
      // section. Tree refetch normalises the server state afterward.
      if (node) {
        const scale = (node.scale ?? "slow") as FocusScale;
        const peers = active.filter((f) => (f.scale ?? "slow") === scale && f.id !== id);
        const others = active.filter((f) => (f.scale ?? "slow") !== scale);
        const order = [node, ...peers, ...others];
        try { await reorderItems(order.map((f) => f.id)); } catch { /* non-fatal */ }
      }
      refresh();
    } catch (e) { console.error(e); }
  }
  async function handleClearPrimary(id: number) {
    try {
      clearPrimaryStart(id);
      await updateItem(id, { is_primary: false });
      refresh();
    } catch (e) { console.error(e); }
  }
  async function handleRemove(id: number) {
    try {
      await deleteItem(id);
      refresh();
    } catch (e) { console.error(e); }
  }

  // Derive-todo modal state — focusId !== null means modal is open. The
  // network call lives inside the modal; we just refresh the Today's-todos
  // list when it succeeds so the new row appears immediately.
  const [deriveFor, setDeriveFor] = useState<{ id: number; title: string } | null>(null);
  function handleDeriveTodo(focusId: number) {
    const node = focuses.find((f) => f.id === focusId);
    setDeriveFor({ id: focusId, title: node?.text ?? "" });
  }
  // Done flow: optimistic remove (so the row visibly slides away) + queue
  // a 6s mutation. The Undo button cancels the timer + re-adds the node
  // locally; server state never changes.
  function handleComplete(node: ApiItemNode) {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setPendingDone({ node });
    setCelebration({ kind: node.is_primary ? "primary" : "row", title: node.text });
    setOptimistic((prev) => (prev ?? tree?.focuses ?? []).filter((f) => f.id !== node.id));
    if (node.is_primary) clearPrimaryStart(node.id);
    setTimeout(() => setCelebration(null), node.is_primary ? 2200 : 1300);
    undoTimerRef.current = setTimeout(async () => {
      try {
        await updateItem(node.id, { done: true, is_primary: false });
      } catch (e) { console.error(e); }
      setPendingDone(null);
      refresh();
    }, 6000);
  }
  function handleUndoDone() {
    if (!pendingDone) return;
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setOptimistic(null);
    setPendingDone(null);
  }

  // ── Drag-reorder ────────────────────────────────────────────────────
  // We commit the new order on drop, mutating the optimistic array so the
  // row visibly snaps into the new slot before the server roundtrip. If
  // the dragged row crosses sections, its scale flips too.
  const onRowDragStart = useCallback((id: number) => {
    setDraggingId(id);
    setDrop(null);
  }, []);
  const onRowDragEnd = useCallback(() => {
    setDraggingId(null);
    setDrop(null);
  }, []);
  const onRowDragOver = useCallback((target: ApiItemNode, edge: "before" | "after") => {
    if (draggingId == null || draggingId === target.id) return;
    setDrop({ id: target.id, edge });
  }, [draggingId]);
  const handleDrop = useCallback(async () => {
    if (draggingId == null || !drop) return;
    const dragged = focuses.find((f) => f.id === draggingId);
    const target = focuses.find((f) => f.id === drop.id);
    if (!dragged || !target) return;
    const targetScale: FocusScale = (target.scale ?? "slow") as FocusScale;
    const scaleChanged = (dragged.scale ?? "slow") !== targetScale;

    // Build a flat ordered list of all active focuses in their new order:
    // - keep current quick + slow ordering minus the dragged row
    // - splice the dragged row in before/after the target
    const flat: ApiItemNode[] = [];
    for (const f of [...quick, ...slow]) {
      if (f.id === draggingId) continue;
      if (f.id === target.id) {
        if (drop.edge === "before") {
          flat.push({ ...dragged, scale: targetScale });
          flat.push(f);
        } else {
          flat.push(f);
          flat.push({ ...dragged, scale: targetScale });
        }
      } else {
        flat.push(f);
      }
    }
    // Optimistic — slot in the rearranged list (someday items unchanged).
    setOptimistic([...flat, ...someday]);
    setDraggingId(null);
    setDrop(null);
    try {
      if (scaleChanged) {
        await updateItem(dragged.id, { scale: targetScale });
      }
      await reorderItems(flat.map((n) => n.id));
      refresh();
    } catch (e) {
      console.error(e);
      setOptimistic(null);
    }
  }, [draggingId, drop, focuses, quick, slow, someday]);

  return (
    <div style={{ fontFamily: FONT }}>
      <FocusFlowStyles />

      <Spotlight
        f={primary}
        onClearPrimary={handleClearPrimary}
        onComplete={handleComplete}
      />

      <div className="ff-toolbar">
        <span className="ff-toolbar-label">Focuses</span>
        <span className="ff-toolbar-count">
          {active.length} active{someday.length > 0 ? ` · ${someday.length} someday` : ""}
        </span>
        <span style={{ flex: 1 }} />
        <button className="ff-ghost" onClick={handleSuggest}>
          <Sparkles size={11} /> suggest
        </button>
        <button
          className="ff-add-link"
          onClick={() => { setSeed(null); setShowModal(true); }}
        >
          + add focus
        </button>
      </div>

      {isLoading && !tree ? (
        <div className="ff-empty">Loading…</div>
      ) : (
        <>
          {/* Today's todos — replaces the old "Quick · today" section. Pulls
              from the Todo list filtered to due_date == today. Each row shows
              the focuses it's linked to as small chips. Quick-scale focuses
              (legacy) no longer render on the dashboard. */}
          <TodayTodos />

          <SectionLabel label="Slow burn" count={slow.length} />
          {slow.length === 0 ? (
            <div className="ff-empty">No slow-burn focuses yet.</div>
          ) : (
            <div>
              {slow.map((f) => (
                <FocusFlowRow
                  key={f.id}
                  node={f}
                  onSetPrimary={handleSetPrimary}
                  onClearPrimary={handleClearPrimary}
                  onRemove={handleRemove}
                  onComplete={handleComplete}
                  onDeriveTodo={handleDeriveTodo}
                  isNew={f.id === newId}
                  draggingId={draggingId}
                  drop={drop}
                  onDragStart={onRowDragStart}
                  onDragEnd={onRowDragEnd}
                  onDragOver={onRowDragOver}
                  onDrop={handleDrop}
                />
              ))}
            </div>
          )}

          {someday.length > 0 && (
            <>
              <SectionLabel label="Someday" count={someday.length} />
              {someday.map((f) => (
                <FocusFlowRow
                  key={f.id}
                  node={f}
                  onSetPrimary={handleSetPrimary}
                  onClearPrimary={handleClearPrimary}
                  onRemove={handleRemove}
                  onComplete={handleComplete}
                  onDeriveTodo={handleDeriveTodo}
                  isNew={f.id === newId}
                  draggingId={null}
                  drop={null}
                  onDragStart={() => {}}
                  onDragEnd={() => {}}
                  onDragOver={() => {}}
                  onDrop={() => {}}
                />
              ))}
            </>
          )}
        </>
      )}

      {showModal && (
        <AddFocusModal
          seed={seed}
          tone="playful"
          onClose={() => { setShowModal(false); setSeed(null); }}
          onCreate={handleCreate}
        />
      )}

      {lockShown && <LockOverlay caption={lockShown.caption} />}
      {celebration && <CompletionCelebration kind={celebration.kind} title={celebration.title} />}

      {pendingDone && (
        <div role="status" aria-live="polite" className="ff-undo-toast">
          <span>Done — "{pendingDone.node.text}"</span>
          <button className="ff-undo-btn" onClick={handleUndoDone}>Undo</button>
        </div>
      )}

      <DeriveTodoModal
        open={deriveFor != null}
        focusId={deriveFor?.id ?? null}
        focusTitle={deriveFor?.title}
        onClose={() => setDeriveFor(null)}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ["today-todos"] })}
      />
    </div>
  );
}

// ── Spotlight ──────────────────────────────────────────────────────────────

function Spotlight({ f, onClearPrimary, onComplete }: {
  f: ApiItemNode | undefined;
  onClearPrimary: (id: number) => void;
  onComplete: (n: ApiItemNode) => void;
}) {
  // Re-render every minute so the running primary timer ticks.
  useNowMinute();
  if (!f) {
    return (
      <div className="ff-spotlight ff-spotlight-empty">
        <div className="ff-spot-lab">
          <Crown size={12} strokeWidth={1.8} className="ff-spot-crown ff-spot-crown-empty" />
          Primary focus
        </div>
        <div className="ff-spot-title-empty">No primary set.</div>
        <div className="ff-spot-meta">Pick a focus from the list and crown it.</div>
      </div>
    );
  }
  const color = healthColor(f.health, f.confidence);
  // Primary timer: prefer the localStorage stamp set when the user
  // promotes the focus; fall back to start_at if we somehow lost the
  // stamp (e.g. promoted in a different browser).
  const starts = loadPrimaryStarts();
  const primarySinceMs = starts[String(f.id)] ?? (f.start_at ? new Date(f.start_at).getTime() : null);
  const primarySinceISO = primarySinceMs ? new Date(primarySinceMs).toISOString() : null;
  return (
    <div className="ff-spotlight">
      <div className="ff-spot-row">
        <div className="ff-spot-lab">
          <Crown size={13} strokeWidth={1.8} fill="currentColor" className="ff-spot-crown" />
          Primary focus
        </div>
        <span style={{ flex: 1 }} />
        <FocusModePill node={f} />
        <button className="ff-spot-btn" onClick={() => onComplete(f)}>✓ Mark done</button>
        <button className="ff-spot-btn" onClick={() => onClearPrimary(f.id)}>Clear primary</button>
      </div>
      <div className="ff-spot-title">{f.text}</div>
      <div className="ff-spot-meta">
        <HealthGlyph color={color} />
        <span>Health <strong>{color ? f.health : "—"}</strong>/100</span>
        {color && (
          <span className="ff-health-bar">
            <span style={{ width: `${f.health}%`, background: color }} />
          </span>
        )}
        {f.confidence != null && <span className="ff-spot-conf">conf {f.confidence}%</span>}
        {primarySinceISO && (
          <span className="ff-spot-conf">· {fmtSince(primarySinceISO)} as primary</span>
        )}
      </div>
    </div>
  );
}

// Health pip — green dot when known, gray question-mark icon when health
// is null OR confidence is too low. Same footprint either way so the
// surrounding layout doesn't jump as scores roll in.
function HealthGlyph({ color }: { color: string | null }) {
  if (!color) {
    return (
      <span
        className="ff-health-unknown"
        title="Health unknown — needs more activity to score"
        aria-label="Health unknown"
      >
        <HelpCircle size={11} strokeWidth={1.8} />
      </span>
    );
  }
  return <span className="ff-dot" style={{ background: color }} />;
}

// ── Row ────────────────────────────────────────────────────────────────────

function FocusFlowRow({
  node, onSetPrimary, onClearPrimary, onRemove, onComplete, onDeriveTodo, isNew,
  draggingId, drop,
  onDragStart, onDragEnd, onDragOver, onDrop,
}: {
  node: ApiItemNode;
  onSetPrimary: (id: number) => void;
  onClearPrimary: (id: number) => void;
  onRemove: (id: number) => void;
  onComplete: (n: ApiItemNode) => void;
  onDeriveTodo?: (focusId: number) => void;
  isNew?: boolean;
  draggingId: number | null;
  drop: DropTarget;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
  onDragOver: (target: ApiItemNode, edge: "before" | "after") => void;
  onDrop: () => void;
}) {
  const [doneAnim, setDoneAnim] = useState(false);
  const color = healthColor(node.health, node.confidence);
  const someday = node.status === "someday";
  // Re-render once a minute so "N days in" stays current.
  useNowMinute();

  function handleCheck(e: React.MouseEvent) {
    e.stopPropagation();
    setDoneAnim(true);
    // Slide-out animation duration. We hand off to onComplete which queues
    // the actual mutation behind the undo toast.
    setTimeout(() => onComplete(node), 600);
  }

  function handleStarClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (node.is_primary) onClearPrimary(node.id);
    else onSetPrimary(node.id);
  }

  const isDragging = draggingId === node.id;
  const isDropBefore = drop?.id === node.id && drop.edge === "before";
  const isDropAfter = drop?.id === node.id && drop.edge === "after";

  const cls = [
    "ff-row",
    node.is_primary ? "ff-row-primary" : "",
    someday ? "ff-row-someday" : "",
    isNew ? "ff-row-new" : "",
    doneAnim ? "ff-row-done" : "",
    isDragging ? "ff-row-dragging" : "",
  ].join(" ").trim();

  function handleDragOver(e: React.DragEvent) {
    if (draggingId == null || draggingId === node.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const edge = (e.clientY - rect.top) < rect.height / 2 ? "before" : "after";
    onDragOver(node, edge);
  }

  return (
    <div
      className={cls}
      data-focus-id={node.id}
      draggable={!someday && !doneAnim}
      onDragStart={(e) => {
        if (someday || doneAnim) return;
        e.dataTransfer.effectAllowed = "move";
        onDragStart(node.id);
      }}
      onDragEnd={onDragEnd}
      onDragOver={handleDragOver}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
    >
      {isDropBefore && <div className="ff-drop-line ff-drop-line-top" />}
      <button
        className={"ff-check-dot " + (doneAnim ? "ff-check-checked" : "")}
        onClick={handleCheck}
        title="Mark done"
        aria-label="Mark done"
      >
        <HealthGlyph color={color} />
        {/* Animated checkmark — strokes in on hover/checked, no big black blob. */}
        <svg className="ff-check-svg" viewBox="0 0 14 14" fill="none">
          <path d="M3 7.5 L6 10.2 L11 4.5"
            stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="ff-row-body">
        <div className="ff-row-title">{node.text}</div>
        <div className="ff-row-meta">
          {node.start_at ? fmtSince(node.start_at) : (someday ? "" : "just now")}
          {node.end_at && <span> · until {fmtWindow(null, node.end_at).replace("— → ", "")}</span>}
        </div>
      </div>
      <div className="ff-row-actions">
        {!someday && <FocusModePill node={node} />}
        {!someday && onDeriveTodo && (
          <button
            className="ff-icon-btn"
            onClick={(e) => { e.stopPropagation(); onDeriveTodo(node.id); }}
            title="Derive a todo from this focus"
            aria-label="Derive todo"
          >
            <ListPlus size={13} strokeWidth={1.8} />
          </button>
        )}
        <button
          className={"ff-crown-btn " + (node.is_primary ? "ff-crown-active" : "")}
          onClick={handleStarClick}
          title={node.is_primary ? "Unset primary" : "Make primary"}
          aria-label={node.is_primary ? "Unset primary" : "Make primary"}
          aria-pressed={node.is_primary}
        >
          <Crown
            size={14}
            strokeWidth={1.8}
            fill={node.is_primary ? "currentColor" : "none"}
          />
        </button>
        <button
          className="ff-icon-btn"
          onClick={(e) => { e.stopPropagation(); onRemove(node.id); }}
          title="Remove (no celebration)"
          aria-label="Remove"
        >×</button>
      </div>
      {isDropAfter && <div className="ff-drop-line ff-drop-line-bottom" />}
    </div>
  );
}

// ── Today's todos ──────────────────────────────────────────────────────────
// Replaces the old "Quick · today" focus column on the dashboard. Pulls from
// the Todo list (due_date == today) and shows linked focuses as chips so
// the conceptual link from "what I'm working on" → "what serves it" is
// visible on the dashboard at a glance.
function TodayTodos() {
  const queryClient = useQueryClient();
  const { data: todos = [], isLoading } = useQuery<TodayTodo[]>({
    queryKey: ["today-todos"],
    queryFn: fetchTodayTodos,
  });

  async function handleToggle(t: TodayTodo) {
    try {
      await updateItem(t.id, { done: !t.done });
      queryClient.invalidateQueries({ queryKey: ["today-todos"] });
    } catch (e) { console.error("toggle todo failed", e); }
  }

  function handleChipClick(focusId: number) {
    // Best-effort smooth scroll to the focus row. The row id is set on
    // FocusFlowRow's data-focus-id attribute below.
    const el = document.querySelector<HTMLElement>(`[data-focus-id="${focusId}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <>
      <SectionLabel label="Today's todos" count={todos.length} />
      {isLoading ? (
        <div className="ff-empty">Loading…</div>
      ) : todos.length === 0 ? (
        <div className="ff-empty">No todos due today. Derive one from a focus →</div>
      ) : (
        <div>
          {todos.map((t) => (
            <div key={t.id} className={"ff-row ff-todo-row " + (t.done ? "ff-row-done-static" : "")}>
              <button
                className={"ff-check-dot " + (t.done ? "ff-check-checked" : "")}
                onClick={() => handleToggle(t)}
                title={t.done ? "Mark not done" : "Mark done"}
                aria-label={t.done ? "Mark not done" : "Mark done"}
              >
                <span className="ff-todo-checkmark">
                  <svg className="ff-check-svg" viewBox="0 0 14 14" fill="none">
                    <path d="M3 7.5 L6 10.2 L11 4.5"
                      stroke="currentColor" strokeWidth="2.2"
                      strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </button>
              <div className="ff-row-body">
                <div className={"ff-row-title " + (t.done ? "ff-todo-strike" : "")}>{t.text}</div>
                {t.focuses.length > 0 && (
                  <div className="ff-todo-chips">
                    {t.focuses.map((f: FocusChip) => (
                      <button
                        key={f.id}
                        onClick={() => handleChipClick(f.id)}
                        className={"ff-todo-chip " + (f.is_primary ? "ff-todo-chip-primary" : "")}
                        title={`Linked focus — ${f.text}`}
                      >
                        {f.text}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── Existing FocusOverlay entry ──
// Wires the same persisted-mode helpers the legacy FocusRow used so the
// distraction overlay survives reloads.
function FocusModePill({ node }: { node: ApiItemNode }) {
  const [open, setOpen] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  // Restore on mount if the saved focus matches this row's id.
  useEffect(() => {
    const saved = loadFocusMode();
    if (saved && saved.focusId === node.id) {
      setStartedAt(saved.startedAt);
      setOpen(true);
    }
  }, [node.id]);

  return (
    <>
      <button
        className="ff-focus-pill"
        onClick={(e) => {
          e.stopPropagation();
          const now = Date.now();
          saveFocusMode({ focusId: node.id, focusName: node.text, startedAt: now });
          setStartedAt(now);
          setOpen(true);
        }}
        title="Enter focus mode"
        aria-label="Enter focus mode"
      >
        <Wind size={11} strokeWidth={2.2} /> focus
      </button>
      {open && startedAt != null && (
        <FocusOverlay
          focusName={node.text}
          startedAt={startedAt}
          onExit={() => { clearFocusMode(); setStartedAt(null); setOpen(false); }}
        />
      )}
    </>
  );
}

// ── Section label ─────────────────────────────────────────────────────────

function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <div className="ff-section-label">
      <span>{label}</span>
      <span className="ff-section-line" />
      <span className="ff-section-count">{count}</span>
    </div>
  );
}

// ── Add focus modal ──────────────────────────────────────────────────────

type CustomDT = { custom: string };
type StartKey = "now" | "tomorrow" | "next-mon" | CustomDT;
type EndKey = "midnight" | "tomorrow-eod" | "week" | "month" | CustomDT;

function AddFocusModal({ seed, tone, onClose, onCreate }: {
  seed: { text: string; endgoal: string | null; scale: FocusScale | null } | null;
  tone: Tone;
  onClose: () => void;
  onCreate: (payload: {
    title: string;
    type: FocusScale;
    status: "committed" | "someday";
    start_at: string | null;
    end_at: string | null;
    health: number | null;
    confidence: number | null;
  }) => void;
}) {
  const [phase, setPhase] = useState(0);
  const [name, setName] = useState(seed?.text ?? "");
  const [type, setType] = useState<FocusScale>(seed?.scale ?? "quick");
  const [start, setStart] = useState<StartKey>("now");
  const [end, setEnd] = useState<EndKey>("midnight");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const t = TONE_COPY[tone];

  useEffect(() => {
    if (phase === 0) inputRef.current?.focus();
  }, [phase]);

  function startISO(k: StartKey): string | null {
    if (typeof k === "object") return localToISO(k.custom);
    if (k === "now") return new Date().toISOString();
    if (k === "tomorrow") {
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
      return d.toISOString();
    }
    if (k === "next-mon") {
      const d = new Date();
      const offset = (8 - d.getDay()) % 7 || 7;
      d.setDate(d.getDate() + offset); d.setHours(9, 0, 0, 0);
      return d.toISOString();
    }
    return null;
  }
  function endISO(k: EndKey): string | null {
    if (typeof k === "object") return localToISO(k.custom);
    if (k === "midnight") {
      const d = new Date(); d.setHours(23, 59, 0, 0); return d.toISOString();
    }
    if (k === "tomorrow-eod") {
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(23, 59, 0, 0);
      return d.toISOString();
    }
    if (k === "week") {
      const d = new Date();
      const offset = (7 - d.getDay()) || 7;
      d.setDate(d.getDate() + offset); d.setHours(23, 59, 0, 0);
      return d.toISOString();
    }
    if (k === "month") {
      const d = new Date(); d.setMonth(d.getMonth() + 1, 0); d.setHours(23, 59, 0, 0);
      return d.toISOString();
    }
    return null;
  }
  function startLabel(k: StartKey): string {
    if (typeof k === "object") return formatLocal(k.custom);
    if (k === "now") return "Now";
    if (k === "tomorrow") return "Tomorrow, 9:00 AM";
    if (k === "next-mon") return "Next Monday";
    return k;
  }
  function endLabel(k: EndKey): string {
    if (typeof k === "object") return formatLocal(k.custom);
    if (k === "midnight") return "Tonight, 11:59 PM";
    if (k === "tomorrow-eod") return "Tomorrow, 11:59 PM";
    if (k === "week") return "End of week";
    if (k === "month") return "End of month";
    return k;
  }

  function submit(decision: boolean) {
    if (!name.trim()) return;
    const status = decision ? "committed" : "someday";
    const isQuick = type === "quick";
    const start_at = isQuick
      ? new Date().toISOString()
      : startISO(start);
    const end_at = isQuick
      ? (() => { const d = new Date(); d.setHours(23, 59, 0, 0); return d.toISOString(); })()
      : endISO(end);
    onCreate({
      title: name.trim(),
      type,
      status,
      start_at,
      end_at,
      health: null,
      confidence: null,
    });
  }

  function handleEnter() {
    if (!name.trim()) return;
    if (type === "quick") submit(true);
    else setPhase(1);
  }

  return (
    <div className="ff-backdrop" onClick={onClose}>
      <div className="ff-modal" onClick={(e) => e.stopPropagation()}>
        <button className="ff-modal-close" onClick={onClose} aria-label="Close">×</button>

        {type === "slow" && (
          <div className="ff-stepper">
            <i className={phase >= 0 ? "on" : ""} />
            <i className={phase >= 1 ? "on" : ""} />
            <i className={phase >= 2 ? "on" : ""} />
          </div>
        )}

        {phase === 0 && (
          <div>
            <div className="ff-eyebrow">
              {type === "quick" ? "Quick focus · just a name" : "Slow burn · 1 of 3"}
            </div>
            <div className="ff-prompt">{t.name}</div>
            <input
              ref={inputRef}
              className="ff-name-input"
              placeholder={t.placeholder}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleEnter(); }}
            />
            <div className="ff-type-pick">
              <button
                className={type === "quick" ? "ff-type-btn ff-type-active" : "ff-type-btn"}
                onClick={() => setType("quick")}
              >
                <span className="ff-type-t">⚡ Quick</span>
                <span className="ff-type-d">One-off. Lives till tonight. Hit ↵ and you're done.</span>
              </button>
              <button
                className={type === "slow" ? "ff-type-btn ff-type-active" : "ff-type-btn"}
                onClick={() => setType("slow")}
              >
                <span className="ff-type-t">◐ Slow burn</span>
                <span className="ff-type-d">Multi-day. Wants commitment + a window.</span>
              </button>
            </div>
            <div className="ff-modal-actions">
              <div className="ff-modal-left">
                {type === "quick" ? "↵ to lock in" : "↵ to continue"}
              </div>
              <div className="ff-modal-right">
                <button className="ff-btn ff-btn-ghost" onClick={onClose}>Cancel</button>
                {type === "quick" ? (
                  <button
                    className="ff-btn ff-btn-primary"
                    disabled={!name.trim()}
                    onClick={() => submit(true)}
                  >Lock it in 🔒</button>
                ) : (
                  <button
                    className="ff-btn ff-btn-primary"
                    disabled={!name.trim()}
                    onClick={() => setPhase(1)}
                  >Continue →</button>
                )}
              </div>
            </div>
          </div>
        )}

        {phase === 1 && type === "slow" && (
          <div>
            <div className="ff-eyebrow">Slow burn · 2 of 3</div>
            <div className="ff-prompt">{t.commit}</div>
            <div className="ff-yesno">
              <button className="ff-yn-yes" onClick={() => setPhase(2)}>
                {t.yes}
                <span className="ff-yn-sub">{t.yesSub}</span>
              </button>
              <button className="ff-yn-no" onClick={() => submit(false)}>
                {t.no}
                <span className="ff-yn-sub">{t.noSub}</span>
              </button>
            </div>
            <div className="ff-modal-actions">
              <div className="ff-modal-left">"{name}"</div>
              <div className="ff-modal-right">
                <button className="ff-btn ff-btn-text" onClick={() => setPhase(0)}>← back</button>
              </div>
            </div>
          </div>
        )}

        {phase === 2 && type === "slow" && (
          <div>
            <div className="ff-eyebrow">Slow burn · 3 of 3</div>
            <div className="ff-prompt">{t.schedule}</div>
            <div className="ff-sched-grid">
              <SchedPicker
                label="Start"
                value={start}
                valueLabel={startLabel(start)}
                presets={[
                  { k: "now", label: "Now" },
                  { k: "tomorrow", label: "Tomorrow 9am" },
                  { k: "next-mon", label: "Next Mon" },
                ]}
                onPick={(k) => setStart(k as StartKey)}
                customDefault={defaultStart}
              />
              <SchedPicker
                label="Finish"
                value={end}
                valueLabel={endLabel(end)}
                presets={[
                  { k: "midnight", label: "Tonight 11:59" },
                  { k: "tomorrow-eod", label: "Tomorrow EOD" },
                  { k: "week", label: "End of week" },
                  { k: "month", label: "End of month" },
                ]}
                onPick={(k) => setEnd(k as EndKey)}
                customDefault={defaultEnd}
              />
            </div>
            <div className="ff-modal-actions">
              <div className="ff-modal-left">Slow burn · {name}</div>
              <div className="ff-modal-right">
                <button className="ff-btn ff-btn-text" onClick={() => setPhase(1)}>← back</button>
                <button className="ff-btn ff-btn-primary" onClick={() => submit(true)}>Lock it in 🔒</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SchedPicker({ label, value, valueLabel, presets, onPick, customDefault }: {
  label: string;
  value: StartKey | EndKey;
  valueLabel: string;
  presets: { k: string; label: string }[];
  onPick: (k: string | CustomDT) => void;
  customDefault: () => string;
}) {
  const isCustom = typeof value === "object";
  return (
    <div className="ff-sched">
      <div className="ff-sched-lab">{label}</div>
      <div className="ff-sched-val">{valueLabel}</div>
      <div className="ff-sched-row">
        {presets.map((p) => (
          <button
            key={p.k}
            className={"ff-chip " + (value === p.k ? "ff-chip-active" : "")}
            onClick={() => onPick(p.k)}
          >{p.label}</button>
        ))}
        <button
          className={"ff-chip " + (isCustom ? "ff-chip-active" : "")}
          onClick={() => onPick({ custom: customDefault() })}
        >Custom…</button>
      </div>
      {isCustom && (
        <input
          type="datetime-local"
          className="ff-custom-dt"
          value={(value as CustomDT).custom}
          onChange={(e) => onPick({ custom: e.target.value })}
        />
      )}
    </div>
  );
}

function formatLocal(local: string): string {
  if (!local) return "—";
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return local;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ── Lock overlay (commit) ─────────────────────────────────────────────────

function LockOverlay({ caption }: { caption: string }) {
  return (
    <div className="ff-lock-overlay">
      <div className="ff-lock-stage">
        <svg className="ff-lock-svg" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path className="ff-lock-shackle"
            d="M40 60 V44 a20 20 0 0 1 40 0 V60"
            stroke="currentColor" strokeWidth="8" strokeLinecap="round" />
          <g className="ff-lock-body">
            <rect x="28" y="58" width="64" height="48" rx="8" fill="currentColor" />
            <circle cx="60" cy="80" r="5" fill="var(--gooni-bg, #FAFAF7)" />
            <rect x="58" y="80" width="4" height="14" rx="2" fill="var(--gooni-bg, #FAFAF7)" />
          </g>
        </svg>
        <div className="ff-lock-caption">{caption}</div>
      </div>
    </div>
  );
}

// ── Completion celebration ────────────────────────────────────────────────

function CompletionCelebration({ kind, title }: { kind: "primary" | "row"; title: string }) {
  if (kind !== "primary") return null;
  return (
    <div className="ff-lock-overlay ff-unlock-overlay">
      <div className="ff-lock-stage">
        <svg className="ff-lock-svg" viewBox="0 0 120 120" fill="none">
          <path className="ff-shackle-open"
            d="M40 60 V44 a20 20 0 0 1 40 0 V52"
            stroke="currentColor" strokeWidth="8" strokeLinecap="round" />
          <g className="ff-lock-body">
            <rect x="28" y="58" width="64" height="48" rx="8" fill="currentColor" />
            <path className="ff-lock-check" d="M44 82 l10 10 l22 -22"
              stroke="var(--gooni-bg, #FAFAF7)" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </g>
        </svg>
        <div className="ff-lock-caption">Done. "{title}"</div>
      </div>
      <div className="ff-confetti">
        {Array.from({ length: 18 }).map((_, i) => (
          <span key={i} style={{
            // i drives angle + color hue.
            ["--i" as string]: i,
            ["--h" as string]: (i * 37) % 360,
          } as React.CSSProperties} />
        ))}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

function FocusFlowStyles() {
  // Inline a `<style>` block once per mount. Keeps the FocusFlow bundle
  // self-contained without dragging a CSS file into the build.
  return (
    <style>{`
      .ff-spotlight {
        position: relative;
        border-radius: 16px;
        background:
          radial-gradient(120% 200% at 0% 0%, rgba(74,222,128,0.12) 0%, transparent 55%),
          radial-gradient(80% 200% at 100% 100%, rgba(74,222,128,0.10) 0%, transparent 55%),
          var(--gooni-card, #FFFFFF);
        border: 0.5px solid rgba(0,0,0,0.10);
        padding: 18px 20px 16px;
        overflow: hidden;
        margin-bottom: 14px;
      }
      .ff-spotlight::before {
        content: "";
        position: absolute; inset: 0;
        background: radial-gradient(60% 60% at 50% 0%, rgba(74,222,128,0.18) 0%, transparent 70%);
        opacity: 0.55;
        pointer-events: none;
        animation: ff-ambient 9s ease-in-out infinite alternate;
      }
      @keyframes ff-ambient {
        0% { transform: translate3d(-6%, -4%, 0) scale(1); opacity: 0.4; }
        100% { transform: translate3d(6%, 4%, 0) scale(1.05); opacity: 0.7; }
      }
      .ff-spotlight-empty { background: var(--gooni-card, #FFFFFF); }
      .ff-spotlight-empty::before { display: none; }
      .ff-spot-row { position: relative; display: flex; align-items: center; gap: 8px; }
      .ff-spot-lab {
        position: relative;
        font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
        color: var(--gooni-muted, #6E6E68);
        display: flex; align-items: center; gap: 8px;
      }
      .ff-pulse {
        width: 8px; height: 8px; border-radius: 50%;
        background: #4ade80;
        animation: ff-pulse 2.4s ease-out infinite;
      }
      @keyframes ff-pulse {
        0%   { box-shadow: 0 0 0 0 rgba(74,222,128,0.7); }
        70%  { box-shadow: 0 0 0 12px rgba(74,222,128,0); }
        100% { box-shadow: 0 0 0 0   rgba(74,222,128,0); }
      }
      /* Gold crown — same hue as the row-level crown (.ff-crown-active) so
         the spotlight + the row indicator read as the same signal. Muted
         variant for the empty state where no primary is set. */
      .ff-spot-crown { color: #EAB308; }
      .ff-spot-crown-empty { color: var(--gooni-muted, #C7C7CC); }
      .ff-spot-title {
        position: relative;
        font-weight: 600;
        font-size: 17px;
        letter-spacing: -0.01em;
        line-height: 1.3;
        margin: 6px 0 6px;
        color: var(--gooni-text, #1C1C1E);
      }
      .ff-spot-title-empty {
        position: relative;
        font-size: 16px; font-style: italic; color: var(--gooni-muted, #8E8E93);
        margin: 6px 0 6px;
      }
      .ff-spot-meta {
        position: relative;
        color: var(--gooni-muted, #6E6E68);
        display: flex; gap: 14px; align-items: center; flex-wrap: wrap;
        font-size: 12px;
      }
      .ff-spot-health { display: inline-flex; align-items: center; gap: 6px; }
      .ff-spot-health strong { color: var(--gooni-text, #1C1C1E); font-weight: 600; }
      .ff-health-bar {
        position: relative; height: 4px; width: 160px;
        background: var(--gooni-border, rgba(0,0,0,0.10));
        border-radius: 999px; overflow: hidden;
      }
      .ff-health-bar > span { position: absolute; inset: 0; border-radius: inherit; }
      .ff-spot-conf { font-size: 11px; color: var(--gooni-muted, #6E6E68); }
      .ff-spot-btn {
        font-size: 12px; color: var(--gooni-muted, #6E6E68);
        border: 0.5px solid var(--gooni-border, rgba(0,0,0,0.10));
        background: var(--gooni-card, #FFFFFF);
        padding: 5px 10px; border-radius: 999px; cursor: pointer;
        font-family: inherit;
      }
      .ff-spot-btn:hover { background: rgba(0,0,0,0.04); }

      .ff-toolbar {
        display: flex; align-items: center; gap: 10px;
        margin: 6px 0 10px;
      }
      .ff-toolbar-label {
        font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
        color: var(--gooni-muted, #8E8E93); font-weight: 600;
      }
      .ff-toolbar-count { color: var(--gooni-muted, #8E8E93); font-size: 12px; }
      .ff-ghost {
        background: none; border: none; padding: 6px 8px;
        color: var(--gooni-muted, #6E6E68); font-size: 12px;
        cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
        font-family: inherit;
      }
      .ff-ghost:hover { color: var(--gooni-text, #1C1C1E); }
      /* Toolbar "add focus" — restyled from the heavy black pill into a
         lightweight ghost link to match the existing dashboard rhythm. */
      .ff-add-link {
        background: none; border: none;
        padding: 6px 8px;
        color: var(--gooni-text, #1C1C1E);
        font-size: 12px; font-weight: 600;
        cursor: pointer; font-family: inherit;
        border-radius: 6px;
      }
      .ff-add-link:hover {
        background: rgba(0,0,0,0.05);
      }

      .ff-section-label {
        display: flex; align-items: center; gap: 8px;
        padding: 14px 4px 6px;
        font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
        color: var(--gooni-muted, #8E8E93); font-weight: 600;
      }
      .ff-section-line { flex: 1; height: 1px; background: var(--gooni-border, rgba(0,0,0,0.06)); }
      .ff-section-count { color: var(--gooni-muted, #8E8E93); font-size: 11px; }

      .ff-empty {
        color: var(--gooni-muted, #8E8E93);
        font-size: 13px; padding: 10px 16px;
      }

      .ff-row {
        position: relative;
        display: grid;
        grid-template-columns: 14px 1fr auto;
        align-items: center; gap: 12px;
        padding: 10px 14px 10px 18px;
        border-radius: 10px;
        background: var(--gooni-card, #FFFFFF);
        border: 0.5px solid transparent;
        transition: border-color 0.15s ease, transform 0.15s ease,
                    background 0.15s ease, opacity 0.15s ease;
      }
      .ff-row + .ff-row { margin-top: 2px; }
      .ff-row:hover { border-color: var(--gooni-border, rgba(0,0,0,0.10)); }
      .ff-row-primary { border-color: rgba(74,222,128,0.45); }
      .ff-row-someday { opacity: 0.55; }
      .ff-row-dragging { opacity: 0.4; }
      .ff-row-done-static { opacity: 0.55; }

      /* Today-todo row variant — same shell as a focus row but no health
         glyph, no drag, no crown. Chips below the title show linked focuses. */
      .ff-todo-row { cursor: default; }
      .ff-todo-strike { text-decoration: line-through; color: var(--gooni-muted, #8E8E93); }
      .ff-todo-checkmark { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 4px; border: 1px solid var(--gooni-border, rgba(0,0,0,0.20)); }
      .ff-check-checked .ff-todo-checkmark { background: #16A34A; color: #fff; border-color: #16A34A; }
      .ff-todo-chips {
        display: flex; flex-wrap: wrap; gap: 4px;
        margin-top: 4px;
      }
      .ff-todo-chip {
        background: rgba(74,222,128,0.10);
        color: #16803C;
        border: 0.5px solid rgba(22,128,60,0.25);
        border-radius: 999px;
        font-size: 11px; line-height: 1.4;
        padding: 1px 8px;
        cursor: pointer;
        font-family: inherit;
        max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        transition: background 0.12s, border-color 0.12s;
      }
      .ff-todo-chip:hover {
        background: rgba(74,222,128,0.18);
        border-color: rgba(22,128,60,0.45);
      }
      .ff-todo-chip-primary {
        background: rgba(234,179,8,0.14);
        color: #92400E;
        border-color: rgba(234,179,8,0.35);
      }
      .ff-todo-chip-primary:hover {
        background: rgba(234,179,8,0.22);
        border-color: rgba(234,179,8,0.55);
      }
      .ff-row-body { min-width: 0; }
      .ff-row-title {
        font-weight: 500; letter-spacing: -0.005em;
        color: var(--gooni-text, #1C1C1E);
        font-size: 14px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .ff-row-meta {
        color: var(--gooni-muted, #8E8E93);
        font-size: 12px;
      }
      .ff-row-actions {
        display: flex; gap: 4px; align-items: center;
        opacity: 0; transition: opacity 0.15s;
      }
      .ff-row:hover .ff-row-actions,
      .ff-row-primary .ff-row-actions { opacity: 1; }

      .ff-icon-btn {
        background: none; border: none; cursor: pointer;
        color: var(--gooni-muted, #8E8E93);
        font-size: 13px; padding: 2px 6px; border-radius: 6px;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .ff-icon-btn:hover {
        background: rgba(0,0,0,0.05);
        color: var(--gooni-text, #1C1C1E);
      }
      /* Crown toggles primary. Outlined when not primary, filled gold-yellow
         when primary — reads as "the one ruling all the others." Always
         visible on the primary row (parent shows actions even without hover). */
      .ff-crown-btn {
        background: none; border: none; cursor: pointer;
        color: var(--gooni-muted, #8E8E93);
        padding: 2px 6px; border-radius: 6px;
        display: inline-flex; align-items: center; justify-content: center;
        transition: color 0.12s ease, background 0.12s ease;
      }
      .ff-crown-btn:hover { background: rgba(0,0,0,0.05); }
      .ff-crown-active { color: #EAB308; }
      .ff-crown-active:hover { color: #EAB308; }

      /* Drop-position indicator — a single thin line at the row's edge,
         not a separate spacer. Cleaner than the standalone "DropSlot"
         approach since the layout doesn't shift while dragging. */
      .ff-drop-line {
        position: absolute; left: 6px; right: 6px; height: 2px;
        background: #4ade80; border-radius: 1px;
        pointer-events: none;
      }
      .ff-drop-line-top    { top: -1px; }
      .ff-drop-line-bottom { bottom: -1px; }

      .ff-focus-pill {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 3px 9px; border-radius: 999px;
        background: rgba(74,222,128,0.14);
        border: 0.5px solid rgba(74,222,128,0.45);
        color: #15803D;
        font-size: 11px; font-weight: 600; cursor: pointer;
        font-family: inherit; flex-shrink: 0;
      }
      .ff-focus-pill:hover { background: rgba(74,222,128,0.22); }

      .ff-dot {
        width: 10px; height: 10px; border-radius: 50%;
        display: inline-block;
      }

      /* Health pip + check button — single button. Default = colored
         dot or gray "?" glyph. On row hover the dot scales out and a
         green stroke draws a checkmark over it. No big black blob. */
      .ff-check-dot {
        appearance: none; background: none; border: none; padding: 0;
        width: 16px; height: 16px; border-radius: 50%;
        display: inline-flex; align-items: center; justify-content: center;
        position: relative; cursor: pointer;
        transition: background 0.18s ease;
      }
      .ff-check-dot .ff-dot,
      .ff-check-dot .ff-health-unknown {
        transition: transform 0.18s ease, opacity 0.18s ease;
      }
      .ff-check-svg {
        position: absolute; inset: 0; width: 100%; height: 100%;
        color: #15803D;
        opacity: 0;
        transform: scale(0.6);
        transition: opacity 0.18s ease, transform 0.18s ease;
        pointer-events: none;
      }
      .ff-row:hover .ff-check-dot {
        background: rgba(74,222,128,0.18);
        outline: 1.5px solid rgba(74,222,128,0.55);
      }
      .ff-row:hover .ff-check-dot .ff-dot,
      .ff-row:hover .ff-check-dot .ff-health-unknown {
        transform: scale(0.4);
        opacity: 0;
      }
      .ff-row:hover .ff-check-svg {
        opacity: 1; transform: scale(1);
      }
      .ff-check-dot.ff-check-checked {
        background: rgba(74,222,128,0.30);
        outline: 1.5px solid rgba(74,222,128,0.70);
      }
      .ff-check-dot.ff-check-checked .ff-dot,
      .ff-check-dot.ff-check-checked .ff-health-unknown { opacity: 0; }
      .ff-check-dot.ff-check-checked .ff-check-svg { opacity: 1; transform: scale(1); }

      .ff-row-new { animation: ff-row-enter 0.5s ease both; }
      @keyframes ff-row-enter {
        0% { opacity: 0; transform: translateY(-6px); }
        100% { opacity: 1; transform: translateY(0); }
      }
      .ff-row-done .ff-row-title {
        text-decoration: line-through;
        color: var(--gooni-muted, #8E8E93);
        transition: color 0.3s ease;
      }
      .ff-row-done { animation: ff-row-done 0.7s ease forwards; }
      @keyframes ff-row-done {
        0% { opacity: 1; transform: translateX(0) scale(1); }
        100% {
          opacity: 0; transform: translateX(8px) scale(0.98);
          max-height: 0; padding-top: 0; padding-bottom: 0; margin-top: 0;
        }
      }

      /* "Health unknown" question-mark glyph — same footprint as the
         colored dot so layout doesn't jump as scores roll in. */
      .ff-health-unknown {
        width: 16px; height: 16px; border-radius: 50%;
        display: inline-flex; align-items: center; justify-content: center;
        color: var(--gooni-muted, #8E8E93);
        background: rgba(0,0,0,0.05);
      }

      /* Undo toast — bottom-center, dark pill. Owner-only. */
      .ff-undo-toast {
        position: fixed;
        bottom: 24px; left: 50%; transform: translateX(-50%);
        display: flex; align-items: center; gap: 14px;
        background: #1C1C1E; color: #FFF;
        padding: 10px 14px 10px 16px;
        border-radius: 999px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.25);
        font-size: 13.5px;
        z-index: 1300;
      }
      .ff-undo-btn {
        background: transparent;
        border: 1px solid rgba(255,255,255,0.30);
        color: #FFF;
        border-radius: 999px;
        padding: 4px 12px;
        font-size: 12px; font-weight: 600;
        cursor: pointer; font-family: inherit;
      }
      .ff-undo-btn:hover { background: rgba(255,255,255,0.08); }

      .ff-backdrop {
        position: fixed; inset: 0;
        background: rgba(28,28,30,0.22);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        display: flex; align-items: center; justify-content: center;
        z-index: 1100;
        animation: ff-fade 0.2s ease both;
      }
      @keyframes ff-fade { from { opacity: 0; } to { opacity: 1; } }

      .ff-modal {
        width: min(560px, calc(100vw - 32px));
        background: var(--gooni-card, #FFFFFF);
        border: 0.5px solid var(--gooni-border, rgba(0,0,0,0.10));
        border-radius: 18px;
        padding: 26px 26px 22px;
        box-shadow: 0 24px 60px -20px rgba(0,0,0,0.30);
        position: relative;
        font-family: inherit;
      }
      .ff-modal-close {
        position: absolute; right: 14px; top: 12px;
        background: none; border: none;
        color: var(--gooni-muted, #8E8E93);
        font-size: 18px; cursor: pointer;
      }
      .ff-stepper { display: flex; gap: 6px; margin-bottom: 14px; }
      .ff-stepper i {
        display: block; width: 24px; height: 4px; border-radius: 2px;
        background: var(--gooni-border, rgba(0,0,0,0.10));
      }
      .ff-stepper i.on { background: #1C1C1E; }
      .ff-eyebrow {
        font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase;
        color: var(--gooni-muted, #8E8E93); margin-bottom: 6px;
      }
      .ff-prompt {
        font-weight: 600; font-size: 24px; letter-spacing: -0.02em;
        line-height: 1.2; margin-bottom: 16px;
        color: var(--gooni-text, #1C1C1E);
      }
      .ff-name-input {
        width: 100%; background: transparent; border: none;
        border-bottom: 2px solid var(--gooni-border, rgba(0,0,0,0.10));
        padding: 12px 2px;
        font-family: inherit;
        font-size: 22px; letter-spacing: -0.01em;
        color: var(--gooni-text, #1C1C1E);
        outline: none; transition: border-color 0.2s ease;
      }
      .ff-name-input:focus { border-bottom-color: #1C1C1E; }

      .ff-type-pick { display: flex; gap: 8px; margin-top: 18px; }
      .ff-type-btn {
        flex: 1; min-width: 0; padding: 12px 14px;
        border-radius: 10px;
        border: 0.5px solid var(--gooni-border, rgba(0,0,0,0.10));
        background: var(--gooni-card, #FFFFFF);
        display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
        text-align: left; cursor: pointer; font-family: inherit;
      }
      .ff-type-active {
        border-color: #1C1C1E;
        background: rgba(0,0,0,0.04);
      }
      .ff-type-t { font-weight: 600; font-size: 13px; white-space: nowrap; }
      .ff-type-d { font-size: 11px; color: var(--gooni-muted, #8E8E93); }

      .ff-modal-actions {
        display: flex; justify-content: space-between; align-items: center;
        gap: 10px; margin-top: 22px;
      }
      .ff-modal-left {
        color: var(--gooni-muted, #8E8E93); font-size: 12px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ff-modal-right { display: flex; gap: 8px; flex-shrink: 0; }

      .ff-btn {
        padding: 10px 18px; border-radius: 999px;
        font-weight: 500; cursor: pointer; font-family: inherit;
        white-space: nowrap;
      }
      .ff-btn-primary {
        background: #1C1C1E; color: #FFF; border: none;
      }
      .ff-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
      .ff-btn-ghost {
        background: none;
        border: 0.5px solid var(--gooni-border, rgba(0,0,0,0.10));
        color: var(--gooni-text, #1C1C1E);
      }
      .ff-btn-text {
        background: none; border: none;
        color: var(--gooni-muted, #8E8E93);
        padding: 10px 6px;
      }

      .ff-yesno {
        display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
        margin: 14px 0 6px;
      }
      .ff-yesno button {
        border-radius: 18px; padding: 38px 18px;
        font-weight: 600; font-size: 38px; letter-spacing: -0.02em;
        border: 0.5px solid var(--gooni-border, rgba(0,0,0,0.10));
        background: var(--gooni-card, #FFFFFF);
        transition: transform 0.15s ease, background 0.15s, color 0.15s, border-color 0.15s;
        color: var(--gooni-text, #1C1C1E); line-height: 1;
        cursor: pointer; font-family: inherit;
      }
      .ff-yn-sub {
        display: block; font-size: 11px; letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--gooni-muted, #8E8E93); margin-top: 8px;
        font-weight: 500;
      }
      .ff-yn-yes:hover {
        background: #1C1C1E; color: #FFF;
        transform: translateY(-2px);
      }
      .ff-yn-yes:hover .ff-yn-sub { color: rgba(255,255,255,0.65); }
      .ff-yn-no:hover {
        background: rgba(0,0,0,0.04);
        transform: translateY(-2px);
      }

      .ff-sched-grid {
        display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
        margin-top: 14px;
      }
      .ff-sched {
        border: 0.5px solid var(--gooni-border, rgba(0,0,0,0.10));
        border-radius: 12px; padding: 12px 14px;
      }
      .ff-sched-lab {
        font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
        color: var(--gooni-muted, #8E8E93);
      }
      .ff-sched-val {
        font-weight: 600; font-size: 18px; letter-spacing: -0.01em;
        margin-top: 4px;
        color: var(--gooni-text, #1C1C1E);
      }
      .ff-sched-row {
        display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap;
      }
      .ff-chip {
        font-size: 11px; padding: 4px 8px; border-radius: 999px;
        border: 0.5px solid var(--gooni-border, rgba(0,0,0,0.10));
        background: var(--gooni-card, #FFFFFF);
        color: var(--gooni-text, #1C1C1E);
        cursor: pointer; font-family: inherit;
      }
      .ff-chip-active {
        background: #1C1C1E; color: #FFF; border-color: #1C1C1E;
      }
      .ff-custom-dt {
        margin-top: 8px; width: 100%;
        background: var(--gooni-card, #FFFFFF);
        border: 0.5px solid var(--gooni-border, rgba(0,0,0,0.10));
        padding: 8px 10px; border-radius: 8px;
        font: inherit; color: var(--gooni-text, #1C1C1E);
        outline: none;
      }
      .ff-custom-dt:focus { border-color: #1C1C1E; }

      .ff-lock-overlay {
        position: fixed; inset: 0; z-index: 1200;
        display: flex; align-items: center; justify-content: center;
        background: rgba(250,250,247,0.80);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        pointer-events: none;
        animation: ff-fade 0.25s ease both;
      }
      .ff-lock-stage {
        display: flex; flex-direction: column; align-items: center;
        gap: 14px;
      }
      .ff-lock-svg { width: 120px; height: 120px; color: var(--gooni-text, #1C1C1E); }
      .ff-lock-shackle {
        transform-origin: 60px 56px;
        animation: ff-shackle-shut 1.0s cubic-bezier(.6,.05,.2,1) forwards;
      }
      @keyframes ff-shackle-shut {
        0%   { transform: translateY(-14px); }
        55%  { transform: translateY(0); }
        65%  { transform: translateY(-2px); }
        78%  { transform: translateY(0); }
        100% { transform: translateY(0); }
      }
      .ff-lock-body {
        animation: ff-lock-shake 0.5s ease 0.55s both;
        transform-origin: 60px 80px;
      }
      @keyframes ff-lock-shake {
        0%, 100% { transform: translateX(0) rotate(0); }
        25% { transform: translateX(-3px) rotate(-2deg); }
        50% { transform: translateX(3px) rotate(2deg); }
        75% { transform: translateX(-2px) rotate(-1deg); }
      }
      .ff-lock-caption {
        font-weight: 600; font-size: 18px; letter-spacing: -0.01em;
        color: var(--gooni-text, #1C1C1E);
        opacity: 0; animation: ff-lock-cap 0.4s ease 0.85s forwards;
      }
      @keyframes ff-lock-cap { to { opacity: 1; transform: translateY(-2px); } }

      .ff-unlock-overlay { background: rgba(250,250,247,0.88); }
      .ff-shackle-open {
        transform-origin: 60px 56px;
        animation: ff-shackle-open 1.0s cubic-bezier(.6,.05,.2,1) forwards;
      }
      @keyframes ff-shackle-open {
        0%   { transform: translateY(0) rotate(0); }
        35%  { transform: translateY(0) rotate(-6deg); }
        100% { transform: translateY(-8px) rotate(-22deg); }
      }
      .ff-lock-check {
        stroke-dasharray: 48; stroke-dashoffset: 48;
        animation: ff-check-draw 0.5s ease 0.5s forwards;
      }
      @keyframes ff-check-draw { to { stroke-dashoffset: 0; } }

      .ff-confetti {
        position: absolute; inset: 0; pointer-events: none;
        overflow: hidden;
      }
      .ff-confetti span {
        position: absolute; left: 50%; top: 50%;
        width: 6px; height: 10px; border-radius: 1px;
        background: oklch(0.72 0.18 var(--h));
        transform: translate(-50%, -50%) rotate(0deg);
        animation: ff-confetti-fly 1.6s cubic-bezier(.2,.7,.2,1) forwards;
        animation-delay: calc(var(--i) * 18ms);
        opacity: 0;
      }
      @keyframes ff-confetti-fly {
        0%  { opacity: 0; transform: translate(-50%, -50%) rotate(0); }
        10% { opacity: 1; }
        100% {
          opacity: 0;
          transform:
            translate(calc(-50% + (cos(var(--i) * 20deg) * 280px)),
                      calc(-50% + (sin(var(--i) * 20deg) * 220px) + 200px))
            rotate(720deg);
        }
      }
    `}</style>
  );
}
