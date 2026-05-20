import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, ArrowLeft, X, GitBranch, Plus, Search } from "lucide-react";
import {
  fetchTodoChain,
  searchTodos,
  linkTodoParent,
  unlinkTodoParent,
  type ApiTodo,
  type TodoChain,
  type TodoChainNode,
} from "../../services/api";

// TodoChainView — Surface B (chain drilldown) + Surface D (retroactive
// linking from the parent side).
//
// Renders the lineage graph centered on `todoId`. Three blocks:
//   1. Ancestors (parents, grandparents, ...) — laid out vertically
//      above the focus node.
//   2. The focus node — bigger, highlighted.
//   3. Descendants (children, grandchildren, ...) — vertically below.
//      Branches (one parent spawns N children) render as side-by-side
//      columns up to 3; 4+ collapses to a clickable list.
//
// Click any non-focus node → recenter on that node (refetches the chain).
// "+ link parent" / "+ link existing follow-up" buttons open the search
// input inline. Selecting a result wires the spawned_from edge.
//
// Time reads top-to-bottom chronologically. Branches go horizontal.
// Layout matches the Claude-web visual reference HTML.

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

interface Props {
  todoId: number;
  onClose: () => void;
  // Optional: refetch the parent dashboard when chain mutations happen
  // (link / unlink). Lets the caller invalidate "todos-bundle" so the
  // indicators in the list update without a full page refresh.
  onMutate?: () => void;
}

export function TodoChainView({ todoId, onClose, onMutate }: Props) {
  const [chain, setChain] = useState<TodoChain | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState(todoId);

  // Search state for retroactive linking.
  const [linkMode, setLinkMode] = useState<"none" | "parent" | "child">("none");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ApiTodo[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTodoChain(activeId, 10)
      .then((c) => { if (!cancelled) setChain(c); })
      .catch((e) => console.error("chain fetch failed", e))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeId]);

  // Debounced search.
  useEffect(() => {
    if (linkMode === "none" || !query.trim()) {
      setResults([]);
      return;
    }
    const handle = window.setTimeout(async () => {
      setSearching(true);
      try {
        const { matches } = await searchTodos(query, 8, true);
        setResults(matches.filter((m) => m.id !== activeId));
      } catch (e) { console.error("search failed", e); }
      finally { setSearching(false); }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [query, linkMode, activeId]);

  async function onPickLinkTarget(target: ApiTodo) {
    try {
      if (linkMode === "parent") {
        // active is child, target is parent
        await linkTodoParent(activeId, target.id);
      } else if (linkMode === "child") {
        // active is parent, target is child
        await linkTodoParent(target.id, activeId);
      }
      setLinkMode("none");
      setQuery("");
      setResults([]);
      // Refetch chain w/ new edge in place.
      const fresh = await fetchTodoChain(activeId, 10);
      setChain(fresh);
      onMutate?.();
    } catch (e) { console.error("link failed", e); }
  }

  async function onUnlinkParent(parentId: number) {
    try {
      await unlinkTodoParent(activeId, parentId);
      const fresh = await fetchTodoChain(activeId, 10);
      setChain(fresh);
      onMutate?.();
    } catch (e) { console.error("unlink failed", e); }
  }

  // ── Layout helpers ────────────────────────────────────────────────

  // Direct parents = depth-1 ancestors.
  // Direct children = depth-1 descendants.
  // We render direct parents above, direct children below (with branching
  // collapse for 4+). Deeper chains are reachable by clicking nodes —
  // recenter and re-render. This keeps the drilldown readable instead of
  // dumping the entire reachable graph.
  const directParents = useMemo<TodoChainNode[]>(() => {
    if (!chain) return [];
    return chain.ancestors.filter((a) => a.depth === 1);
  }, [chain]);
  const directChildren = useMemo<TodoChainNode[]>(() => {
    if (!chain) return [];
    return chain.descendants.filter((d) => d.depth === 1);
  }, [chain]);

  // Backdrop click closes.
  function onBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      onClick={onBackdropClick}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.42)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        paddingTop: 60, fontFamily: FONT,
      }}
    >
      <div
        style={{
          background: "var(--color-background-primary, #fff)",
          borderRadius: 14,
          width: "min(640px, 92vw)",
          maxHeight: "82vh",
          overflow: "auto",
          padding: "22px 24px 24px",
          boxShadow: "0 24px 60px rgba(0,0,0,0.22)",
          color: "var(--color-text-primary, #1a1a1a)",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          marginBottom: 18,
        }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 10,
          }}>
            <GitBranch size={16} style={{ color: "var(--color-text-secondary, #6B7280)" }} />
            <span style={{
              fontSize: 12, fontWeight: 600, letterSpacing: 0.5,
              textTransform: "uppercase",
              color: "var(--color-text-secondary, #6B7280)",
            }}>chain view</span>
          </div>
          <button
            onClick={onClose}
            aria-label="close"
            style={{
              background: "none", border: "none",
              cursor: "pointer", padding: 6,
              color: "var(--color-text-tertiary, #9CA3AF)",
            }}
          >
            <X size={16} />
          </button>
        </div>

        {loading && (
          <div style={{ opacity: 0.5, fontSize: 13, padding: "20px 4px" }}>
            loading chain…
          </div>
        )}

        {!loading && chain && (
          <>
            {/* Ancestors block */}
            {directParents.length > 0 ? (
              <>
                {directParents.length === 1 ? (
                  <ChainNode
                    node={directParents[0]}
                    onRecenter={() => setActiveId(directParents[0].todo.id)}
                    onUnlink={() => onUnlinkParent(directParents[0].todo.id)}
                    showUnlink
                  />
                ) : (
                  <ConvergenceBlock
                    parents={directParents}
                    onRecenter={(id) => setActiveId(id)}
                    onUnlink={(id) => onUnlinkParent(id)}
                  />
                )}
                <VerticalConnector />
              </>
            ) : (
              <ParentLinkAffordance
                active={linkMode === "parent"}
                onActivate={() => setLinkMode("parent")}
                onCancel={() => { setLinkMode("none"); setQuery(""); }}
                query={query}
                onQueryChange={setQuery}
                results={results}
                onPickResult={onPickLinkTarget}
                searching={searching}
              />
            )}

            {/* Focus node */}
            <FocusNode node={chain.this} />

            {/* Descendants block */}
            {directChildren.length === 0 ? (
              <ChildLinkAffordance
                active={linkMode === "child"}
                onActivate={() => setLinkMode("child")}
                onCancel={() => { setLinkMode("none"); setQuery(""); }}
                query={query}
                onQueryChange={setQuery}
                results={results}
                onPickResult={onPickLinkTarget}
                searching={searching}
              />
            ) : directChildren.length <= 3 ? (
              <>
                <VerticalConnector />
                <BranchLabel count={directChildren.length} />
                <div style={{
                  display: "flex", gap: 12,
                  alignItems: "flex-start",
                  flexWrap: "wrap",
                }}>
                  {directChildren.map((d) => (
                    <div key={d.todo.id} style={{ flex: "1 1 0", minWidth: 180 }}>
                      <ChainNode
                        node={d}
                        onRecenter={() => setActiveId(d.todo.id)}
                      />
                    </div>
                  ))}
                </div>
                <ChildLinkAffordance
                  active={linkMode === "child"}
                  onActivate={() => setLinkMode("child")}
                  onCancel={() => { setLinkMode("none"); setQuery(""); }}
                  query={query}
                  onQueryChange={setQuery}
                  results={results}
                  onPickResult={onPickLinkTarget}
                  searching={searching}
                  compact
                />
              </>
            ) : (
              <CollapsedChildList
                children={directChildren}
                onRecenter={(id) => setActiveId(id)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

function FocusNode({ node }: { node: ApiTodo }) {
  const done = node.state === "done";
  return (
    <div style={{
      border: "1.5px solid var(--color-info, #0F6E56)",
      borderRadius: 10,
      padding: "12px 14px",
      background: "var(--color-background-secondary, rgba(15,110,86,0.04))",
      margin: "4px 0",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{
          width: 10, height: 10,
          borderRadius: "50%",
          background: done ? "var(--color-text-tertiary, #9CA3AF)" : "transparent",
          border: done ? "none" : "1.5px solid var(--color-info, #0F6E56)",
        }} />
        <span style={{
          flex: 1,
          fontSize: 14, fontWeight: 600,
          textDecoration: done ? "line-through" : "none",
          opacity: done ? 0.6 : 1,
        }}>
          {node.text}
        </span>
        <StatePill state={node.state} />
      </div>
      {node.closure_note && (
        <div style={{
          marginTop: 8, paddingTop: 8,
          borderTop: "0.5px dashed var(--color-border-tertiary, rgba(0,0,0,0.08))",
          fontSize: 12, color: "var(--color-text-secondary, #6B7280)",
          fontStyle: "italic",
        }}>
          "{node.closure_note}"
        </div>
      )}
    </div>
  );
}

function ChainNode({
  node,
  onRecenter,
  onUnlink,
  showUnlink = false,
}: {
  node: TodoChainNode;
  onRecenter: () => void;
  onUnlink?: () => void;
  showUnlink?: boolean;
}) {
  const t = node.todo;
  const done = t.state === "done";
  return (
    <div style={{
      border: "0.5px solid var(--color-border-secondary, rgba(0,0,0,0.08))",
      borderRadius: 8,
      padding: "10px 12px",
      background: "transparent",
      cursor: "pointer",
      opacity: done ? 0.62 : 1,
      position: "relative",
    }}
      onClick={onRecenter}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          width: 8, height: 8,
          borderRadius: "50%",
          background: done ? "var(--color-text-tertiary, #9CA3AF)" : "transparent",
          border: done ? "none" : "1.2px solid var(--color-info, #0F6E56)",
        }} />
        <span style={{
          flex: 1,
          fontSize: 13,
          textDecoration: done ? "line-through" : "none",
        }}>
          {t.text}
        </span>
        <StatePill state={t.state} />
        {showUnlink && onUnlink && (
          <button
            onClick={(e) => { e.stopPropagation(); onUnlink(); }}
            aria-label="unlink"
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: "var(--color-text-tertiary, #9CA3AF)",
              padding: 2,
            }}
          >
            <X size={12} />
          </button>
        )}
      </div>
      {t.closure_note && (
        <div style={{
          marginTop: 6,
          fontSize: 11,
          color: "var(--color-text-tertiary, #9CA3AF)",
          fontStyle: "italic",
        }}>
          "{t.closure_note}"
        </div>
      )}
    </div>
  );
}

function VerticalConnector() {
  return (
    <div style={{
      width: 1.5, height: 20,
      margin: "0 auto",
      background: "var(--color-border-tertiary, rgba(0,0,0,0.1))",
    }} />
  );
}

function BranchLabel({ count }: { count: number }) {
  return (
    <div style={{
      textAlign: "center",
      fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase",
      color: "var(--color-text-tertiary, #9CA3AF)",
      margin: "4px 0 8px",
    }}>
      spawned {count} next step{count === 1 ? "" : "s"}
    </div>
  );
}

function ConvergenceBlock({
  parents,
  onRecenter,
  onUnlink,
}: {
  parents: TodoChainNode[];
  onRecenter: (id: number) => void;
  onUnlink: (id: number) => void;
}) {
  return (
    <div>
      <div style={{
        display: "flex", gap: 10, alignItems: "flex-start",
        flexWrap: "wrap",
      }}>
        {parents.map((p) => (
          <div key={p.todo.id} style={{ flex: "1 1 0", minWidth: 180 }}>
            <ChainNode
              node={p}
              onRecenter={() => onRecenter(p.todo.id)}
              onUnlink={() => onUnlink(p.todo.id)}
              showUnlink
            />
          </div>
        ))}
      </div>
      <div style={{
        textAlign: "center",
        fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase",
        color: "var(--color-text-tertiary, #9CA3AF)",
        margin: "10px 0 0",
      }}>
        {parents.length} ancestors converge
      </div>
    </div>
  );
}

function CollapsedChildList({
  children,
  onRecenter,
}: {
  children: TodoChainNode[];
  onRecenter: (id: number) => void;
}) {
  return (
    <>
      <VerticalConnector />
      <BranchLabel count={children.length} />
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {children.map((c) => (
          <div
            key={c.todo.id}
            onClick={() => onRecenter(c.todo.id)}
            style={{
              padding: "8px 12px",
              border: "0.5px solid var(--color-border-tertiary, rgba(0,0,0,0.06))",
              borderRadius: 6,
              cursor: "pointer",
              display: "flex", alignItems: "center", gap: 8,
              fontSize: 13,
              opacity: c.todo.done ? 0.6 : 1,
            }}
          >
            <span style={{
              width: 6, height: 6, borderRadius: "50%",
              background: c.todo.done
                ? "var(--color-text-tertiary, #9CA3AF)"
                : "var(--color-info, #0F6E56)",
            }} />
            <span style={{ flex: 1, textDecoration: c.todo.done ? "line-through" : "none" }}>
              {c.todo.text}
            </span>
            <StatePill state={c.todo.state} />
          </div>
        ))}
      </div>
    </>
  );
}

function StatePill({ state }: { state: string }) {
  const tints: Record<string, { bg: string; fg: string }> = {
    "not_yet": { bg: "rgba(0,0,0,0.05)",  fg: "#6B7280" },
    "doing":   { bg: "rgba(15,110,86,0.12)", fg: "#0F6E56" },
    "done":    { bg: "rgba(0,0,0,0.06)",  fg: "#9CA3AF" },
  };
  const tint = tints[state] || tints["not_yet"];
  return (
    <span style={{
      background: tint.bg, color: tint.fg,
      fontSize: 10, fontWeight: 600,
      padding: "2px 6px", borderRadius: 4,
      letterSpacing: 0.3, textTransform: "uppercase",
    }}>
      {state === "not_yet" ? "open" : state}
    </span>
  );
}

// Surface D entry points — child-side hover affordance + parent-side
// inline search.

function ParentLinkAffordance({
  active, onActivate, onCancel,
  query, onQueryChange, results, onPickResult, searching,
}: {
  active: boolean;
  onActivate: () => void;
  onCancel: () => void;
  query: string;
  onQueryChange: (q: string) => void;
  results: ApiTodo[];
  onPickResult: (t: ApiTodo) => void;
  searching: boolean;
}) {
  if (!active) {
    return (
      <button
        onClick={onActivate}
        style={{
          width: "100%",
          padding: "8px 12px",
          border: "1px dashed var(--color-border-tertiary, rgba(0,0,0,0.15))",
          borderRadius: 8,
          background: "transparent",
          cursor: "pointer",
          fontSize: 12,
          color: "var(--color-text-tertiary, #9CA3AF)",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          marginBottom: 4,
        }}
      >
        <ArrowLeft size={12} /> link to parent todo…
      </button>
    );
  }
  return (
    <LinkSearchBox
      placeholder="search parent todo…"
      query={query}
      onQueryChange={onQueryChange}
      results={results}
      onPickResult={onPickResult}
      onCancel={onCancel}
      searching={searching}
    />
  );
}

function ChildLinkAffordance({
  active, onActivate, onCancel,
  query, onQueryChange, results, onPickResult, searching,
  compact = false,
}: {
  active: boolean;
  onActivate: () => void;
  onCancel: () => void;
  query: string;
  onQueryChange: (q: string) => void;
  results: ApiTodo[];
  onPickResult: (t: ApiTodo) => void;
  searching: boolean;
  compact?: boolean;
}) {
  if (!active) {
    return (
      <button
        onClick={onActivate}
        style={{
          width: "100%",
          marginTop: compact ? 8 : 12,
          padding: "8px 12px",
          border: "1px dashed var(--color-border-tertiary, rgba(0,0,0,0.15))",
          borderRadius: 8,
          background: "transparent",
          cursor: "pointer",
          fontSize: 12,
          color: "var(--color-text-tertiary, #9CA3AF)",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        }}
      >
        <Plus size={12} /> {compact ? "link more" : "link existing follow-up…"}
      </button>
    );
  }
  return (
    <div style={{ marginTop: 12 }}>
      <LinkSearchBox
        placeholder="search follow-up todo…"
        query={query}
        onQueryChange={onQueryChange}
        results={results}
        onPickResult={onPickResult}
        onCancel={onCancel}
        searching={searching}
      />
    </div>
  );
}

function LinkSearchBox({
  placeholder, query, onQueryChange, results, onPickResult, onCancel, searching,
}: {
  placeholder: string;
  query: string;
  onQueryChange: (q: string) => void;
  results: ApiTodo[];
  onPickResult: (t: ApiTodo) => void;
  onCancel: () => void;
  searching: boolean;
}) {
  return (
    <div style={{
      border: "1px solid var(--color-border-secondary, rgba(0,0,0,0.1))",
      borderRadius: 8,
      padding: 8,
      background: "var(--color-background-secondary, rgba(0,0,0,0.02))",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Search size={12} style={{ color: "var(--color-text-tertiary, #9CA3AF)" }} />
        <input
          autoFocus
          placeholder={placeholder}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
          style={{
            flex: 1, border: "none", outline: "none",
            background: "transparent",
            fontSize: 13,
            color: "var(--color-text-primary, #1a1a1a)",
          }}
        />
        <button
          onClick={onCancel}
          aria-label="cancel"
          style={{ background: "none", border: "none", cursor: "pointer", padding: 2 }}
        >
          <X size={12} style={{ color: "var(--color-text-tertiary, #9CA3AF)" }} />
        </button>
      </div>
      {searching && (
        <div style={{ padding: 8, fontSize: 11, opacity: 0.5 }}>searching…</div>
      )}
      {!searching && query.trim() && results.length === 0 && (
        <div style={{ padding: 8, fontSize: 11, opacity: 0.5 }}>no matches</div>
      )}
      {results.length > 0 && (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
          {results.map((r) => (
            <button
              key={r.id}
              onClick={() => onPickResult(r)}
              style={{
                textAlign: "left",
                padding: "6px 8px",
                border: "none",
                background: "transparent",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 12,
                display: "flex", alignItems: "center", gap: 8,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(0,0,0,0.04)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <StatePill state={r.state} />
              <span style={{
                flex: 1,
                textDecoration: r.done ? "line-through" : "none",
                opacity: r.done ? 0.6 : 1,
              }}>
                {r.text}
              </span>
              <ArrowUpRight size={11} style={{ color: "var(--color-text-tertiary, #9CA3AF)" }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
