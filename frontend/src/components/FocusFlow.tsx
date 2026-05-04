import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Wind, Plus, Star } from "lucide-react";
import {
  fetchItemTree, createItem, updateItem, deleteItem, reorderItems, suggestFocus,
  type ApiItemTree, type ApiItemNode, type FocusScale,
} from "../services/api";
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

// ── Component ──────────────────────────────────────────────────────────────

export function FocusFlow() {
  const queryClient = useQueryClient();
  const { data: tree, isLoading } = useQuery<ApiItemTree>({
    queryKey: ["item-tree"],
    queryFn: fetchItemTree,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["item-tree"] });

  const focuses = (tree?.focuses ?? []).filter((f) => !f.done);
  const primary = focuses.find((f) => f.is_primary);
  const active = focuses.filter((f) => f.status !== "someday");
  const someday = focuses.filter((f) => f.status === "someday");
  const quick = active.filter((f) => (f.scale ?? "slow") === "quick")
    .sort((a, b) => a.sort_order - b.sort_order);
  const slow = active.filter((f) => (f.scale ?? "slow") === "slow")
    .sort((a, b) => a.sort_order - b.sort_order);

  const [showModal, setShowModal] = useState(false);
  const [seed, setSeed] = useState<{ text: string; endgoal: string | null; scale: FocusScale | null } | null>(null);
  const [lockShown, setLockShown] = useState<{ caption: string } | null>(null);
  const [celebration, setCelebration] = useState<{ kind: "primary" | "row"; title: string } | null>(null);
  const [newId, setNewId] = useState<number | null>(null);

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

  async function handleSetPrimary(id: number) {
    try {
      await updateItem(id, { is_primary: true });
      refresh();
    } catch (e) { console.error(e); }
  }
  async function handleClearPrimary(id: number) {
    try {
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
  async function handleComplete(node: ApiItemNode) {
    setCelebration({
      kind: node.is_primary ? "primary" : "row",
      title: node.text,
    });
    try {
      await updateItem(node.id, { done: true, is_primary: false });
      refresh();
    } catch (e) { console.error(e); }
    setTimeout(() => setCelebration(null), node.is_primary ? 2200 : 1300);
  }

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
        <button className="ff-add" onClick={() => { setSeed(null); setShowModal(true); }}>
          <span className="ff-plus"><Plus size={12} strokeWidth={2.4} /></span>
          Add focus
        </button>
      </div>

      {isLoading && !tree ? (
        <div className="ff-empty">Loading…</div>
      ) : (
        <>
          <SectionLabel label="Quick · today" count={quick.length} />
          {quick.length === 0 ? (
            <div className="ff-empty">Nothing quick on the docket.</div>
          ) : (
            <ReorderableList
              items={quick}
              onChange={refresh}
              renderRow={(f) => (
                <FocusFlowRow
                  key={f.id}
                  node={f}
                  onSetPrimary={handleSetPrimary}
                  onRemove={handleRemove}
                  onComplete={handleComplete}
                  isNew={f.id === newId}
                />
              )}
            />
          )}

          <SectionLabel label="Slow burn" count={slow.length} />
          {slow.length === 0 ? (
            <div className="ff-empty">No slow-burn focuses yet.</div>
          ) : (
            <ReorderableList
              items={slow}
              onChange={refresh}
              renderRow={(f) => (
                <FocusFlowRow
                  key={f.id}
                  node={f}
                  onSetPrimary={handleSetPrimary}
                  onRemove={handleRemove}
                  onComplete={handleComplete}
                  isNew={f.id === newId}
                />
              )}
            />
          )}

          {someday.length > 0 && (
            <>
              <SectionLabel label="Someday" count={someday.length} />
              {someday.map((f) => (
                <FocusFlowRow
                  key={f.id}
                  node={f}
                  onSetPrimary={handleSetPrimary}
                  onRemove={handleRemove}
                  onComplete={handleComplete}
                  isNew={f.id === newId}
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
    </div>
  );
}

// ── Spotlight ──────────────────────────────────────────────────────────────

function Spotlight({ f, onClearPrimary, onComplete }: {
  f: ApiItemNode | undefined;
  onClearPrimary: (id: number) => void;
  onComplete: (n: ApiItemNode) => void;
}) {
  if (!f) {
    return (
      <div className="ff-spotlight ff-spotlight-empty">
        <div className="ff-spot-lab"><span className="ff-pulse" /> Primary focus</div>
        <div className="ff-spot-title-empty">No primary set.</div>
        <div className="ff-spot-meta">Pick a focus from the list and ★ it.</div>
      </div>
    );
  }
  const color = healthColor(f.health, f.confidence);
  return (
    <div className="ff-spotlight">
      <div className="ff-spot-row">
        <div className="ff-spot-lab"><span className="ff-pulse" /> Primary focus</div>
        <span style={{ flex: 1 }} />
        <FocusModePill node={f} />
        <button className="ff-spot-btn" onClick={() => onComplete(f)}>✓ Mark done</button>
        <button className="ff-spot-btn" onClick={() => onClearPrimary(f.id)}>Clear primary</button>
      </div>
      <div className="ff-spot-title">{f.text}</div>
      <div className="ff-spot-meta">
        <span className="ff-spot-health">
          <span className="ff-dot" style={{ background: color ?? "var(--gooni-border, rgba(0,0,0,0.12))" }} />
          Health <strong>{color ? f.health : "—"}</strong>/100
        </span>
        {color && (
          <span className="ff-health-bar">
            <span style={{ width: `${f.health}%`, background: color }} />
          </span>
        )}
        {f.confidence != null && <span className="ff-spot-conf">conf {f.confidence}%</span>}
        {(f.start_at || f.end_at) && <span className="ff-spot-conf">· {fmtWindow(f.start_at, f.end_at)}</span>}
      </div>
    </div>
  );
}

// ── Row ────────────────────────────────────────────────────────────────────

function FocusFlowRow({ node, onSetPrimary, onRemove, onComplete, isNew, draggable, onDragStart, onDragEnd }: {
  node: ApiItemNode;
  onSetPrimary: (id: number) => void;
  onRemove: (id: number) => void;
  onComplete: (n: ApiItemNode) => void;
  isNew?: boolean;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [doneAnim, setDoneAnim] = useState(false);
  const color = healthColor(node.health, node.confidence);
  const isQuick = (node.scale ?? "slow") === "quick";
  const someday = node.status === "someday";

  function handleCheck(e: React.MouseEvent) {
    e.stopPropagation();
    setDoneAnim(true);
    // Wait the animation duration before firing the actual mutation; gives
    // the row time to slide out instead of vanishing instantly.
    setTimeout(() => onComplete(node), 700);
  }

  const cls = [
    "ff-row",
    node.is_primary ? "ff-row-primary" : "",
    someday ? "ff-row-someday" : "",
    isNew ? "ff-row-new" : "",
    doneAnim ? "ff-row-done" : "",
  ].join(" ").trim();

  return (
    <div
      className={cls}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        className={"ff-check-dot " + (doneAnim ? "ff-check-checked" : "")}
        onClick={handleCheck}
        title="Mark done"
        aria-label="Mark done"
      >
        <span className="ff-dot" style={{ background: color ?? "var(--gooni-border, rgba(0,0,0,0.18))" }} />
        <span className="ff-check-glyph">✓</span>
      </button>
      <div className="ff-row-body">
        <div className="ff-row-title">{node.text}</div>
        <div className="ff-row-meta">
          {fmtWindow(node.start_at, node.end_at) || (isQuick ? "Today" : "")}
          {node.confidence != null && node.confidence < 35 && <span> · health unclear</span>}
        </div>
      </div>
      <span className={"ff-pill " + (isQuick ? "ff-pill-quick" : "ff-pill-slow")}>
        {isQuick ? "Quick" : "Slow burn"}
      </span>
      <span className="ff-row-health">{color ? node.health : "—"}</span>
      <div className="ff-row-actions">
        {!someday && <FocusModePill node={node} />}
        {!node.is_primary && (
          <button
            className="ff-icon-btn"
            onClick={() => onSetPrimary(node.id)}
            title="Make primary"
            aria-label="Make primary"
          ><Star size={12} strokeWidth={2} /></button>
        )}
        <button
          className="ff-icon-btn"
          onClick={() => onRemove(node.id)}
          title="Remove (no celebration)"
          aria-label="Remove"
        >×</button>
      </div>
      {hover && !doneAnim && <HydrationTimeline />}
    </div>
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

// ── Hydration timeline (empty until the auto-hydration pipeline ships) ────

function HydrationTimeline() {
  return (
    <div className="ff-timeline" onClick={(e) => e.stopPropagation()}>
      <div className="ff-timeline-h">Hydration</div>
      <div className="ff-timeline-empty">
        Dry. No activity yet — mention this focus in chat, WhatsApp,
        Telegram, or Claude Code to hydrate.
      </div>
    </div>
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

// ── Reorder ───────────────────────────────────────────────────────────────

function ReorderableList({ items, onChange, renderRow }: {
  items: ApiItemNode[];
  onChange: () => void;
  renderRow: (item: ApiItemNode) => React.ReactNode;
}) {
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  async function commit(targetIdx: number) {
    if (draggingId == null) return;
    const fromIdx = items.findIndex((i) => i.id === draggingId);
    if (fromIdx === -1 || fromIdx === targetIdx || fromIdx + 1 === targetIdx) return;
    const next = items.slice();
    const [moved] = next.splice(fromIdx, 1);
    const insertAt = targetIdx > fromIdx ? targetIdx - 1 : targetIdx;
    next.splice(insertAt, 0, moved);
    try {
      await reorderItems(next.map((n) => n.id));
      onChange();
    } catch (e) { console.error(e); }
  }

  return (
    <div>
      {draggingId != null && (
        <DropSlot active={hoverIdx === 0} onEnter={() => setHoverIdx(0)} onDrop={() => { commit(0); setHoverIdx(null); }} />
      )}
      {items.map((f, i) => (
        <div
          key={f.id}
          onDragOver={(e) => e.preventDefault()}
        >
          <div
            draggable
            onDragStart={(e) => { setDraggingId(f.id); e.dataTransfer.effectAllowed = "move"; }}
            onDragEnd={() => { setDraggingId(null); setHoverIdx(null); }}
          >
            {renderRow(f)}
          </div>
          {draggingId != null && (
            <DropSlot
              active={draggingId !== f.id && hoverIdx === i + 1}
              onEnter={() => setHoverIdx(i + 1)}
              onDrop={() => { commit(i + 1); setHoverIdx(null); }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function DropSlot({ active, onEnter, onDrop }: {
  active: boolean; onEnter: () => void; onDrop: () => void;
}) {
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; onEnter(); }}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
      style={{ position: "relative", height: 8 }}
    >
      <div style={{
        position: "absolute", left: 4, right: 4, top: 3, height: 2,
        borderRadius: 1,
        background: active ? "#3B82F6" : "transparent",
        transition: "background 100ms",
      }} />
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
      .ff-spot-title {
        position: relative;
        font-weight: 600;
        font-size: 26px;
        letter-spacing: -0.02em;
        line-height: 1.15;
        margin: 8px 0 6px;
        color: var(--gooni-text, #1C1C1E);
      }
      .ff-spot-title-empty {
        position: relative;
        font-size: 22px; font-style: italic; color: var(--gooni-muted, #8E8E93);
        margin: 8px 0 6px;
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
      .ff-add {
        background: #1C1C1E; color: #FFF; border: none;
        border-radius: 999px;
        padding: 9px 16px 9px 12px;
        display: inline-flex; align-items: center; gap: 8px;
        font-weight: 500; font-size: 13px;
        cursor: pointer;
        box-shadow: 0 1px 0 rgba(0,0,0,0.06), 0 8px 24px -10px rgba(0,0,0,0.35);
        transition: transform 0.12s ease;
        font-family: inherit;
      }
      .ff-add:hover { transform: translateY(-1px); }
      .ff-plus {
        width: 20px; height: 20px; border-radius: 50%;
        background: rgba(255,255,255,0.14);
        display: inline-flex; align-items: center; justify-content: center;
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
        grid-template-columns: 14px 1fr auto auto auto;
        align-items: center; gap: 12px;
        padding: 12px 14px 12px 18px;
        border-radius: 10px;
        background: var(--gooni-card, #FFFFFF);
        border: 0.5px solid transparent;
        transition: border-color 0.15s ease, transform 0.15s ease, background 0.15s ease;
      }
      .ff-row + .ff-row { margin-top: 4px; }
      .ff-row:hover { border-color: var(--gooni-border, rgba(0,0,0,0.10)); }
      .ff-row-primary { border-color: rgba(74,222,128,0.45); }
      .ff-row-someday { opacity: 0.55; }
      .ff-row-body { min-width: 0; }
      .ff-row-title {
        font-weight: 500; letter-spacing: -0.005em;
        color: var(--gooni-text, #1C1C1E);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .ff-row-meta {
        color: var(--gooni-muted, #8E8E93);
        font-size: 12px;
      }
      .ff-row-health {
        font-size: 12px; color: var(--gooni-muted, #8E8E93);
        font-variant-numeric: tabular-nums;
        min-width: 28px; text-align: right;
      }
      .ff-row-actions {
        display: flex; gap: 6px; align-items: center;
        opacity: 0; transition: opacity 0.15s;
      }
      .ff-row:hover .ff-row-actions { opacity: 1; }

      .ff-pill {
        font-size: 11px; padding: 3px 8px; border-radius: 999px;
        border: 0.5px solid var(--gooni-border, rgba(0,0,0,0.10));
        color: var(--gooni-muted, #6E6E68);
        background: var(--gooni-card, #FFFFFF);
        white-space: nowrap;
      }
      .ff-pill-quick {
        background: rgba(0,0,0,0.04);
        color: var(--gooni-text, #1C1C1E);
      }
      .ff-pill-slow {
        background: rgba(74,222,128,0.10);
        color: var(--gooni-text, #1C1C1E);
        border-color: rgba(74,222,128,0.30);
      }

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

      .ff-check-dot {
        appearance: none; background: none; border: none; padding: 0;
        width: 18px; height: 18px; border-radius: 50%;
        display: inline-flex; align-items: center; justify-content: center;
        position: relative; cursor: pointer;
      }
      .ff-check-dot .ff-check-glyph {
        position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center;
        font-size: 11px; color: #FFF; font-weight: 700;
        opacity: 0; transition: opacity 0.12s ease; z-index: 1;
      }
      .ff-row:hover .ff-check-dot::before {
        content: ""; position: absolute; inset: -2px; border-radius: 50%;
        background: #1C1C1E; opacity: 0.92;
      }
      .ff-row:hover .ff-check-dot .ff-dot { opacity: 0; }
      .ff-row:hover .ff-check-dot .ff-check-glyph { opacity: 1; }
      .ff-check-dot.ff-check-checked::before {
        content: ""; position: absolute; inset: -2px; border-radius: 50%;
        background: #4ade80;
      }
      .ff-check-dot.ff-check-checked .ff-dot { opacity: 0; }
      .ff-check-dot.ff-check-checked .ff-check-glyph { opacity: 1; }

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

      .ff-timeline {
        position: absolute; left: 18px; right: 14px; top: calc(100% + 6px);
        background: var(--gooni-card, #FFFFFF);
        border: 0.5px solid var(--gooni-border, rgba(0,0,0,0.10));
        border-radius: 10px; padding: 12px 14px; z-index: 5;
        box-shadow: 0 10px 28px -16px rgba(0,0,0,0.25);
      }
      .ff-timeline-h {
        margin: 0 0 8px; font-size: 11px; letter-spacing: 0.08em;
        text-transform: uppercase; color: var(--gooni-muted, #8E8E93);
        font-weight: 600;
      }
      .ff-timeline-empty {
        color: var(--gooni-muted, #8E8E93); font-size: 12px;
      }

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
