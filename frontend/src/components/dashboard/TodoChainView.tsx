import { useEffect, useMemo, useRef, useState } from "react";
import { X, GitBranch, Plus, Search } from "lucide-react";
import { FONT, z } from "../../ui";
import {
  fetchTodoChain,
  searchTodos,
  linkTodoParent,
  unlinkTodoParent,
  createTodo,
  updateTodo,
  type ApiTodo,
  type TodoChain,
  type TodoChainNode,
} from "../../services/api";

// TodoChainView — slice 2 + 4 rewrite. Vertical thread timeline w/
// collapsed-done tail, inline-edit titles + closure_note, side-by-side
// spawned siblings, and retroactive-link affordance w/ a "create new as
// parent" fallback when no existing match fits.
//
// Layout (top → bottom):
//   1. Header — "Thread" + meta (N closed · N open · started DATE)
//   2. Collapsed-tail pill — only when ancestors w/ depth ≥ 2 exist;
//      shows count + truncated text peek. Click expands to a flat list.
//   3. Immediate predecessor (depth-1 ancestor) — full card w/ inline-
//      editable title + closure_note. Multi-parent (convergence) renders
//      each predecessor as a side-by-side card.
//   4. Focus node — the activeId. Same edit affordances; highlighted.
//   5. ↗ spawned N next steps — label only when there are direct children.
//   6. Direct children — side-by-side cards. Open children get a
//      "mark done" quick-action; done children are muted.
//   7. "+ add next step" input — Enter creates a todo + wires it as a
//      spawned_from child of the focus node.
//
// Retroactive linking (slice 4): when no parents exist, the link-parent
// affordance opens an inline search. Results include matches + a
// "create '<query>' as parent" row at the bottom that creates a fresh
// todo and wires it as parent in one motion.


interface Props {
  todoId: number;
  onClose: () => void;
  // Optional: refetch the parent dashboard when chain mutations happen
  // (link / unlink / new spawn). Lets the caller invalidate todos-bundle
  // so the indicators in the list update without a full page refresh.
  onMutate?: () => void;
}

export function TodoChainView({ todoId, onClose, onMutate }: Props) {
  const [chain, setChain] = useState<TodoChain | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState(todoId);

  // Collapsed-tail expansion. Default collapsed.
  const [tailExpanded, setTailExpanded] = useState(false);

  // Retroactive-link state.
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkQuery, setLinkQuery] = useState("");
  const [linkResults, setLinkResults] = useState<ApiTodo[]>([]);
  const [linkSearching, setLinkSearching] = useState(false);

  // "+ add next step" input draft.
  const [addDraft, setAddDraft] = useState("");

  async function refetchChain(target: number = activeId) {
    setLoading(true);
    try {
      const fresh = await fetchTodoChain(target, 10);
      setChain(fresh);
    } catch (e) { console.error("chain fetch failed", e); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTodoChain(activeId, 10)
      .then((c) => { if (!cancelled) setChain(c); })
      .catch((e) => console.error("chain fetch failed", e))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeId]);

  // Debounced search for retroactive linking.
  useEffect(() => {
    if (!linkOpen || !linkQuery.trim()) {
      setLinkResults([]);
      return;
    }
    const handle = window.setTimeout(async () => {
      setLinkSearching(true);
      try {
        const { matches } = await searchTodos(linkQuery, 8, true);
        setLinkResults(matches.filter((m) => m.id !== activeId));
      } catch (e) { console.error("search failed", e); }
      finally { setLinkSearching(false); }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [linkQuery, linkOpen, activeId]);

  async function onPickExistingAsParent(parent: ApiTodo) {
    try {
      await linkTodoParent(activeId, parent.id);
      setLinkOpen(false); setLinkQuery(""); setLinkResults([]);
      await refetchChain();
      onMutate?.();
    } catch (e) { console.error("link parent failed", e); }
  }

  // Slice 4 — create-new-as-parent. Composes createTodo + linkTodoParent
  // in two calls so the backend stays untouched. Best-effort: a partial
  // failure (parent created but link failed) leaves an orphan todo
  // visible in the main list — Daniel can re-link manually.
  async function onCreateAndLinkAsParent(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const created = await createTodo({ text: trimmed });
      await linkTodoParent(activeId, created.id);
      setLinkOpen(false); setLinkQuery(""); setLinkResults([]);
      await refetchChain();
      onMutate?.();
    } catch (e) { console.error("create+link parent failed", e); }
  }

  async function onUnlinkParent(parentId: number) {
    try {
      await unlinkTodoParent(activeId, parentId);
      await refetchChain();
      onMutate?.();
    } catch (e) { console.error("unlink failed", e); }
  }

  async function onAddNextStep() {
    const text = addDraft.trim();
    if (!text) return;
    try {
      const created = await createTodo({ text });
      // Wire created as a child of the focus node — i.e. the new todo's
      // parent is activeId.
      await linkTodoParent(created.id, activeId);
      setAddDraft("");
      await refetchChain();
      onMutate?.();
    } catch (e) { console.error("add next step failed", e); }
  }

  async function onMarkChildDone(childId: number) {
    try {
      await updateTodo(childId, { state: "done" });
      await refetchChain();
      onMutate?.();
    } catch (e) { console.error("mark done failed", e); }
  }

  async function onRenameTodo(id: number, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      await updateTodo(id, { text: trimmed });
      // Optimistic — refetch ensures multi-node consistency.
      await refetchChain();
      onMutate?.();
    } catch (e) { console.error("rename failed", e); }
  }

  async function onEditClosureNote(id: number, note: string) {
    // closure_note flows through PATCH /todos/{id}. Empty string clears
    // the note (the backend setattrs raw, so empty → "" in column —
    // FE renders it the same as null on next fetch).
    try {
      await updateTodo(id, { closure_note: note.trim() || null });
      await refetchChain();
      onMutate?.();
    } catch (e) { console.error("edit closure_note failed", e); }
  }

  // Backdrop click closes.
  function onBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  // ── Layout slicing ────────────────────────────────────────────────

  const directParents = useMemo<TodoChainNode[]>(
    () => (chain ? chain.ancestors.filter((a) => a.depth === 1) : []),
    [chain],
  );
  const deeperAncestors = useMemo<TodoChainNode[]>(
    () => (chain ? chain.ancestors.filter((a) => a.depth >= 2) : []),
    [chain],
  );
  const directChildren = useMemo<TodoChainNode[]>(
    () => (chain ? chain.descendants.filter((d) => d.depth === 1) : []),
    [chain],
  );

  // Meta line: count closed + open across the whole chain (this + all
  // ancestors + all descendants). "started" = earliest created_at.
  const meta = useMemo(() => {
    if (!chain) return null;
    const all: ApiTodo[] = [chain.this, ...chain.ancestors.map((a) => a.todo), ...chain.descendants.map((d) => d.todo)];
    const closed = all.filter((t) => t.state === "done").length;
    const open = all.length - closed;
    const startedISO = all
      .map((t) => t.created_at)
      .filter((s): s is string => !!s)
      .sort()[0] ?? null;
    return { closed, open, startedISO };
  }, [chain]);

  return (
    <div
      onClick={onBackdropClick}
      style={{
        position: "fixed", inset: 0, zIndex: z.modalScrim,
        background: "rgba(28,20,12,0.45)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        paddingTop: 60, fontFamily: FONT,
      }}
    >
      <div
        style={{
          background: "var(--gooni-card, #FFFCF3)",
          border: "0.5px solid rgba(155,130,70,0.20)",
          borderRadius: 14,
          width: "min(620px, 92vw)",
          maxHeight: "82vh",
          overflow: "auto",
          padding: "22px 26px 24px",
          boxShadow: "0 24px 60px rgba(74,69,56,0.28)",
          color: "var(--gooni-text, #2A2620)",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "flex-start", justifyContent: "space-between",
          marginBottom: 18,
        }}>
          <div>
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              fontSize: 15, fontWeight: 500,
              fontFamily: "Georgia, 'Times New Roman', serif",
              color: "var(--gooni-text, #2A2620)",
            }}>
              <GitBranch size={14} style={{ color: "#8A8270" }} />
              Thread
            </div>
            {meta && (
              <div style={{ fontSize: 11, color: "#8A8270", marginTop: 4 }}>
                {meta.closed} closed · {meta.open} open
                {meta.startedISO && (
                  <> · started {fmtShortDate(meta.startedISO)}</>
                )}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="close"
            style={{
              background: "none", border: "none",
              cursor: "pointer", padding: 6,
              color: "#A89D80",
            }}
          >
            <X size={15} />
          </button>
        </div>

        {loading && (
          <div style={{ opacity: 0.5, fontSize: 13, padding: "20px 4px" }}>
            loading chain…
          </div>
        )}

        {!loading && chain && (
          <div style={{ position: "relative", paddingLeft: 22 }}>
            {/* Vertical spine line */}
            <div style={{
              position: "absolute", left: 7, top: 14, bottom: 60,
              width: 1.5, background: "rgba(155,130,70,0.25)",
            }} />

            {/* Collapsed tail (depth ≥ 2 ancestors) */}
            {deeperAncestors.length > 0 && (
              <CollapsedTailPill
                ancestors={deeperAncestors}
                expanded={tailExpanded}
                onToggle={() => setTailExpanded((v) => !v)}
                onRecenter={(id) => setActiveId(id)}
              />
            )}

            {/* Immediate predecessor(s) */}
            {directParents.length > 0 ? (
              directParents.map((p) => (
                <PredecessorCard
                  key={p.todo.id}
                  todo={p.todo}
                  onRecenter={() => setActiveId(p.todo.id)}
                  onRename={(text) => onRenameTodo(p.todo.id, text)}
                  onEditNote={(note) => onEditClosureNote(p.todo.id, note)}
                  onUnlink={directParents.length === 1 ? () => onUnlinkParent(p.todo.id) : undefined}
                />
              ))
            ) : (
              <ParentLinkAffordance
                open={linkOpen}
                query={linkQuery}
                results={linkResults}
                searching={linkSearching}
                onActivate={() => setLinkOpen(true)}
                onCancel={() => { setLinkOpen(false); setLinkQuery(""); setLinkResults([]); }}
                onQueryChange={setLinkQuery}
                onPickExisting={onPickExistingAsParent}
                onCreateNew={(text) => onCreateAndLinkAsParent(text)}
              />
            )}

            {/* Focus node */}
            <FocusCard
              todo={chain.this}
              onRename={(text) => onRenameTodo(chain.this.id, text)}
              onEditNote={(note) => onEditClosureNote(chain.this.id, note)}
            />

            {/* Spawned siblings */}
            {directChildren.length > 0 && (
              <>
                <div style={{
                  marginLeft: -18, marginBottom: 8, marginTop: 4,
                  fontSize: 11, color: "#8A8270",
                  letterSpacing: 0.02,
                }}>
                  ↗ spawned {directChildren.length} next step{directChildren.length === 1 ? "" : "s"}
                </div>
                <ChildrenRow
                  children={directChildren}
                  onRecenter={(id) => setActiveId(id)}
                  onMarkDone={onMarkChildDone}
                  onRename={(id, text) => onRenameTodo(id, text)}
                />
              </>
            )}

            {/* Add next step */}
            <div style={{
              marginLeft: 0, marginTop: 14, paddingTop: 12,
              borderTop: "0.5px dashed rgba(155,130,70,0.25)",
              display: "flex", alignItems: "center", gap: 8,
            }}>
              <Plus size={12} color="#8A8270" />
              <input
                value={addDraft}
                onChange={(e) => setAddDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void onAddNextStep();
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    void onAddNextStep();
                  }
                }}
                placeholder="add next step…"
                style={{
                  flex: 1, fontSize: 12, border: "none",
                  padding: "2px 0", background: "transparent",
                  color: "var(--gooni-text, #4A4538)",
                  outline: "none", fontFamily: FONT,
                }}
              />
              <span style={{ fontSize: 10, color: "#A89D80" }}>⌘↵</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

function fmtShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }).toLowerCase();
}

function CollapsedTailPill({
  ancestors, expanded, onToggle, onRecenter,
}: {
  ancestors: TodoChainNode[];
  expanded: boolean;
  onToggle: () => void;
  onRecenter: (id: number) => void;
}) {
  const peek = ancestors
    .slice(0, 2)
    .map((a) => trimText(a.todo.text, 24))
    .join(", ");
  return (
    <div style={{ position: "relative", marginBottom: 14 }}>
      <div style={{
        position: "absolute", left: -15, top: 6,
        width: 9, height: 9, borderRadius: "50%",
        background: "rgba(155,130,70,0.55)",
      }} />
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "4px 11px",
          background: "rgba(243,238,220,0.55)",
          borderRadius: 99,
          border: "0.5px solid rgba(155,130,70,0.20)",
          cursor: "pointer",
          fontSize: 11, color: "#6B6557",
          fontFamily: FONT,
        }}
      >
        <span style={{ color: "#8A8270" }}>{expanded ? "▾" : "▸"}</span>
        {ancestors.length} earlier step{ancestors.length === 1 ? "" : "s"}
        {!expanded && peek && (
          <>
            <span style={{ color: "#A89D80" }}>·</span>
            <span style={{ color: "#A89D80", fontStyle: "italic" }}>{peek}</span>
          </>
        )}
      </button>
      {expanded && (
        <div style={{
          marginTop: 8, marginLeft: 4,
          display: "flex", flexDirection: "column", gap: 3,
        }}>
          {ancestors.map((a) => (
            <button
              key={a.todo.id}
              type="button"
              onClick={() => onRecenter(a.todo.id)}
              style={{
                textAlign: "left",
                padding: "5px 9px",
                border: "0.5px solid rgba(155,130,70,0.15)",
                borderRadius: 6,
                background: "transparent",
                cursor: "pointer",
                fontSize: 12,
                color: "#6B6557",
                opacity: a.todo.state === "done" ? 0.55 : 1,
                textDecoration: a.todo.state === "done" ? "line-through" : "none",
                fontFamily: FONT,
              }}
            >
              {a.todo.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PredecessorCard({
  todo, onRecenter, onRename, onEditNote, onUnlink,
}: {
  todo: ApiTodo;
  onRecenter: () => void;
  onRename: (text: string) => void;
  onEditNote: (note: string) => void;
  onUnlink?: () => void;
}) {
  const done = todo.state === "done";
  return (
    <div style={{ position: "relative", marginBottom: 20 }}>
      <div style={{
        position: "absolute", left: -15, top: 9,
        width: 9, height: 9, borderRadius: "50%",
        background: "rgba(155,130,70,0.55)",
      }} />
      <div style={{
        padding: "13px 15px",
        border: "0.5px solid rgba(155,130,70,0.18)",
        borderRadius: 10,
        background: "var(--gooni-card, #FFFCF3)",
        position: "relative",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <EditableText
            value={todo.text}
            onCommit={onRename}
            style={{
              fontSize: 14,
              color: done ? "#4A4538" : "var(--gooni-text, #2A2620)",
              textDecoration: done ? "line-through" : "none",
              flex: 1,
            }}
          />
          {done && (
            <span style={{
              fontSize: 10, color: "#5A3E0A",
              background: "#F1E2BE",
              padding: "2px 7px", borderRadius: 99,
              flexShrink: 0,
            }}>closed</span>
          )}
          <button
            type="button"
            onClick={onRecenter}
            aria-label="focus on this node"
            title="focus on this node"
            style={{
              border: "none", background: "transparent",
              cursor: "pointer", color: "#A89D80", padding: 2,
              display: "flex",
            }}
          >
            <GitBranch size={12} />
          </button>
          {onUnlink && (
            <button
              type="button"
              onClick={onUnlink}
              aria-label="unlink parent"
              title="unlink as parent"
              style={{
                border: "none", background: "transparent",
                cursor: "pointer", color: "#A89D80", padding: 2,
                display: "flex",
              }}
            >
              <X size={12} />
            </button>
          )}
        </div>
        {todo.created_at && (
          <div style={{ fontSize: 11, color: "#8A8270", marginBottom: 8 }}>
            {fmtShortDate(todo.created_at)}
            {done && todo.completed_at && <> → {fmtShortDate(todo.completed_at)}</>}
          </div>
        )}
        <EditableNote
          value={todo.closure_note ?? ""}
          onCommit={onEditNote}
          placeholder={done ? "add a note about how this closed…" : ""}
        />
      </div>
    </div>
  );
}

function FocusCard({
  todo, onRename, onEditNote,
}: {
  todo: ApiTodo;
  onRename: (text: string) => void;
  onEditNote: (note: string) => void;
}) {
  const done = todo.state === "done";
  const doing = todo.state === "doing";
  return (
    <div style={{ position: "relative", marginBottom: 16 }}>
      <div style={{
        position: "absolute", left: -16, top: 11,
        width: 11, height: 11, borderRadius: "50%",
        background: doing ? "transparent" : (done ? "rgba(155,130,70,0.55)" : "#FFFCF3"),
        border: doing ? "2px solid #C9772E" : (done ? "none" : "1.5px solid rgba(155,130,70,0.55)"),
        boxShadow: doing ? "0 0 0 2px rgba(201,119,46,0.18)" : undefined,
      }} />
      <div style={{
        padding: "14px 16px",
        border: "1px solid rgba(201,119,46,0.45)",
        borderRadius: 11,
        background: "var(--gooni-card, #FFFCF3)",
        boxShadow: "0 2px 6px rgba(201,119,46,0.10)",
      }}>
        <EditableText
          value={todo.text}
          onCommit={onRename}
          style={{
            fontSize: 15, fontWeight: 500,
            color: "var(--gooni-text, #2A2620)",
            textDecoration: done ? "line-through" : "none",
          }}
        />
        {todo.created_at && (
          <div style={{ fontSize: 11, color: "#8A8270", marginTop: 4 }}>
            {fmtShortDate(todo.created_at)} · {done ? "closed" : (doing ? "doing" : "open")}
          </div>
        )}
        <div style={{ marginTop: 10 }}>
          <EditableNote
            value={todo.closure_note ?? ""}
            onCommit={onEditNote}
            placeholder={done ? "add an outcome note…" : "note (closure outcome)…"}
          />
        </div>
      </div>
    </div>
  );
}

function ChildrenRow({
  children, onRecenter, onMarkDone, onRename,
}: {
  children: TodoChainNode[];
  onRecenter: (id: number) => void;
  onMarkDone: (id: number) => void;
  onRename: (id: number, text: string) => void;
}) {
  // Side-by-side up to 3. 4+ collapses to vertical stack (still inline-
  // editable, just stacked).
  const multiCol = children.length <= 3;
  return (
    <div style={{
      display: "flex",
      gap: 10,
      marginBottom: 4,
      flexDirection: multiCol ? "row" : "column",
      flexWrap: multiCol ? "wrap" : "nowrap",
    }}>
      {children.map((c) => (
        <ChildCard
          key={c.todo.id}
          todo={c.todo}
          onRecenter={() => onRecenter(c.todo.id)}
          onMarkDone={() => onMarkDone(c.todo.id)}
          onRename={(text) => onRename(c.todo.id, text)}
          stretch={multiCol}
        />
      ))}
    </div>
  );
}

function ChildCard({
  todo, onRecenter, onMarkDone, onRename, stretch,
}: {
  todo: ApiTodo;
  onRecenter: () => void;
  onMarkDone: () => void;
  onRename: (text: string) => void;
  stretch: boolean;
}) {
  const done = todo.state === "done";
  const doing = todo.state === "doing";
  return (
    <div style={{
      flex: stretch ? "1 1 0" : undefined,
      minWidth: stretch ? 0 : undefined,
      position: "relative",
    }}>
      <div style={{
        position: "absolute", left: -15, top: 11,
        width: 7, height: 7, borderRadius: "50%",
        background: done ? "rgba(155,130,70,0.55)" : "#FFFCF3",
        border: done ? "none" : "2px solid rgba(201,119,46,0.55)",
      }} />
      <div style={{
        padding: "10px 12px",
        background: done ? "rgba(243,238,220,0.55)" : "var(--gooni-card, #FFFCF3)",
        border: done ? "0.5px solid transparent" : "0.5px solid rgba(155,130,70,0.25)",
        borderRadius: 9,
        boxShadow: doing ? "0 1px 3px rgba(201,119,46,0.10)" : undefined,
        opacity: done ? 0.7 : 1,
      }}>
        <EditableText
          value={todo.text}
          onCommit={onRename}
          style={{
            fontSize: 13,
            fontWeight: done ? 400 : 500,
            color: done ? "#6B6557" : "var(--gooni-text, #2A2620)",
            textDecoration: done ? "line-through" : "none",
          }}
        />
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          marginTop: 6,
        }}>
          <span style={{ fontSize: 10, color: "#8A8270" }}>
            {done ? "done" : (doing ? "doing" : "open")}
          </span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {!done && (
              <button
                type="button"
                onClick={onMarkDone}
                style={{
                  fontSize: 10, color: "#085041",
                  background: "#E1F5EE",
                  padding: "2px 8px", borderRadius: 99,
                  border: "none", cursor: "pointer",
                  fontWeight: 500, fontFamily: FONT,
                }}
              >mark done</button>
            )}
            <button
              type="button"
              onClick={onRecenter}
              aria-label="focus on this"
              title="focus on this node"
              style={{
                border: "none", background: "transparent",
                cursor: "pointer", color: "#A89D80", padding: 2,
                display: "flex",
              }}
            >
              <GitBranch size={12} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ParentLinkAffordance({
  open, query, results, searching,
  onActivate, onCancel, onQueryChange,
  onPickExisting, onCreateNew,
}: {
  open: boolean;
  query: string;
  results: ApiTodo[];
  searching: boolean;
  onActivate: () => void;
  onCancel: () => void;
  onQueryChange: (q: string) => void;
  onPickExisting: (t: ApiTodo) => void;
  onCreateNew: (text: string) => void;
}) {
  if (!open) {
    return (
      <div style={{ position: "relative", marginBottom: 14 }}>
        <button
          type="button"
          onClick={onActivate}
          style={{
            width: "100%",
            padding: "8px 12px",
            border: "1px dashed rgba(155,130,70,0.40)",
            borderRadius: 8,
            background: "transparent",
            cursor: "pointer",
            fontSize: 12, color: "#8A8270",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            fontFamily: FONT,
          }}
        >
          <Plus size={12} /> link to parent todo…
        </button>
      </div>
    );
  }
  const trimmedQuery = query.trim();
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        border: "0.5px solid rgba(155,130,70,0.30)",
        borderRadius: 9,
        padding: 9,
        background: "rgba(243,238,220,0.40)",
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 7,
          paddingBottom: 7,
          borderBottom: "0.5px solid rgba(155,130,70,0.20)",
        }}>
          <Search size={12} color="#A89D80" />
          <input
            autoFocus
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancel();
              if (e.key === "Enter" && trimmedQuery && results.length === 0) {
                e.preventDefault();
                onCreateNew(trimmedQuery);
              }
            }}
            placeholder="search parent todo or type new…"
            style={{
              flex: 1, border: "none", background: "transparent",
              padding: 0, fontSize: 13,
              color: "var(--gooni-text, #2A2620)",
              outline: "none", fontFamily: FONT,
            }}
          />
          <button
            type="button"
            onClick={onCancel}
            aria-label="cancel"
            style={{ background: "none", border: "none", cursor: "pointer", padding: 2 }}
          >
            <X size={12} color="#A89D80" />
          </button>
        </div>
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 2 }}>
          {searching && (
            <div style={{ padding: 8, fontSize: 11, opacity: 0.5 }}>searching…</div>
          )}
          {!searching && results.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onPickExisting(r)}
              style={{
                textAlign: "left", padding: "6px 9px",
                border: "0.5px solid transparent",
                borderRadius: 7, cursor: "pointer",
                background: "var(--gooni-card, #FFFCF3)",
                fontSize: 12, fontFamily: FONT,
                display: "flex", alignItems: "center", gap: 9,
                opacity: r.done ? 0.62 : 1,
              }}
            >
              <span style={{
                width: 12, height: 12, borderRadius: "50%",
                background: r.done ? "#8A8270" : "transparent",
                border: r.done ? "none" : "2px solid #C9772E",
                flexShrink: 0,
              }} />
              <span style={{
                flex: 1, color: "var(--gooni-text, #2A2620)",
                textDecoration: r.done ? "line-through" : "none",
              }}>
                {r.text}
              </span>
              <span style={{ fontSize: 10, color: "#A89D80" }}>
                {r.state === "doing" ? "doing" : (r.done ? "done" : "open")}
              </span>
            </button>
          ))}

          {/* Slice 4 — create-new fallback. Always shown when query
              is non-empty so Daniel never hits a dead-end. */}
          {trimmedQuery && (
            <>
              {results.length > 0 && (
                <div style={{
                  height: 0.5, background: "rgba(155,130,70,0.20)",
                  margin: "5px 2px",
                }} />
              )}
              <button
                type="button"
                onClick={() => onCreateNew(trimmedQuery)}
                style={{
                  textAlign: "left", padding: "7px 9px",
                  border: "none", borderRadius: 7, cursor: "pointer",
                  background: "rgba(241,226,190,0.65)",
                  fontSize: 12, fontFamily: FONT,
                  display: "flex", alignItems: "center", gap: 9,
                }}
              >
                <span style={{
                  width: 12, height: 12, borderRadius: "50%",
                  border: "1.5px dashed #C9A961",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                }}>
                  <Plus size={8} color="#C9A961" />
                </span>
                <span style={{ flex: 1, color: "#4A4538" }}>
                  create <span style={{ fontWeight: 500 }}>"{trimText(trimmedQuery, 40)}"</span> as parent
                </span>
                <span style={{ fontSize: 10, color: "#8A8270" }}>new todo</span>
              </button>
            </>
          )}

          {!searching && !trimmedQuery && results.length === 0 && (
            <div style={{ padding: 8, fontSize: 11, opacity: 0.5 }}>
              type to search or create a new parent
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// EditableText — single-line inline rename. Click to edit, blur commits.
// Escape reverts; Enter commits.
function EditableText({
  value, onCommit, style,
}: {
  value: string;
  onCommit: (text: string) => void;
  style?: React.CSSProperties;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);

  if (!editing) {
    return (
      <span
        onClick={() => setEditing(true)}
        title="Click to edit"
        style={{
          cursor: "text", display: "block",
          padding: "2px 0",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          ...style,
        }}
      >
        {value}
      </span>
    );
  }
  return (
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          setEditing(false);
          if (draft.trim() && draft !== value) onCommit(draft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(value);
          setEditing(false);
        }
      }}
      onBlur={() => {
        setEditing(false);
        if (draft.trim() && draft !== value) onCommit(draft);
      }}
      style={{
        width: "100%", border: "none", outline: "none",
        background: "transparent",
        padding: "2px 0", fontFamily: FONT,
        ...style,
      }}
    />
  );
}

// EditableNote — multi-line inline note edit for closure_note. Renders
// as italic quote when filled, dashed placeholder when empty (clickable).
function EditableNote({
  value, onCommit, placeholder,
}: {
  value: string;
  onCommit: (text: string) => void;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      const len = draft.length;
      ref.current?.setSelectionRange(len, len);
    }
  }, [editing]);

  if (!editing && !value) {
    if (!placeholder) return null;
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        style={{
          border: "1px dashed rgba(155,130,70,0.25)",
          borderRadius: 6,
          padding: "6px 10px",
          background: "transparent",
          cursor: "text",
          fontSize: 11, color: "#A89D80",
          fontFamily: FONT,
          display: "block", width: "100%", textAlign: "left",
        }}
      >
        {placeholder}
      </button>
    );
  }
  if (!editing) {
    return (
      <div
        onClick={() => setEditing(true)}
        style={{
          fontSize: 12, color: "#4A4538",
          padding: "9px 11px",
          background: "rgba(243,238,220,0.55)",
          borderLeft: "2px solid #C9A961",
          borderRadius: "0 6px 6px 0",
          lineHeight: 1.6, fontStyle: "italic",
          cursor: "text",
        }}
      >
        {value}
      </div>
    );
  }
  return (
    <textarea
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          setDraft(value);
          setEditing(false);
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          setEditing(false);
          if (draft !== value) onCommit(draft);
        }
      }}
      onBlur={() => {
        setEditing(false);
        if (draft !== value) onCommit(draft);
      }}
      style={{
        width: "100%", fontSize: 12,
        border: "0.5px solid rgba(155,130,70,0.30)",
        background: "var(--gooni-bg, #FAF7F0)",
        borderRadius: 7, padding: "9px 11px",
        color: "var(--gooni-text, #2A2620)",
        fontFamily: FONT, lineHeight: 1.6,
        resize: "vertical", minHeight: 46,
        outline: "none", boxSizing: "border-box",
      }}
    />
  );
}

function trimText(s: string, n: number): string {
  s = (s || "").trim();
  return s.length <= n ? s : s.slice(0, n).trim() + "…";
}
