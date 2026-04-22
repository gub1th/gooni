import { useState, useEffect, useRef } from "react";
import { fetchDashboardStats, fetchGooniTake, fetchPinnedNotes, updateNote, type ApiNote, type DashboardStats } from "../services/api";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { usePinnedVersionStore } from "../stores/usePinnedVersionStore";
import { useGooniThemeStore, THEME_PALETTES } from "../stores/useGooniThemeStore";
import { GooniMascot } from "./GooniMascot";
import { NoteEditor } from "./notes/NoteEditor";

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

interface TodoItem { text: string; checked: boolean }

function parseTodos(html: string): TodoItem[] {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const items = Array.from(doc.querySelectorAll('li[data-type="taskItem"]'));
    return items.map((el) => {
      const p = el.querySelector("p");
      const text = (p?.textContent ?? el.textContent ?? "").trim();
      const checked = el.getAttribute("data-checked") === "true";
      return { text, checked };
    });
  } catch {
    return [];
  }
}

function ensureTaskListDoc(html: string): { doc: Document; list: Element } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let list = doc.querySelector('ul[data-type="taskList"]');
  if (!list) {
    list = doc.createElement("ul");
    list.setAttribute("data-type", "taskList");
    doc.body.appendChild(list);
  }
  return { doc, list };
}

function toggleTodoHtml(html: string, idx: number): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const items = doc.querySelectorAll('li[data-type="taskItem"]');
  const el = items[idx];
  if (!el) return html;
  const cur = el.getAttribute("data-checked") === "true";
  el.setAttribute("data-checked", cur ? "false" : "true");
  const input = el.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  if (input) input.checked = !cur;
  return doc.body.innerHTML;
}

function addTodoHtml(html: string, text: string): string {
  const { doc, list } = ensureTaskListDoc(html);
  const li = doc.createElement("li");
  li.setAttribute("data-type", "taskItem");
  li.setAttribute("data-checked", "false");

  // TipTap task-item DOM: label>input+span, then div>p
  const label = doc.createElement("label");
  const input = doc.createElement("input");
  input.setAttribute("type", "checkbox");
  const labelSpan = doc.createElement("span");
  label.appendChild(input);
  label.appendChild(labelSpan);

  const contentDiv = doc.createElement("div");
  const p = doc.createElement("p");
  p.textContent = text;
  contentDiv.appendChild(p);

  li.appendChild(label);
  li.appendChild(contentDiv);
  list.appendChild(li);
  return doc.body.innerHTML;
}

function deleteTodoHtml(html: string, idx: number): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const items = doc.querySelectorAll('li[data-type="taskItem"]');
  items[idx]?.remove();
  return doc.body.innerHTML;
}

function reorderTodoHtml(html: string, fromIdx: number, toIdx: number): string {
  if (fromIdx === toIdx) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const items = Array.from(doc.querySelectorAll('li[data-type="taskItem"]'));
  const from = items[fromIdx];
  const to = items[toIdx];
  if (!from || !to) return html;
  if (fromIdx < toIdx) {
    to.parentNode?.insertBefore(from, to.nextSibling);
  } else {
    to.parentNode?.insertBefore(from, to);
  }
  return doc.body.innerHTML;
}

function editTodoHtml(html: string, idx: number, newText: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const items = doc.querySelectorAll('li[data-type="taskItem"]');
  const el = items[idx];
  if (!el) return html;
  const p = el.querySelector("p");
  if (p) {
    p.textContent = newText;
  } else {
    // Fallback: stuff text into a fresh <p> inside a wrapper div
    const div = doc.createElement("div");
    const newP = doc.createElement("p");
    newP.textContent = newText;
    div.appendChild(newP);
    // Preserve label element; replace anything after it with the new div
    const label = el.querySelector("label");
    el.innerHTML = "";
    if (label) el.appendChild(label);
    el.appendChild(div);
  }
  return doc.body.innerHTML;
}

interface TodoCardProps {
  todoNote: ApiNote | null;
  onAfterMutate: (updated: ApiNote) => void;
}

function TodoCard({ todoNote, onAfterMutate }: TodoCardProps) {
  // Local HTML is the source of truth for rendering — allows optimistic updates
  // (click feels instant; server save runs in background).
  const [localHtml, setLocalHtml] = useState<string>(todoNote?.content ?? "");
  const [newText, setNewText] = useState("");
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const [rowHoverIdx, setRowHoverIdx] = useState<number | null>(null);

  // Re-sync when the source note changes externally (e.g., edited in the full editor).
  useEffect(() => {
    setLocalHtml(todoNote?.content ?? "");
  }, [todoNote?.content]);

  if (!todoNote) return null;
  const items = parseTodos(localHtml);

  async function persist(newHtml: string) {
    const prev = localHtml;
    setLocalHtml(newHtml);
    try {
      await updateNote(todoNote!.id, todoNote!.title ?? "", newHtml);
      onAfterMutate({ ...todoNote!, content: newHtml });
    } catch (e) {
      console.error("todo persist failed — rolling back", e);
      setLocalHtml(prev);
    }
  }

  const toggle = (i: number) => persist(toggleTodoHtml(localHtml, i));
  const del = (i: number) => persist(deleteTodoHtml(localHtml, i));
  const reorder = (from: number, to: number) => persist(reorderTodoHtml(localHtml, from, to));

  function startEdit(i: number, text: string) {
    setEditingIdx(i);
    setEditingText(text);
  }

  function cancelEdit() {
    setEditingIdx(null);
    setEditingText("");
  }

  function commitEdit() {
    const i = editingIdx;
    if (i === null) return;
    const next = editingText.trim();
    const prev = items[i]?.text ?? "";
    setEditingIdx(null);
    setEditingText("");
    if (!next) {
      // Emptying an item on commit deletes it — matches Apple Reminders behavior
      persist(deleteTodoHtml(localHtml, i));
    } else if (next !== prev) {
      persist(editTodoHtml(localHtml, i, next));
    }
  }

  function handleAdd() {
    const t = newText.trim();
    if (!t) return;
    persist(addTodoHtml(localHtml, t));
    setNewText("");
  }

  const showEmpty = items.length === 0;

  return (
    <div style={{
      background: "#fff",
      border: "0.5px solid rgba(0,0,0,0.08)",
      borderRadius: 12,
      padding: 16,
      marginBottom: 22,
      fontFamily: FONT,
    }}>
      <div style={{
        fontSize: 11,
        color: "#8E8E93",
        letterSpacing: 0.6,
        textTransform: "uppercase",
        marginBottom: 12,
      }}>today</div>

      {showEmpty && (
        <div style={{ fontSize: 13, color: "#C7C7CC", padding: "4px 0 2px" }}>
          Nothing here yet — add your first todo below.
        </div>
      )}

      {items.map((it, i) => {
        const isDragging = dragIdx === i;
        const isHover = hoverIdx === i && dragIdx !== null && dragIdx !== i;
        const isEditing = editingIdx === i;
        return (
          <div
            key={i}
            draggable={!isEditing}
            onDragStart={(e) => {
              if (isEditing) { e.preventDefault(); return; }
              setDragIdx(i);
              e.dataTransfer.effectAllowed = "move";
              try { e.dataTransfer.setData("text/plain", it.text); } catch {}
            }}
            onDragEnd={() => { setDragIdx(null); setHoverIdx(null); }}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragIdx !== null && dragIdx !== i) setHoverIdx(i);
            }}
            onDragLeave={() => { if (hoverIdx === i) setHoverIdx(null); }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIdx !== null && dragIdx !== i) reorder(dragIdx, i);
              setDragIdx(null);
              setHoverIdx(null);
            }}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 8px",
              marginLeft: -8, marginRight: -8,
              borderRadius: 6,
              borderBottom: i === items.length - 1 ? "none" : "0.5px solid rgba(0,0,0,0.07)",
              opacity: isDragging ? 0.35 : 1,
              background: isHover
                ? "rgba(255,196,82,0.15)"
                : rowHoverIdx === i
                ? "rgba(0,0,0,0.035)"
                : "transparent",
              transition: "background 0.12s",
              cursor: "default",
            }}
            onMouseEnter={(e) => {
              setRowHoverIdx(i);
              (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLElement>(".todo-hover").forEach(el => el.style.opacity = "1");
            }}
            onMouseLeave={(e) => {
              setRowHoverIdx((cur) => (cur === i ? null : cur));
              (e.currentTarget as HTMLDivElement).querySelectorAll<HTMLElement>(".todo-hover").forEach(el => el.style.opacity = "0");
            }}
          >
            {/* Drag handle — visible on hover */}
            <span
              className="todo-hover"
              title="Drag to reorder"
              style={{
                opacity: 0,
                cursor: "grab",
                color: "#C7C7CC",
                fontSize: 14,
                lineHeight: 1,
                padding: "0 2px",
                transition: "opacity 0.12s",
                userSelect: "none",
                flexShrink: 0,
              }}
            >⋮⋮</span>

            <button
              onClick={() => toggle(i)}
              aria-label={it.checked ? "Uncheck" : "Check"}
              style={{
                width: 16, height: 16, borderRadius: "50%",
                border: it.checked ? `1.5px solid ${GREEN}` : "1.5px solid rgba(0,0,0,0.18)",
                background: it.checked ? GREEN : "transparent",
                cursor: "pointer",
                padding: 0, flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "background 0.15s, border-color 0.15s",
              }}
            >
              {it.checked && (
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
                  flex: 1,
                  fontSize: 13,
                  fontFamily: FONT,
                  color: "#1C1C1E",
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  padding: 0,
                  lineHeight: 1.5,
                  minWidth: 0,
                }}
              />
            ) : (
              <span
                onClick={() => startEdit(i, it.text)}
                style={{
                  flex: 1,
                  fontSize: 13,
                  color: it.checked ? "#AEAEB2" : "#1C1C1E",
                  textDecoration: it.checked ? "line-through" : "none",
                  lineHeight: 1.5,
                  cursor: "text",
                  // Kill the default "drag ghost" feel on a text span when its row is draggable
                  userSelect: "text",
                }}
              >{it.text}</span>
            )}

            {/* Delete — visible on hover */}
            <button
              className="todo-hover"
              onClick={(e) => { e.stopPropagation(); del(i); }}
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
          </div>
        );
      })}

      {/* Add input — always at bottom, Enter to commit. Pointer-tracking glow on hover. */}
      <div
        className="gooni-todo-add"
        style={{
          position: "relative",
          display: "flex", alignItems: "center", gap: 8,
          marginTop: items.length > 0 ? 8 : 0,
          // Taller padding so vertical pointer travel is perceptible — the glow follows Y, and
          // a too-short row made the movement feel stuck horizontally.
          paddingTop: items.length > 0 ? 16 : 12,
          paddingBottom: 14,
          paddingLeft: 8, paddingRight: 8,
          marginLeft: -8, marginRight: -8,
          borderTop: items.length > 0 ? "0.5px solid rgba(0,0,0,0.07)" : "none",
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
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); handleAdd(); }
          }}
          placeholder="add a todo"
          style={{
            flex: 1,
            fontSize: 13,
            fontFamily: FONT,
            border: "none",
            outline: "none",
            background: "transparent",
            color: "#1C1C1E",
            padding: "4px 0",
            position: "relative", zIndex: 1,
          }}
        />
      </div>
    </div>
  );
}

// ── Dashboard ──────────────────────────────────────────────────────────────────
// The dashboard itself:

export function Dashboard({ onOpenNote }: { onOpenNote: () => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [take, setTake] = useState<string>("");
  const [takeRefreshing, setTakeRefreshing] = useState(false);
  const [pinnedNotes, setPinnedNotes] = useState<ApiNote[]>([]);
  const [ink, setInk] = useState<InkState | null>(null);
  const [rowPulsing, setRowPulsing] = useState(false);
  const [typing, setTyping] = useState<{ noteId: number; revealed: number; total: number } | null>(null);
  const typingRaf = useRef<number | null>(null);
  const { selectSpace, loadNotes, selectNote } = useNotesContentStore();
  const pinnedVersion = usePinnedVersionStore((s) => s.version);
  const theme = useGooniThemeStore((s) => s.theme);
  const palette = THEME_PALETTES[theme];
  const firstRowRef = useRef<HTMLDivElement>(null);
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
  }, []);

  // Pinned list refetches on every pin/unpin (across the app)
  useEffect(() => {
    fetchPinnedNotes().then(setPinnedNotes).catch(() => {});
  }, [pinnedVersion]);

  // Find the first pinned note that contains a TipTap task list — that becomes the dashboard todo widget.
  const todoNote = pinnedNotes.find((n) => (n.content ?? "").includes('data-type="taskList"')) ?? null;

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

  async function handleSubmitted(_note: ApiNote | null, buttonRect: DOMRect | null) {
    const target = firstRowRef.current?.getBoundingClientRect() ?? null;
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
        @keyframes gooni-row-pulse {
          0%   { background: transparent; }
          30%  { background: rgba(74,222,128,0.08); }
          100% { background: transparent; }
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
        /* Subtle scrollbar for recent notes — invisible until interaction */
        .gooni-recent-scroll { scrollbar-width: thin; scrollbar-color: transparent transparent; }
        .gooni-recent-scroll:hover { scrollbar-color: rgba(0,0,0,0.15) transparent; }
        .gooni-recent-scroll::-webkit-scrollbar { width: 6px; }
        .gooni-recent-scroll::-webkit-scrollbar-track { background: transparent; }
        .gooni-recent-scroll::-webkit-scrollbar-thumb {
          background: transparent;
          border-radius: 3px;
          transition: background 0.2s;
        }
        .gooni-recent-scroll:hover::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); }
        .gooni-recent-scroll::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.3); }
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
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
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

        {/* Note input — NoteEditor's embedded variant owns the bordered shell + ink animation */}
        <div style={{ marginBottom: 22 }}>
          <NoteEditor variant="embedded" onSubmitted={handleSubmitted} />
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

        {/* Todo card — wired to the first pinned task-list note */}
        <TodoCard
          todoNote={todoNote}
          onAfterMutate={(updated) => {
            setPinnedNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
          }}
        />

        {/* Recent notes — simple rows with dividers, no cards. Scrollable after ~5 rows. */}
        <div>
          <div style={{
            fontSize: 12, color: "#8E8E93", letterSpacing: 0.6,
            textTransform: "uppercase", marginBottom: 8,
          }}>recent notes</div>
          {stats ? (() => {
            // Hide the todo-widget note from Recent — it gets edited daily, so it'd otherwise squat at the top
            // and push out actually-recent work.
            const visibleRecent = stats.recent_notes.filter((n) => n.id !== todoNote?.id);
            return visibleRecent.length === 0 ? (
              <p style={{ fontSize: 13, color: "#C7C7CC" }}>No notes yet.</p>
            ) : (
              <div
                className="gooni-recent-scroll"
                style={{
                  maxHeight: 5 * 56,
                  overflowY: "auto",
                  // pad the right so scrollbar doesn't overlap content when it appears
                  paddingRight: 6,
                  marginRight: -6,
                }}
              >
                {visibleRecent.map((note, idx) => {
                  const isFirst = idx === 0;
                  const plain = stripHtml(note.content ?? "");
                  const trimmedTitle = note.title?.trim() ?? "";
                  let title: string;
                  let preview: string;
                  if (trimmedTitle) {
                    title = trimmedTitle;
                    preview = plain.slice(0, 80);
                  } else if (plain) {
                    const br = plain.search(/[\n\r]/);
                    title = plain.slice(0, br > 0 ? br : 60).trim() || "Untitled";
                    preview = plain.slice(title.length).trim().slice(0, 80);
                  } else {
                    title = "Untitled";
                    preview = "";
                  }
                  const isTyping = typing !== null && typing.noteId === note.id;
                  const revealed = isTyping ? typing!.revealed : Infinity;
                  const shownTitle = isTyping ? title.slice(0, Math.min(revealed, title.length)) : title;
                  const excerptBudget = isTyping ? Math.max(0, revealed - title.length) : Infinity;
                  const shownPreview = isTyping ? preview.slice(0, excerptBudget) : preview;
                  const caretInTitle = isTyping && revealed <= title.length;
                  const caretInPreview = isTyping && revealed > title.length;
                  return (
                    <div
                      key={note.id}
                      ref={isFirst ? firstRowRef : undefined}
                      onClick={() => openNote(note.space_id, note.id)}
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        justifyContent: "space-between",
                        gap: 12,
                        padding: "10px 0",
                        borderBottom: "0.5px solid rgba(0,0,0,0.07)",
                        cursor: "pointer",
                        animation: isFirst && rowPulsing ? "gooni-row-pulse 0.7s ease-out" : undefined,
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{
                          fontSize: 13, color: "#1C1C1E",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>
                          {shownTitle || " "}
                          {caretInTitle && <span className="gooni-caret">▍</span>}
                        </div>
                        {(preview || isTyping) && (
                          <div style={{
                            fontSize: 12, color: "#8E8E93", marginTop: 1,
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          }}>
                            {shownPreview}
                            {caretInPreview && <span className="gooni-caret">▍</span>}
                          </div>
                        )}
                      </div>
                      <span style={{ fontSize: 11, color: "#AEAEB2", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                        {formatNoteDate(note.updated_at)}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })() : (
            <p style={{ fontSize: 13, color: "#C7C7CC" }}>Loading…</p>
          )}
        </div>

      </div>

      {/* Interactive mascot — peeks from sidebar seam, drag-to-toss, walks with perspective */}
      <GooniMascot dashboardRef={dashRef} />
    </div>
  );
}
