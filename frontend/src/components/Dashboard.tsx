import { useState, useEffect, useRef } from "react";
import {
  fetchDashboardStats, fetchGooniTake,
  fetchTodos, createTodo, updateTodo, deleteTodo, reorderTodos, createTodoPlan,
  fetchCalendarStatus, createCalendarEvent,
  type ApiNote, type ApiTodo, type DashboardStats,
} from "../services/api";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { useGooniThemeStore, THEME_PALETTES } from "../stores/useGooniThemeStore";
import { NoteEditor } from "./notes/NoteEditor";
import { BrainOrb } from "./BrainOrb";
import { ExploreModal } from "./ExploreModal";
import { FocusCard } from "./FocusCard";
import { FocusCheckinCard } from "./FocusCheckinCard";
import { SuggestionsCard } from "./SuggestionsCard";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";
const GREEN = "#4ADE80";

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function getDateStr(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function formatNoteDate(iso: string | null): string {
  if (!iso) return "—";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  }
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

type InkState = {
  id: number;
  fromX: number; fromY: number;
  toX: number;   toY: number;
  angle: number;
  phase: "init" | "travel" | "absorb";
};

// ── Todo card ──────────────────────────────────────────────────────────────────

// Backend returns naive UTC ISO strings (no Z, no offset). JS new Date() treats
// those as local, which flips the day boundary on completed_at filters. Always
// parse through this helper so "completed today" actually matches UTC-to-local.
function parseBackendDate(iso: string): Date {
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  return new Date(hasOffset ? iso : iso + "Z");
}

// Bounds for the local calendar day at (today + dayOffset). dayOffset 0 = today,
// -1 = yesterday, etc. Returns [start-of-day, start-of-next-day].
function dayBounds(dayOffset: number): [Date, Date] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + dayOffset);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start, end];
}

// Day-scoped filter.
//  - dayOffset === 0 (today): open items + done-today, open first by sort_order.
//  - dayOffset  <  0 (past):  ONLY items completed that day, most recent first.
function filterVisibleTodos(todos: ApiTodo[], dayOffset: number): ApiTodo[] {
  const [start, end] = dayBounds(dayOffset);

  if (dayOffset === 0) {
    const visible = todos.filter(
      (t) => !t.done || (t.completed_at && parseBackendDate(t.completed_at) >= start),
    );
    return visible.sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      // Float overdue + due-today to the top; preserve manual order otherwise.
      const aR = a.done ? 99 : urgencyRank(a.due_date);
      const bR = b.done ? 99 : urgencyRank(b.due_date);
      if (aR !== bR) return aR - bR;
      return a.sort_order - b.sort_order;
    });
  }

  const visible = todos.filter((t) => {
    if (!t.done || !t.completed_at) return false;
    const c = parseBackendDate(t.completed_at);
    return c >= start && c < end;
  });
  return visible.sort((a, b) => {
    const ac = parseBackendDate(a.completed_at!).getTime();
    const bc = parseBackendDate(b.completed_at!).getTime();
    return bc - ac;
  });
}

function formatDayLabel(dayOffset: number): string {
  if (dayOffset === 0) return "today";
  if (dayOffset === -1) return "yesterday";
  const [start] = dayBounds(dayOffset);
  return start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// Relative age in m/h/d since created_at. Returns null for under-a-minute.
// Tier drives color escalation: newer todos stay muted; stale ones warm up.
type AgeTier = "fresh" | "stale" | "warm" | "bold";
function formatAge(createdAt: string): { text: string; tier: AgeTier } | null {
  // Backend returns naive UTC ISO strings (no Z, no offset). JS `new Date(...)`
  // treats those as local, making "now - createdAt" go negative by the TZ offset.
  // Force-interpret as UTC by appending Z when no offset is present.
  const hasOffset = createdAt.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(createdAt);
  const ms = new Date(hasOffset ? createdAt : createdAt + "Z").getTime();
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return null;
  if (sec < 3600) return { text: `${Math.floor(sec / 60)}m`, tier: "fresh" };
  const hours = Math.floor(sec / 3600);
  if (hours < 24) return { text: `${hours}h`, tier: "fresh" };
  const days = Math.floor(hours / 24);
  const tier: AgeTier = days >= 7 ? "bold" : days >= 4 ? "warm" : "stale";
  return { text: `${days}d`, tier };
}

function ageTierStyle(tier: AgeTier): { color: string; weight: number } {
  if (tier === "bold") return { color: "#B7791F", weight: 600 };  // bold amber — 7+d
  if (tier === "warm") return { color: "#D69E2E", weight: 500 };  // warm amber — 4-6d
  if (tier === "stale") return { color: "#8E8E93", weight: 500 }; // neutral gray — 1-3d
  return { color: "#AEAEB2", weight: 400 };                        // lighter gray — minutes/hours
}

// ── Due-date urgency ────────────────────────────────────────────────────────
// Backend serializes due_date as naive `YYYY-MM-DDT00:00:00` (no Z). Parse as
// local-day so "today" semantics stay aligned with the user's calendar — we
// don't append Z here, unlike created_at/completed_at which are real timestamps.
function parseDueDate(iso: string): Date {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  return d;
}

type DueTier = "overdue" | "today" | "tomorrow" | "soon" | "later" | "far";

function dueDaysFromToday(iso: string): number {
  const due = parseDueDate(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - today.getTime()) / 86400000);
}

function dueUrgencyTier(iso: string): DueTier {
  const days = dueDaysFromToday(iso);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 7) return "soon";
  if (days <= 30) return "later";
  return "far";
}

// Saturation-driven palette: one accent (amber) intensifies as the date nears.
// Red is reserved exclusively for overdue — the only "you broke a promise" signal.
function dueTierStyle(tier: DueTier): { bg: string; fg: string; weight: number; border: string } {
  switch (tier) {
    case "overdue":  return { bg: "#FF3B30", fg: "#fff",    weight: 600, border: "transparent" };
    case "today":    return { bg: "#F59E0B", fg: "#fff",    weight: 600, border: "transparent" };
    case "tomorrow": return { bg: "#FCD34D", fg: "#7C2D12", weight: 600, border: "transparent" };
    case "soon":     return { bg: "#FEF3C7", fg: "#92400E", weight: 500, border: "transparent" };
    case "later":    return { bg: "#F1F5F9", fg: "#475569", weight: 500, border: "transparent" };
    case "far":      return { bg: "transparent", fg: "#94A3B8", weight: 400, border: "rgba(0,0,0,0.10)" };
  }
}

function formatDueLabel(iso: string): string {
  const days = dueDaysFromToday(iso);
  if (days === 0) return "Today";
  if (days === 1) return "Tom";
  if (days === -1) return "1d ago";
  if (days < 0) return `${Math.abs(days)}d ago`;
  if (days <= 6) return parseDueDate(iso).toLocaleDateString("en-US", { weekday: "short" });
  return parseDueDate(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Sort key: overdue floats highest, then today, everything else neutral.
// Tomorrow/soon don't auto-float — only the inescapable cases do, so the
// rest of the list keeps the manual order the user set.
function urgencyRank(iso: string | null): number {
  if (!iso) return 99;
  const tier = dueUrgencyTier(iso);
  if (tier === "overdue") return 0;
  if (tier === "today") return 1;
  return 99;
}

// Parse a trailing `/today`, `/tom`, `/<weekday>`, `/Nd` shortcut from the
// new-todo input. Returns the cleaned text (shortcut stripped) and an ISO
// `YYYY-MM-DD` due date, or null if no shortcut matched.
function parseTodoShortcut(input: string): { text: string; dueIso: string | null } {
  const m = input.match(/\s*\/(today|tom(?:orrow)?|mon|tue|wed|thu|fri|sat|sun|\d+d)\s*$/i);
  if (!m) return { text: input.trim(), dueIso: null };
  const token = m[1].toLowerCase();
  const cleaned = input.slice(0, m.index).trim();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let due: Date | null = null;
  if (token === "today") due = today;
  else if (token.startsWith("tom")) { due = new Date(today); due.setDate(today.getDate() + 1); }
  else if (/^\d+d$/.test(token)) {
    due = new Date(today); due.setDate(today.getDate() + parseInt(token, 10));
  } else {
    const map: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const target = map[token];
    if (target !== undefined) {
      const cur = today.getDay();
      let diff = (target - cur + 7) % 7;
      if (diff === 0) diff = 7; // /<weekday> always points to the *next* one
      due = new Date(today); due.setDate(today.getDate() + diff);
    }
  }
  if (!due) return { text: input.trim(), dueIso: null };
  // YYYY-MM-DD in local time (not UTC) — backend parses with fromisoformat.
  const yyyy = due.getFullYear();
  const mm = String(due.getMonth() + 1).padStart(2, "0");
  const dd = String(due.getDate()).padStart(2, "0");
  return { text: cleaned, dueIso: `${yyyy}-${mm}-${dd}` };
}

// ── DueChip ──────────────────────────────────────────────────────────────────
// Two states:
//   - no due_date: hover-only ghost "+ date" button (invisible at rest)
//   - has due_date: saturation-tinted pill, with an × that appears on hover
// In both states a transparent <input type="date"> overlays the chip so
// clicking anywhere opens the native picker without us shipping a custom one.
function DueChip({
  due,
  hidden,
  onChange,
}: {
  due: string | null;
  hidden: boolean;
  onChange: (iso: string | null) => void;
}) {
  const [hover, setHover] = useState(false);
  if (hidden) return null;

  if (due) {
    const tier = dueUrgencyTier(due);
    const style = dueTierStyle(tier);
    const label = formatDueLabel(due);
    const value = due.slice(0, 10); // YYYY-MM-DD for the native input
    return (
      <span
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          position: "relative",
          display: "inline-flex", alignItems: "center", gap: 4,
          padding: "1px 7px", borderRadius: 10,
          fontSize: 10.5, fontWeight: style.weight, letterSpacing: 0.2,
          background: style.bg, color: style.fg,
          border: `0.5px solid ${style.border}`,
          flexShrink: 0,
          cursor: "pointer",
          transition: "background 0.15s",
        }}
      >
        <input
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value || null)}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute", inset: 0,
            opacity: 0, cursor: "pointer",
            border: "none", background: "transparent",
            padding: 0, margin: 0, width: "100%", height: "100%",
            // Keep the picker behind the × button so the × can be clicked.
            zIndex: 1,
          }}
        />
        <span style={{ position: "relative", zIndex: 0 }}>{label}</span>
        {hover && (
          <button
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); onChange(null); }}
            title="Clear due date"
            style={{
              position: "relative", zIndex: 2,
              background: "transparent", border: "none", cursor: "pointer",
              padding: 0, marginLeft: 1, lineHeight: 1,
              color: style.fg === "#fff" ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.45)",
              fontSize: 11,
            }}
          >×</button>
        )}
      </span>
    );
  }

  // Empty state: ghost "+ date" — invisible until the row is hovered (parent
  // toggles opacity on .todo-hover).
  return (
    <span
      className="todo-hover"
      style={{
        position: "relative",
        display: "inline-flex", alignItems: "center",
        opacity: 0,
        padding: "1px 7px", borderRadius: 10,
        fontSize: 10.5, fontWeight: 500, letterSpacing: 0.2,
        background: "transparent", color: "#94A3B8",
        border: "0.5px dashed rgba(0,0,0,0.18)",
        flexShrink: 0,
        cursor: "pointer",
        transition: "opacity 0.12s, background 0.12s, color 0.12s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.color = "#475569";
        (e.currentTarget as HTMLElement).style.background = "rgba(0,0,0,0.03)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.color = "#94A3B8";
        (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    >
      <input
        type="date"
        value=""
        onChange={(e) => onChange(e.target.value || null)}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute", inset: 0,
          opacity: 0, cursor: "pointer",
          border: "none", background: "transparent",
          padding: 0, margin: 0, width: "100%", height: "100%",
        }}
      />
      <span style={{ position: "relative" }}>+ date</span>
    </span>
  );
}

// ── TodoCard ─────────────────────────────────────────────────────────────────

interface TodoCardProps {
  todos: ApiTodo[];
  onMutate: (nextTodos: ApiTodo[]) => void;
  onPlan?: (todo: ApiTodo) => void;
}

function TodoCard({ todos, onMutate, onPlan }: TodoCardProps) {
  const [newText, setNewText] = useState("");
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const [rowHoverId, setRowHoverId] = useState<number | null>(null);
  // Re-render every minute so the age pill rolls over from e.g. 2m → 3m
  // without needing a user interaction to trigger it.
  const [, setAgeTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setAgeTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Day-machine state: 0 = today, -1 = yesterday, etc. Navigating back shows
  // only todos completed on that day; past views are read-only.
  const [dayOffset, setDayOffset] = useState(0);
  const isPast = dayOffset < 0;
  const visible = filterVisibleTodos(todos, dayOffset);

  // Can we go further back? Only if at least one done todo exists with a
  // completed_at that falls BEFORE the start of the currently-viewed day.
  const [currentDayStart] = dayBounds(dayOffset);
  const canGoBack = todos.some(
    (t) => t.done && t.completed_at && parseBackendDate(t.completed_at) < currentDayStart,
  );
  const showEmpty = visible.length === 0;

  async function toggle(id: number, done: boolean) {
    const optimistic = todos.map((t) =>
      t.id === id ? { ...t, done, completed_at: done ? new Date().toISOString() : null } : t,
    );
    onMutate(optimistic);
    try {
      const updated = await updateTodo(id, { done });
      onMutate(optimistic.map((t) => (t.id === id ? updated : t)));
    } catch (e) {
      console.error(e);
      onMutate(todos);
    }
  }

  async function del(id: number) {
    const optimistic = todos.filter((t) => t.id !== id);
    onMutate(optimistic);
    try { await deleteTodo(id); } catch (e) { console.error(e); onMutate(todos); }
  }

  async function reorder(fromIdx: number, toIdx: number) {
    if (fromIdx === toIdx) return;
    const reordered = [...visible];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    const renumbered = reordered.map((t, i) => ({ ...t, sort_order: i + 1 }));
    const renumberedMap = new Map(renumbered.map((t) => [t.id, t]));
    const folded = todos.map((t) => renumberedMap.get(t.id) ?? t);
    onMutate(folded);
    try {
      await reorderTodos(renumbered.map((t) => ({ id: t.id, sort_order: t.sort_order })));
    } catch (e) { console.error(e); onMutate(todos); }
  }

  async function handleAdd() {
    const raw = newText.trim();
    if (!raw) return;
    const { text, dueIso } = parseTodoShortcut(raw);
    if (!text) return;
    setNewText("");
    const tempId = -Date.now();
    const optimistic: ApiTodo = {
      id: tempId, text, done: false,
      created_at: new Date().toISOString(), completed_at: null,
      sort_order: todos.reduce((m, t) => Math.max(m, t.sort_order), 0) + 1,
      due_date: dueIso,
    };
    onMutate([...todos, optimistic]);
    try {
      const created = await createTodo(text, dueIso);
      onMutate([...todos.filter((t) => t.id !== tempId), created]);
    } catch (e) {
      console.error(e);
      onMutate(todos);
    }
  }

  async function setDue(id: number, isoOrNull: string | null) {
    const optimistic = todos.map((t) => (t.id === id ? { ...t, due_date: isoOrNull } : t));
    onMutate(optimistic);
    try {
      const updated = await updateTodo(id, { due_date: isoOrNull });
      onMutate(optimistic.map((t) => (t.id === id ? updated : t)));
    } catch (e) {
      console.error(e);
      onMutate(todos);
    }
  }

  function startEdit(t: ApiTodo) {
    setEditingId(t.id);
    setEditingText(t.text);
  }
  function cancelEdit() {
    setEditingId(null);
    setEditingText("");
  }
  async function commitEdit() {
    const id = editingId;
    if (id === null) return;
    const next = editingText.trim();
    const cur = todos.find((t) => t.id === id);
    setEditingId(null);
    setEditingText("");
    if (!cur) return;
    if (!next) { await del(id); return; }
    if (next === cur.text) return;
    const optimistic = todos.map((t) => (t.id === id ? { ...t, text: next } : t));
    onMutate(optimistic);
    try {
      const updated = await updateTodo(id, { text: next });
      onMutate(optimistic.map((t) => (t.id === id ? updated : t)));
    } catch (e) { console.error(e); onMutate(todos); }
  }

  return (
    <div style={{
      background: "#fff",
      border: "0.5px solid rgba(0,0,0,0.08)",
      borderRadius: 12,
      padding: 16,
      marginBottom: 22,
      fontFamily: FONT,
    }}>
      {/* Day-navigator header. Left chevron steps back a day (shows that day's
          completed todos, read-only). Right chevron returns to today. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 4,
        marginBottom: 12, userSelect: "none",
      }}>
        <button
          onClick={() => canGoBack && setDayOffset((d) => d - 1)}
          disabled={!canGoBack}
          title={canGoBack ? "See a previous day's completed todos" : "No older completed todos"}
          style={{
            background: "none", border: "none", padding: 0,
            color: "#8E8E93",
            opacity: canGoBack ? 0.55 : 0.18,
            cursor: canGoBack ? "pointer" : "default",
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 16, height: 16,
            transition: "opacity 0.12s",
          }}
          onMouseEnter={(e) => { if (canGoBack) (e.currentTarget as HTMLButtonElement).style.opacity = "1"; }}
          onMouseLeave={(e) => { if (canGoBack) (e.currentTarget as HTMLButtonElement).style.opacity = "0.55"; }}
        >
          <svg width="8" height="10" viewBox="0 0 8 10" fill="none" aria-hidden="true">
            <path d="M6 1L2 5L6 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div style={{
          fontSize: 11, color: "#8E8E93", letterSpacing: 0.6,
          textTransform: "uppercase",
        }}>{formatDayLabel(dayOffset)}</div>
        {isPast && (
          <button
            onClick={() => setDayOffset((d) => Math.min(0, d + 1))}
            title="Back to today"
            style={{
              background: "none", border: "none", padding: 0,
              color: "#8E8E93", opacity: 0.55, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 16, height: 16, marginLeft: 2,
              transition: "opacity 0.12s",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = "1")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = "0.55")}
          >
            <svg width="8" height="10" viewBox="0 0 8 10" fill="none" aria-hidden="true">
              <path d="M2 1L6 5L2 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>

      {showEmpty && (
        <div style={{ fontSize: 13, color: "#C7C7CC", padding: "4px 0 2px" }}>
          {isPast
            ? `Nothing was completed ${formatDayLabel(dayOffset)}.`
            : "Nothing here yet — add your first todo below."}
        </div>
      )}

      {visible.map((t, i) => {
        const isDragging = dragIdx === i;
        const isHoverDrop = hoverIdx === i && dragIdx !== null && dragIdx !== i;
        const isEditing = editingId === t.id;
        const age = t.done ? null : formatAge(t.created_at);
        const ageStyle = age ? ageTierStyle(age.tier) : null;

        return (
          <div
            key={t.id}
            draggable={!isEditing && !isPast}
            onDragStart={(e) => {
              if (isEditing || isPast) { e.preventDefault(); return; }
              setDragIdx(i);
              e.dataTransfer.effectAllowed = "move";
              try { e.dataTransfer.setData("text/plain", t.text); } catch {}
            }}
            onDragEnd={() => { setDragIdx(null); setHoverIdx(null); }}
            onDragOver={(e) => {
              if (isPast) return;
              e.preventDefault();
              if (dragIdx !== null && dragIdx !== i) setHoverIdx(i);
            }}
            onDragLeave={() => { if (hoverIdx === i) setHoverIdx(null); }}
            onDrop={(e) => {
              if (isPast) return;
              e.preventDefault();
              if (dragIdx !== null && dragIdx !== i) reorder(dragIdx, i);
              setDragIdx(null);
              setHoverIdx(null);
            }}
            style={{
              position: "relative",
              display: "flex", alignItems: "center", gap: 8,
              padding: "8px 8px",
              marginLeft: -8, marginRight: -8,
              borderRadius: 6,
              borderBottom: i === visible.length - 1 ? "none" : "0.5px solid rgba(0,0,0,0.07)",
              opacity: isDragging ? 0.35 : 1,
              background: isHoverDrop
                ? "rgba(255,196,82,0.15)"
                : rowHoverId === t.id
                ? "rgba(0,0,0,0.035)"
                : "transparent",
              transition: "background 0.12s",
              cursor: "default",
            }}
            onMouseEnter={(e) => {
              setRowHoverId(t.id);
              (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLElement>(".todo-hover").forEach((el) => (el.style.opacity = "1"));
            }}
            onMouseLeave={(e) => {
              setRowHoverId((cur) => (cur === t.id ? null : cur));
              (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLElement>(".todo-hover").forEach((el) => (el.style.opacity = "0"));
            }}
          >
            <button
              onClick={() => { if (!isPast) toggle(t.id, !t.done); }}
              aria-label={t.done ? "Uncheck" : "Check"}
              disabled={isPast}
              style={{
                width: 16, height: 16, borderRadius: "50%",
                border: t.done ? `1.5px solid ${GREEN}` : "1.5px solid rgba(0,0,0,0.18)",
                background: t.done ? GREEN : "transparent",
                cursor: isPast ? "default" : "pointer", padding: 0, flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "background 0.15s, border-color 0.15s",
                opacity: isPast ? 0.85 : 1,
              }}
            >
              {t.done && (
                <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                  <path d="M1.5 4.5 L3.5 6.5 L7.5 2" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>

            {isEditing ? (
              <input
                autoFocus
                value={editingText}
                onChange={(e) => setEditingText(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
                  else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
                }}
                style={{
                  flex: 1, fontSize: 13, fontFamily: FONT, color: "#1C1C1E",
                  background: "transparent", border: "none", outline: "none",
                  padding: 0, lineHeight: 1.5, minWidth: 0,
                }}
              />
            ) : (
              <span
                onClick={() => { if (!isPast) startEdit(t); }}
                style={{
                  flex: 1, fontSize: 13,
                  color: t.done ? "#AEAEB2" : "#1C1C1E",
                  textDecoration: t.done ? "line-through" : "none",
                  lineHeight: 1.5,
                  cursor: isPast ? "default" : "text",
                  userSelect: "text",
                }}
              >{t.text}</span>
            )}

            {/* Age pill — only shows when no due date is set, since the due
                pill conveys urgency more directly once a date exists. */}
            {age && ageStyle && !t.due_date && (
              <span style={{
                fontSize: 10, fontWeight: ageStyle.weight, color: ageStyle.color,
                fontVariantNumeric: "tabular-nums", flexShrink: 0, letterSpacing: 0.2,
              }}>
                {age.text}
              </span>
            )}

            {/* Due-date chip — colored pill when set, hover-only ghost button when not.
                Click anywhere on the chip opens the native date picker via an overlaid
                transparent <input type="date">. */}
            {!t.done && (
              <DueChip
                due={t.due_date}
                hidden={isPast}
                onChange={(iso) => setDue(t.id, iso)}
              />
            )}

            {!isPast && !t.done && onPlan && (
              <button
                className="todo-hover"
                onClick={(e) => { e.stopPropagation(); onPlan(t); }}
                title="Plan for this todo"
                style={{
                  opacity: 0,
                  background: "none", border: "none", cursor: "pointer",
                  color: "#8E8E93", fontSize: 11, padding: "2px 6px", lineHeight: 1.2,
                  borderRadius: 5,
                  transition: "opacity 0.12s, color 0.12s, background 0.12s",
                  flexShrink: 0, fontWeight: 500, letterSpacing: 0.2,
                  fontFamily: FONT,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.color = "#1C1C1E";
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.color = "#8E8E93";
                  (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                }}
              >plan</button>
            )}

            {!isPast && (
              <button
                className="todo-hover"
                onClick={(e) => { e.stopPropagation(); del(t.id); }}
                title="Delete"
                style={{
                  opacity: 0,
                  background: "none", border: "none", cursor: "pointer",
                  color: "#C7C7CC", fontSize: 14, padding: "0 4px", lineHeight: 1,
                  transition: "opacity 0.12s, color 0.12s", flexShrink: 0,
                }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#FF3B30")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#C7C7CC")}
              >×</button>
            )}
          </div>
        );
      })}

      {!isPast && <div
        className="gooni-todo-add"
        style={{
          position: "relative",
          display: "flex", alignItems: "center", gap: 8,
          marginTop: visible.length > 0 ? 4 : 0,
          paddingTop: visible.length > 0 ? 8 : 6,
          paddingBottom: 6,
          paddingLeft: 8, paddingRight: 8,
          marginLeft: -8, marginRight: -8,
          borderTop: visible.length > 0 ? "0.5px solid rgba(0,0,0,0.07)" : "none",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <span style={{
          width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center",
          color: "#C7C7CC", fontSize: 14, flexShrink: 0,
          position: "relative", zIndex: 1,
        }}>+</span>
        <input
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAdd(); } }}
          placeholder="add a todo"
          style={{
            flex: 1, fontSize: 13, fontFamily: FONT,
            border: "none", outline: "none", background: "transparent",
            color: "#1C1C1E", padding: "4px 0",
            position: "relative", zIndex: 1,
          }}
        />
      </div>}
    </div>
  );
}

// ── PlanAnimation ─────────────────────────────────────────────────────────────
// Drop-in replacement for the embedded NoteEditor while a plan is being spun up.
// Expands the container, types the title character-by-character, then drops a
// blinking cursor on the next line and offers Continue / Cancel. The note is
// already created on the backend; this is just the front-end flourish + a
// handoff into the full editor.

function PlanWrapper({
  title,
  noteId,
  onSubmitted,
  onContinue,
  onCancel,
}: {
  title: string;
  noteId: number;
  onSubmitted: () => void;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState(0);
  const done = typed >= title.length;
  // Latches once the user types anything into the embedded NoteEditor —
  // hides the meta-buttons (Open in editor / Cancel) so the typing flow
  // isn't cluttered. Latched, so clearing back to empty doesn't un-hide.
  const [hasTyped, setHasTyped] = useState(false);

  useEffect(() => {
    if (typed >= title.length) return;
    const h = setTimeout(() => setTyped(typed + 1), 35);
    return () => clearTimeout(h);
  }, [typed, title]);

  // Esc cancels at any time — user needs a reliable escape hatch even
  // after they've started typing a body (content stays in the note as a
  // draft; they can delete from the notes list if unwanted).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // "Open in editor" only makes sense before they've started typing —
  // after that the NoteEditor's own submit button carries the flow. The
  // close (×) button below is the persistent escape hatch.
  const showContinue = done && !hasTyped;

  return (
    <div
      style={{
        position: "relative",
        animation: "gooni-plan-expand 320ms cubic-bezier(0.22,1,0.36,1) both",
      }}
    >
      <style>{`
        @keyframes gooni-plan-expand {
          0%   { opacity: 0.4; transform: translateY(-4px) scale(0.985); }
          100% { opacity: 1;   transform: translateY(0)    scale(1); }
        }
        @keyframes gooni-plan-caret {
          0%, 50%   { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
        .gooni-plan-caret {
          display: inline-block;
          width: 2px;
          margin-left: 1px;
          background: #1C1C1E;
          animation: gooni-plan-caret 1s step-end infinite;
          vertical-align: text-bottom;
        }
      `}</style>

      {/* Title row: animated bold title typed character-by-character, with
          a persistent × close button on the right so user can always bail
          out. Esc also cancels. */}
      <div style={{
        display: "flex", alignItems: "flex-start", gap: 8,
        marginBottom: 12, minHeight: 30,
      }}>
        <div style={{
          flex: 1, minWidth: 0,
          fontSize: 22, fontWeight: 700, color: "#1C1C1E",
          letterSpacing: "-0.3px", lineHeight: 1.25,
        }}>
          {title.slice(0, typed)}
          {!done && <span className="gooni-plan-caret" style={{ height: 24 }} />}
        </div>
        <button
          onClick={onCancel}
          title="Close (Esc)"
          aria-label="Close plan"
          style={{
            flexShrink: 0,
            background: "transparent", border: "none", cursor: "pointer",
            width: 24, height: 24, borderRadius: 6,
            color: "#8E8E93", fontSize: 18, lineHeight: 1,
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 0, transition: "background 0.12s, color 0.12s",
            marginTop: -2,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)";
            (e.currentTarget as HTMLButtonElement).style.color = "#1C1C1E";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            (e.currentTarget as HTMLButtonElement).style.color = "#8E8E93";
          }}
        >×</button>
      </div>

      {/* Real NoteEditor handles body input, submit (Enter / button),
          image paste, autosave — all of it. submitToNoteId makes the
          submit path PATCH the existing plan note instead of creating
          a new one. */}
      {done && (
        <NoteEditor
          variant="embedded"
          submitToNoteId={noteId}
          onEmptyChange={(empty) => { if (!empty) setHasTyped(true); }}
          onSubmitted={onSubmitted}
        />
      )}

      {showContinue && (
        <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={onContinue}
            style={{
              background: "transparent", color: "#3C3C43",
              border: "1px solid rgba(0,0,0,0.12)",
              borderRadius: 8, padding: "6px 12px", fontSize: 12.5, fontWeight: 500,
              cursor: "pointer", fontFamily: FONT, letterSpacing: 0.1,
            }}
          >
            Open in editor →
          </button>
          <SchedulePlanButton title={title} noteId={noteId} />
        </div>
      )}
    </div>
  );
}

// ── SchedulePlanButton ────────────────────────────────────────────────────────
// A small "📅 Schedule" affordance attached to a plan note. Clicking expands
// inline into a date + start-time + duration form; Enter or Create hits the
// /calendar/events endpoint. If the user hasn't connected Google Calendar yet,
// we show a nudge that points them at DevToolsModal.

function roundToNextHalfHour(d: Date): Date {
  const copy = new Date(d);
  copy.setMinutes(copy.getMinutes() < 30 ? 30 : 60, 0, 0);
  return copy;
}

function toLocalDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toLocalTimeInputValue(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// Combine a YYYY-MM-DD + HH:MM input pair with the current local TZ offset
// into an RFC3339 string that Google's Calendar API accepts.
function localInputsToRFC3339(dateStr: string, timeStr: string): string {
  const [y, m, d] = dateStr.split("-").map((x) => parseInt(x, 10));
  const [hh, mm] = timeStr.split(":").map((x) => parseInt(x, 10));
  const local = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0);
  const tzOffsetMin = -local.getTimezoneOffset(); // positive for east of UTC
  const sign = tzOffsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(tzOffsetMin);
  const offH = String(Math.floor(absMin / 60)).padStart(2, "0");
  const offM = String(absMin % 60).padStart(2, "0");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}:00${sign}${offH}:${offM}`;
}

function SchedulePlanButton({ title, noteId }: { title: string; noteId: number }) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<{ connected: boolean; configured: boolean } | null>(null);
  const initial = roundToNextHalfHour(new Date(Date.now() + 60 * 60 * 1000)); // 1h from now, rounded
  const [date, setDate] = useState(toLocalDateInputValue(initial));
  const [time, setTime] = useState(toLocalTimeInputValue(initial));
  const [durationMin, setDurationMin] = useState(60);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ html_link: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded || status) return;
    fetchCalendarStatus()
      .then((s) => setStatus({ connected: s.connected, configured: s.configured }))
      .catch(() => setStatus({ connected: false, configured: false }));
  }, [expanded, status]);

  async function submit() {
    setCreating(true);
    setErr(null);
    try {
      const startISO = localInputsToRFC3339(date, time);
      const startMs = Date.parse(startISO);
      const endMs = startMs + durationMin * 60 * 1000;
      const endISO = localInputsToRFC3339(
        toLocalDateInputValue(new Date(endMs)),
        toLocalTimeInputValue(new Date(endMs)),
      );
      const event = await createCalendarEvent({
        summary: title,
        start_iso: startISO,
        end_iso: endISO,
        description: `Plan note #${noteId} in Gooni.`,
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setResult({ html_link: event.html_link });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        style={{
          background: "transparent", color: "#3C3C43",
          border: "1px solid rgba(0,0,0,0.12)",
          borderRadius: 8, padding: "6px 12px", fontSize: 12.5, fontWeight: 500,
          cursor: "pointer", fontFamily: FONT, letterSpacing: 0.1,
          display: "flex", alignItems: "center", gap: 5,
        }}
      >
        <span style={{ fontSize: 13 }}>📅</span> Schedule
      </button>
    );
  }

  if (result) {
    return (
      <div style={{ fontSize: 12, color: "#2B8C4D", display: "flex", alignItems: "center", gap: 6 }}>
        ✓ Scheduled —{" "}
        <a href={result.html_link} target="_blank" rel="noreferrer" style={{ color: "#2B8C4D", textDecoration: "underline" }}>
          open in Google Calendar
        </a>
      </div>
    );
  }

  if (status && !status.configured) {
    return (
      <div style={{ fontSize: 12, color: "#8E8E93", padding: "6px 0" }}>
        Calendar not configured. Set env vars on the backend first.
        <button onClick={() => setExpanded(false)} style={{ marginLeft: 6, background: "transparent", border: "none", color: "#6B6B70", textDecoration: "underline", cursor: "pointer", fontSize: 12 }}>dismiss</button>
      </div>
    );
  }

  if (status && !status.connected) {
    return (
      <div style={{ fontSize: 12, color: "#8E8E93", padding: "6px 0" }}>
        Connect Calendar from <strong>Dev tools</strong> in the sidebar first.
        <button onClick={() => setExpanded(false)} style={{ marginLeft: 6, background: "transparent", border: "none", color: "#6B6B70", textDecoration: "underline", cursor: "pointer", fontSize: 12 }}>dismiss</button>
      </div>
    );
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
      padding: "6px 8px", borderRadius: 8, background: "rgba(0,0,0,0.03)",
      border: "1px solid rgba(0,0,0,0.08)",
    }}>
      <input
        type="date" value={date} onChange={(e) => setDate(e.target.value)}
        style={{ fontSize: 12.5, border: "none", background: "transparent", fontFamily: FONT, outline: "none" }}
      />
      <input
        type="time" value={time} onChange={(e) => setTime(e.target.value)}
        style={{ fontSize: 12.5, border: "none", background: "transparent", fontFamily: FONT, outline: "none" }}
      />
      <select
        value={durationMin}
        onChange={(e) => setDurationMin(parseInt(e.target.value, 10))}
        style={{ fontSize: 12.5, border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6, padding: "2px 6px", background: "#fff", fontFamily: FONT }}
      >
        <option value={30}>30 min</option>
        <option value={60}>1 hr</option>
        <option value={90}>1.5 hr</option>
        <option value={120}>2 hr</option>
        <option value={180}>3 hr</option>
      </select>
      <button
        onClick={submit}
        disabled={creating}
        style={{
          background: "#1C1C1E", color: "#fff", border: "none",
          borderRadius: 6, padding: "5px 10px", fontSize: 12, fontWeight: 600,
          cursor: creating ? "default" : "pointer", fontFamily: FONT,
          opacity: creating ? 0.6 : 1,
        }}
      >
        {creating ? "adding…" : "create"}
      </button>
      <button
        onClick={() => setExpanded(false)}
        style={{
          background: "transparent", color: "#8E8E93", border: "none",
          padding: "5px 6px", fontSize: 12, cursor: "pointer", fontFamily: FONT,
        }}
      >cancel</button>
      {err && <span style={{ fontSize: 11, color: "#C44", width: "100%" }}>{err}</span>}
    </div>
  );
}

// ── Dashboard ──────────────────────────────────────────────────────────────────
// The dashboard itself:

export function Dashboard({ onOpenNote }: { onOpenNote: () => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [take, setTake] = useState<string>("");
  const [takeRefreshing, setTakeRefreshing] = useState(false);
  const [todos, setTodos] = useState<ApiTodo[]>([]);
  const [ink, setInk] = useState<InkState | null>(null);
  const [cardPulsing, setRowPulsing] = useState(false);
  const [typing, setTyping] = useState<{ noteId: number; revealed: number; total: number } | null>(null);
  const typingRaf = useRef<number | null>(null);
  // Plan-from-todo state. When non-null, the note input is replaced by a
  // typing-animation block showing "Plan for <todo text>". The note already
  // exists on the backend (linked via todo_notes); user clicks "continue"
  // to navigate to it in the full editor.
  const [planning, setPlanning] = useState<{ todo: ApiTodo; note: ApiNote } | null>(null);
  const [exploreOpen, setExploreOpen] = useState(false);
  const { selectSpace, loadNotes, selectNote } = useNotesContentStore();
  const theme = useGooniThemeStore((s) => s.theme);
  const palette = THEME_PALETTES[theme];
  const firstCardRef = useRef<HTMLDivElement>(null);
  const dashRef = useRef<HTMLDivElement>(null);

  // Keep body/html background in sync with theme so any gap around the app fills correctly.
  useEffect(() => {
    document.body.style.background = palette.main;
    document.documentElement.style.background = palette.main;
  }, [palette.main]);

  useEffect(() => () => {
    if (typingRaf.current != null) cancelAnimationFrame(typingRaf.current);
  }, []);

  useEffect(() => {
    fetchDashboardStats().then(setStats).catch(console.error);
    fetchGooniTake().then((r) => setTake(r.take)).catch(console.error);
    fetchTodos().then(setTodos).catch(console.error);
  }, []);

  function startTyping(noteId: number, total: number) {
    if (typingRaf.current != null) cancelAnimationFrame(typingRaf.current);
    if (total <= 0) return;
    setTyping({ noteId, revealed: 0, total });
    const duration = Math.min(1400, 350 + total * 6);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const revealed = Math.floor(eased * total);
      setTyping((s) => (s && s.noteId === noteId ? { ...s, revealed } : s));
      if (t < 1) {
        typingRaf.current = requestAnimationFrame(tick);
      } else {
        typingRaf.current = null;
        setTyping(null);
      }
    };
    typingRaf.current = requestAnimationFrame(tick);
  }

  async function handlePlanFromTodo(todo: ApiTodo) {
    // Guard: one plan animation at a time.
    if (planning) return;
    try {
      const note = await createTodoPlan(todo.id);
      setPlanning({ todo, note });
    } catch (e) {
      console.error("plan failed:", e);
    }
  }

  function handlePlanContinue() {
    if (!planning) return;
    const id = planning.note.id;
    setPlanning(null);
    selectSpace("general");
    selectNote(id);
    onOpenNote();
  }

  function handlePlanCancel() {
    // Note stays in the DB (linked) — user can delete from notes list if unwanted.
    setPlanning(null);
  }

  async function handleSubmitted(_note: ApiNote | null, buttonRect: DOMRect | null) {
    const target = firstCardRef.current?.getBoundingClientRect() ?? null;
    const refresh = fetchDashboardStats();

    if (buttonRect && target) {
      const fromX = buttonRect.left + buttonRect.width / 2;
      const fromY = buttonRect.top + buttonRect.height / 2;
      const toX = target.left + target.width / 2;
      const toY = target.top + target.height / 2;
      const angle = (Math.atan2(toY - fromY, toX - fromX) * 180) / Math.PI;
      const inkId = Date.now();
      setInk({ id: inkId, fromX, fromY, toX, toY, angle, phase: "init" });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setInk((s) => (s && s.id === inkId ? { ...s, phase: "travel" } : s));
        });
      });
      setTimeout(() => {
        setInk((s) => (s && s.id === inkId ? { ...s, phase: "absorb" } : s));
        setRowPulsing(true);
        refresh
          .then((s) => {
            setStats(s);
            const first = s.recent_notes[0];
            if (first) {
              const t = (first.title ?? "").trim() || "Untitled";
              const ex = stripHtml(first.content ?? "");
              startTyping(first.id, t.length + ex.length);
            }
          })
          .catch(console.error);
      }, 640);
      setTimeout(() => {
        setInk((s) => (s && s.id === inkId ? null : s));
        setRowPulsing(false);
      }, 1280);
    } else {
      refresh.then(setStats).catch(console.error);
    }
  }

  async function refreshTake() {
    if (takeRefreshing) return;
    setTakeRefreshing(true);
    try {
      const r = await fetchGooniTake({ force: true });
      setTake(r.take);
    } catch (e) {
      console.error(e);
    } finally {
      setTakeRefreshing(false);
    }
  }

  function openNote(spaceId: number | null, noteId: number) {
    const sid = spaceId == null ? "general" : String(spaceId);
    selectSpace(sid);
    selectNote(noteId);
    loadNotes(sid);
    onOpenNote();
  }

  const activityPerDay = stats?.activity_per_day ?? [0, 0, 0, 0, 0, 0, 0];

  return (
    <div ref={dashRef} style={{ flex: 1, overflowY: "auto", background: palette.main, fontFamily: FONT, position: "relative" }}>
      <style>{`
        @keyframes gooni-card-pulse {
          0%   { transform: scale(1);    box-shadow: 0 0 0 0 rgba(28,28,30,0.0); border-color: rgba(0,0,0,0.07); }
          22%  { transform: scale(1.035); box-shadow: 0 0 0 6px rgba(28,28,30,0.06); border-color: rgba(28,28,30,0.28); }
          60%  { transform: scale(1);    box-shadow: 0 0 0 2px rgba(28,28,30,0.03); border-color: rgba(28,28,30,0.18); }
          100% { transform: scale(1);    box-shadow: 0 0 0 0 rgba(28,28,30,0.0); border-color: rgba(0,0,0,0.07); }
        }
        @keyframes gooni-caret-blink {
          0%, 49% { opacity: 1; }
          50%, 100% { opacity: 0; }
        }
        @keyframes gooni-spin { to { transform: rotate(360deg); } }
        .gooni-caret {
          display: inline-block;
          color: #1C1C1E;
          animation: gooni-caret-blink 0.7s step-end infinite;
          margin-left: 1px;
          font-weight: 400;
        }
        /* Quiet hover on the 'add a todo' row — matches the per-row hover treatment above it. */
        .gooni-todo-add { transition: background 0.12s; }
        .gooni-todo-add:hover,
        .gooni-todo-add:focus-within { background: rgba(0,0,0,0.035); }
      `}</style>

      {ink && (
        <div
          style={{
            position: "fixed",
            left: ink.fromX,
            top: ink.fromY,
            width: 14,
            height: 14,
            marginLeft: -7,
            marginTop: -7,
            borderRadius: "50%",
            background: "radial-gradient(circle at 35% 35%, #3A3A3C 0%, #1C1C1E 60%, #0A0A0B 100%)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.28), 0 0 2px rgba(0,0,0,0.35)",
            filter: "blur(0.3px)",
            pointerEvents: "none",
            zIndex: 9999,
            willChange: "transform, opacity",
            transform:
              ink.phase === "init"
                ? `translate(0px, 0px) rotate(${ink.angle}deg) scale(0.5, 0.5)`
                : ink.phase === "travel"
                ? `translate(${ink.toX - ink.fromX}px, ${ink.toY - ink.fromY}px) rotate(${ink.angle}deg) scale(1.55, 0.6)`
                : `translate(${ink.toX - ink.fromX}px, ${ink.toY - ink.fromY}px) rotate(0deg) scale(2.1, 2.1)`,
            opacity: ink.phase === "init" ? 0.55 : ink.phase === "absorb" ? 0 : 0.92,
            transition:
              ink.phase === "absorb"
                ? "transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.4s ease-out"
                : "transform 0.6s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.35s ease-in",
          }}
        />
      )}

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "48px 40px 120px" }}>

        {/* Greeting + stats on the same row — greeting left, compact stat cards floated right */}
        <div style={{
          display: "flex", alignItems: "flex-start", justifyContent: "space-between",
          gap: 16, marginBottom: 26,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#1C1C1E", letterSpacing: "-0.5px", lineHeight: 1.2 }}>
              {getGreeting()}, Daniel.
            </div>
            <div style={{ fontSize: 13, color: "#8E8E93", marginTop: 4 }}>
              {getDateStr()}
              {(() => {
                const startOfToday = new Date();
                startOfToday.setHours(0, 0, 0, 0);
                const openCount = todos.filter((t) => !t.done).length;
                const doneToday = todos.filter(
                  (t) => t.done && t.completed_at && new Date(t.completed_at) >= startOfToday,
                ).length;
                if (openCount === 0 && doneToday === 0) return null;
                return (
                  <>
                    <span style={{ margin: "0 8px", color: "#D1D1D6" }}>·</span>
                    <span>{openCount} {openCount === 1 ? "todo" : "todos"} open</span>
                    {doneToday > 0 && (
                      <>
                        <span style={{ margin: "0 6px", color: "#D1D1D6" }}>·</span>
                        <span style={{ color: "#2B8C4D" }}>✓ {doneToday} done today</span>
                      </>
                    )}
                  </>
                );
              })()}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexShrink: 0, alignItems: "stretch" }}>
            {/* 3D brain — opens the notes visualization. Left of the stat cards
                so it reads as a peer affordance, not buried in a toolbar. */}
            <BrainOrb size={60} onClick={() => setExploreOpen(true)} />

            {/* notes this week */}
            <div style={{
              background: "#fff", border: "0.5px solid rgba(0,0,0,0.08)",
              borderRadius: 10, padding: "10px 14px",
              display: "flex", flexDirection: "column", alignItems: "flex-start",
              minWidth: 110,
            }}>
              <div style={{ fontSize: 11, color: "#8E8E93", letterSpacing: 0.3 }}>notes this week</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "#1C1C1E", marginTop: 1, lineHeight: 1.1 }}>
                {stats?.notes_this_week ?? "—"}
              </div>
              {stats && (() => {
                const delta = stats.notes_this_week - stats.notes_last_week;
                if (delta === 0 && stats.notes_last_week === 0) return null;
                const isUp = delta > 0;
                const isFlat = delta === 0;
                return (
                  <div style={{
                    fontSize: 10.5, color: isFlat ? "#AEAEB2" : isUp ? "#2B8C4D" : "#C76B6B",
                    marginTop: 2, fontVariantNumeric: "tabular-nums",
                  }}>
                    {isFlat ? "→" : isUp ? "↑" : "↓"} {Math.abs(delta)} from last week
                  </div>
                );
              })()}
            </div>

            {/* day streak */}
            <div style={{
              background: "#fff", border: "0.5px solid rgba(0,0,0,0.08)",
              borderRadius: 10, padding: "10px 14px",
              display: "flex", flexDirection: "column", alignItems: "flex-start",
              minWidth: 110,
            }}>
              <div style={{ fontSize: 11, color: "#8E8E93", letterSpacing: 0.3 }}>day streak</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "#1C1C1E", marginTop: 1, lineHeight: 1.1 }}>
                {stats?.streak ?? "—"}
              </div>
              <div style={{ display: "flex", gap: 2.5, marginTop: 4 }}>
                {activityPerDay.map((v, i) => (
                  <div
                    key={i}
                    style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: v > 0 ? GREEN : "rgba(0,0,0,0.08)",
                    }}
                  />
                ))}
              </div>
            </div>

          </div>
        </div>

        {/* Stale-focus check-in. Renders nothing if no focus is stale or
            today's nudge has been dismissed. Sits between greeting + note input
            so it lands in the eyeline without crowding the writing surface. */}
        <FocusCheckinCard />

        {/* Note input — swaps into a PlanAnimation when user clicks "plan"
            on a todo. Otherwise the normal embedded NoteEditor quick-input. */}
        <div style={{ marginBottom: 22 }}>
          {planning ? (
            <PlanWrapper
              title={planning.note.title ?? ""}
              noteId={planning.note.id}
              onSubmitted={() => {
                // After submit, clear planning state and refresh notes in
                // General so the new plan shows up in recent-notes lists.
                setPlanning(null);
                loadNotes("general");
              }}
              onContinue={handlePlanContinue}
              onCancel={handlePlanCancel}
            />
          ) : (
            <NoteEditor variant="embedded" onSubmitted={handleSubmitted} />
          )}
        </div>

        {/* Gooni's Take — green dot + uppercase label */}
        {take && (
          <div style={{
            background: "#fff",
            border: "0.5px solid rgba(0,0,0,0.08)",
            borderRadius: 12,
            padding: 16,
            marginBottom: 22,
            position: "relative",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: GREEN, flexShrink: 0 }} />
              <span style={{
                fontSize: 11, color: "#8E8E93", letterSpacing: 0.6,
                textTransform: "uppercase",
              }}>
                Gooni's Take
              </span>
            </div>
            <p style={{ fontSize: 13, color: "#3C3C43", lineHeight: 1.6, margin: 0, paddingRight: 24 }}>
              {take}
            </p>
            <button
              onClick={refreshTake}
              disabled={takeRefreshing}
              title="Regenerate"
              style={{
                position: "absolute", top: 10, right: 10,
                width: 22, height: 22, borderRadius: 6, border: "none",
                background: "transparent", color: "#8E8E93", cursor: takeRefreshing ? "default" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "background 0.1s, color 0.1s",
              }}
              onMouseEnter={(e) => { if (!takeRefreshing) { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.05)"; (e.currentTarget as HTMLButtonElement).style.color = "#3C3C43"; } }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; (e.currentTarget as HTMLButtonElement).style.color = "#8E8E93"; }}
            >
              <svg
                width="12" height="12" viewBox="0 0 16 16" fill="none"
                style={{ animation: takeRefreshing ? "gooni-spin 0.8s linear infinite" : undefined, opacity: takeRefreshing ? 0.6 : 1 }}
              >
                <path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9L13 3v3.5H9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                <path d="M13.5 8a5.5 5.5 0 0 1-9.4 3.9L3 13v-3.5h3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              </svg>
            </button>
          </div>
        )}

        {/* Focus card — long-running commitments. Above todos to frame the day. */}
        <FocusCard />

        {/* Suggestions — discovery + whimsy. Below focuses so it reads as a
            companion feed: 'here's what you're committed to, here's what
            else might catch your eye.' Hidden until ≥1 focus exists. */}
        <SuggestionsCard />

        {/* Todo card — backed by dedicated TodoItem model with timestamps + sort order */}
        <TodoCard todos={todos} onMutate={setTodos} onPlan={handlePlanFromTodo} />

        {/* Recent notes — two preview cards */}
        <div style={{ marginBottom: 44 }}>
          <div style={{
            fontSize: 12, color: "#8E8E93", letterSpacing: 0.6,
            textTransform: "uppercase", marginBottom: 10,
          }}>recent notes</div>
          {stats ? (
            stats.recent_notes.length === 0 ? (
              <p style={{ fontSize: 13.5, color: "#C7C7CC" }}>No notes yet.</p>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {stats.recent_notes.slice(0, 2).map((note, idx) => {
                  const fullTitle = note.title?.trim() || "Untitled";
                  const fullExcerpt = stripHtml(note.content ?? "");
                  const isFirst = idx === 0;
                  const isTyping = typing !== null && typing.noteId === note.id;
                  const revealed = isTyping ? typing!.revealed : Infinity;
                  const shownTitle = isTyping ? fullTitle.slice(0, Math.min(revealed, fullTitle.length)) : fullTitle;
                  const excerptBudget = isTyping ? Math.max(0, revealed - fullTitle.length) : Infinity;
                  const shownExcerpt = isTyping ? fullExcerpt.slice(0, excerptBudget) : fullExcerpt;
                  const caretInTitle = isTyping && revealed <= fullTitle.length;
                  const caretInExcerpt = isTyping && revealed > fullTitle.length;
                  return (
                    <div
                      key={note.id}
                      ref={isFirst ? firstCardRef : undefined}
                      onClick={() => openNote(note.space_id, note.id)}
                      style={{
                        // Use minHeight instead of fixed height so the card grows
                        // with its content up to the line-clamp ceiling. The grid
                        // row naturally stretches so both cards still match heights.
                        display: "flex", flexDirection: "column", alignItems: "stretch",
                        gap: 6, padding: "14px 16px", borderRadius: 12,
                        border: "1px solid rgba(0,0,0,0.07)", background: "#fff", cursor: "pointer",
                        textAlign: "left", width: "100%", minHeight: 160, boxSizing: "border-box",
                        transition: "background 0.12s, border-color 0.12s",
                        animation: isFirst && cardPulsing ? `gooni-card-pulse 0.6s cubic-bezier(0.22,1,0.36,1)` : undefined,
                      }}
                      onMouseEnter={(e) => {
                        const el = e.currentTarget;
                        el.style.borderColor = "rgba(0,0,0,0.15)";
                        el.style.background = "#FDFDFD";
                      }}
                      onMouseLeave={(e) => {
                        const el = e.currentTarget;
                        el.style.borderColor = "rgba(0,0,0,0.07)";
                        el.style.background = "#fff";
                      }}
                    >
                      <div style={{
                        fontSize: 14, fontWeight: 600, color: "#1C1C1E", fontFamily: FONT,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}>
                        {shownTitle || (isFirst && isTyping ? " " : "Untitled")}
                        {caretInTitle && <span className="gooni-caret">▍</span>}
                      </div>
                      <div
                        style={{
                          // NO `flex: 1` — that makes the div fill the remaining
                          // card height and breaks -webkit-line-clamp (you get
                          // mid-line clipping instead of a clean "…"). Without
                          // flex:1 the div is its intrinsic ~4-line height.
                          fontSize: 12.5, color: "#6C6C70", lineHeight: 1.5, fontFamily: FONT,
                          display: "-webkit-box",
                          WebkitLineClamp: 4,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          wordBreak: "break-word",
                        }}
                      >
                        {shownExcerpt || (isTyping ? "" : <span style={{ color: "#C7C7CC", fontStyle: "italic" }}>empty note</span>)}
                        {caretInExcerpt && <span className="gooni-caret">▍</span>}
                      </div>
                      {/* marginTop:auto pins the date to the bottom regardless of
                          how tall the excerpt ended up, so short-content cards
                          still show the timestamp at the card bottom. */}
                      <div style={{ fontSize: 11, color: "#AEAEB2", fontFamily: FONT, flexShrink: 0, marginTop: "auto" }}>
                        {formatNoteDate(note.updated_at)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            <p style={{ fontSize: 13.5, color: "#C7C7CC" }}>Loading…</p>
          )}
        </div>

      </div>

      {/* Mascot mounts at the route root now (see routes/index.tsx) so it
          appears on every view, not just the dashboard. */}

      {/* Semantic graph of all notes — opens as a full-screen modal */}
      <ExploreModal open={exploreOpen} onClose={() => setExploreOpen(false)} />
    </div>
  );
}
