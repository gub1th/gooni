import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchMemories, fetchMemoryStats, deleteMemory, patchMemory,
  type ApiMemory, type MemoryType,
} from "../services/api";
import { PasswordGate } from "../components/PasswordGate";
import { Sidebar } from "../components/notes/Sidebar";
import { useWindowWidth } from "../hooks/useWindowWidth";

export const Route = createFileRoute("/memories")({
  component: MemoriesPage,
});

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";

// Type → tab color. Mirrors the brand palette so the type column reads at
// a glance the way Mem0's category dots do.
const TYPE_COLORS: Record<MemoryType, { dot: string; bg: string; fg: string }> = {
  preference: { dot: "#16A34A", bg: "rgba(74,222,128,0.14)", fg: "#16A34A" },
  goal:       { dot: "#7C3AED", bg: "rgba(124,58,237,0.14)", fg: "#7C3AED" },
  fact:       { dot: "#2563EB", bg: "rgba(37,99,235,0.13)",  fg: "#2563EB" },
  routine:    { dot: "#EA580C", bg: "rgba(234,88,12,0.13)",  fg: "#C2410C" },
  constraint: { dot: "#DC2626", bg: "rgba(220,38,38,0.13)",  fg: "#B91C1C" },
  episode:    { dot: "#6B7280", bg: "rgba(107,114,128,0.13)", fg: "#4B5563" },
};

const TYPE_ORDER: MemoryType[] = ["preference", "goal", "fact", "routine", "constraint", "episode"];

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  const diff = Date.now() - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  const mo = Math.floor(days / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

const SIDEBAR_BREAKPOINT = 768;

function MemoriesPage() {
  const navigate = useNavigate();
  const windowWidth = useWindowWidth();
  const [sidebarOpen, setSidebarOpen] = useState(windowWidth >= SIDEBAR_BREAKPOINT);
  useEffect(() => {
    setSidebarOpen(windowWidth >= SIDEBAR_BREAKPOINT);
  }, [windowWidth >= SIDEBAR_BREAKPOINT]);

  const [filter, setFilter] = useState<MemoryType | "all">("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [memories, setMemories] = useState<ApiMemory[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const reqIdRef = useRef(0);

  // Debounce search input — table refetches on every keystroke otherwise.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 280);
    return () => clearTimeout(t);
  }, [search]);

  async function load() {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    try {
      const opts: Parameters<typeof fetchMemories>[0] = {
        limit: 500,
        includeInactive,
      };
      if (filter !== "all") opts.type = filter;
      if (debouncedSearch) opts.q = debouncedSearch;
      const [list, st] = await Promise.all([
        fetchMemories(opts),
        fetchMemoryStats(),
      ]);
      // Drop the response if a newer request has been kicked off — prevents
      // out-of-order reordering when the user clicks tabs fast.
      if (reqId !== reqIdRef.current) return;
      setMemories(list.memories);
      setTotal(list.total);
      setStats(st.by_type);
    } catch (e) {
      console.error(e);
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, debouncedSearch, includeInactive]);

  async function handleDelete(m: ApiMemory) {
    if (!confirm(`Forget this memory?\n\n"${m.content.slice(0, 120)}${m.content.length > 120 ? "…" : ""}"`)) return;
    try {
      await deleteMemory(m.id);
      setMemories((prev) => prev.filter((x) => x.id !== m.id));
      setTotal((t) => t - 1);
      setStats((s) => ({ ...s, [m.type]: Math.max(0, (s[m.type] ?? 1) - 1) }));
    } catch (e) {
      alert("Delete failed.");
      console.error(e);
    }
  }

  async function handleSaveEdit(m: ApiMemory) {
    const content = editDraft.trim();
    setEditingId(null);
    if (!content || content === m.content) return;
    try {
      await patchMemory(m.id, content);
      // Patch supersedes — the row id changes. Easiest: refetch.
      load();
    } catch (e) {
      alert("Update failed.");
      console.error(e);
    }
  }

  // Sidebar shows logo + spaces + recent notes. Repurposing "onLogoClick" to
  // navigate back to dashboard. The other handlers redirect to / since this
  // page doesn't host notes/chat composers.
  function gotoDashboard() {
    navigate({ to: "/", search: { note: undefined, conv: undefined } });
  }

  const tabs = useMemo(() => {
    return [
      { key: "all" as const, label: "All", count: Object.values(stats).reduce((a, b) => a + b, 0) },
      ...TYPE_ORDER
        .filter((t) => (stats[t] ?? 0) > 0 || filter === t)
        .map((t) => ({ key: t, label: t, count: stats[t] ?? 0 })),
    ];
  }, [stats, filter]);

  return (
    <PasswordGate>
      <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: "#FAFAFA" }}>
        {sidebarOpen && (
          <Sidebar
            isDashboard={false}
            isNotes={false}
            isChat={false}
            showCompose={true}
            onLogoClick={gotoDashboard}
            onSpaceSelect={gotoDashboard}
            onCompose={gotoDashboard}
            onNewChat={gotoDashboard}
          />
        )}

        <div style={{ flex: 1, overflowY: "auto", fontFamily: FONT }}>
          <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 32px 80px" }}>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 18 }}>
              <div>
                <h1 style={{ fontSize: 26, fontWeight: 700, color: "#1C1C1E", margin: 0, letterSpacing: "-0.4px" }}>
                  Memories
                </h1>
                <p style={{ fontSize: 13, color: "#8E8E93", margin: "4px 0 0" }}>
                  Everything Gooni knows about you. {total} active.
                </p>
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <label style={{
                  fontSize: 12, color: "#6E6E73",
                  display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                  userSelect: "none",
                }}>
                  <input
                    type="checkbox"
                    checked={includeInactive}
                    onChange={(e) => setIncludeInactive(e.target.checked)}
                  />
                  show superseded
                </label>
                <button
                  onClick={() => load()}
                  style={{
                    padding: "6px 12px", borderRadius: 8,
                    border: "1px solid rgba(0,0,0,0.1)",
                    background: "#fff", cursor: "pointer", fontSize: 12, fontFamily: FONT,
                  }}
                >
                  Refresh
                </button>
              </div>
            </div>

            {/* Tabs */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
              {tabs.map((t) => {
                const active = filter === t.key;
                const c = t.key !== "all" ? TYPE_COLORS[t.key] : null;
                return (
                  <button
                    key={t.key}
                    onClick={() => setFilter(t.key)}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 7,
                      padding: "6px 12px",
                      borderRadius: 999,
                      background: active ? "#1C1C1E" : "#fff",
                      color: active ? "#fff" : "#3C3C43",
                      border: active ? "1px solid #1C1C1E" : "1px solid rgba(0,0,0,0.1)",
                      fontFamily: FONT, fontSize: 12.5, fontWeight: 500,
                      cursor: "pointer",
                      transition: "background 0.12s, color 0.12s",
                    }}
                  >
                    {c && (
                      <span
                        style={{
                          width: 7, height: 7, borderRadius: "50%",
                          background: c.dot,
                          boxShadow: active ? "0 0 0 2px rgba(255,255,255,0.2)" : "none",
                        }}
                      />
                    )}
                    <span style={{ textTransform: t.key === "all" ? "none" : "capitalize" }}>{t.label}</span>
                    <span style={{
                      fontSize: 11, opacity: 0.7,
                      fontVariantNumeric: "tabular-nums",
                    }}>{t.count}</span>
                  </button>
                );
              })}
            </div>

            {/* Search */}
            <div style={{ marginBottom: 14 }}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search memory content…"
                style={{
                  width: "100%", boxSizing: "border-box",
                  padding: "9px 14px", borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.1)",
                  fontSize: 13, fontFamily: FONT, outline: "none",
                  background: "#fff",
                }}
              />
            </div>

            {/* Table */}
            <div style={{
              background: "#fff",
              border: "1px solid rgba(0,0,0,0.08)",
              borderRadius: 12,
              overflow: "hidden",
            }}>
              <div style={{
                display: "grid",
                gridTemplateColumns: "110px 110px 1fr 90px 110px",
                gap: 0,
                padding: "10px 16px",
                fontSize: 11, color: "#8E8E93", letterSpacing: 0.4,
                textTransform: "uppercase", fontWeight: 600,
                background: "#F8F8F9",
                borderBottom: "1px solid rgba(0,0,0,0.06)",
              }}>
                <div>Time</div>
                <div>Type</div>
                <div>Memory</div>
                <div>Conf.</div>
                <div style={{ textAlign: "right" }}>Action</div>
              </div>

              {loading && memories.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: "#AEAEB2", fontSize: 13 }}>
                  Loading…
                </div>
              ) : memories.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: "#AEAEB2", fontSize: 13 }}>
                  No memories match.
                </div>
              ) : (
                memories.map((m) => {
                  const c = TYPE_COLORS[m.type];
                  const isEditing = editingId === m.id;
                  const isInactive = !m.is_active;
                  return (
                    <div
                      key={m.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "110px 110px 1fr 90px 110px",
                        gap: 0,
                        padding: "12px 16px",
                        fontSize: 13,
                        borderBottom: "1px solid rgba(0,0,0,0.05)",
                        alignItems: "center",
                        opacity: isInactive ? 0.55 : 1,
                        background: isInactive ? "rgba(0,0,0,0.015)" : "transparent",
                      }}
                    >
                      <div style={{ color: "#8E8E93", fontSize: 12 }}>
                        {relativeTime(m.created_at)}
                      </div>
                      <div>
                        <span style={{
                          display: "inline-flex", alignItems: "center", gap: 5,
                          padding: "2px 8px", borderRadius: 999,
                          background: c.bg, color: c.fg,
                          fontSize: 11, fontWeight: 600,
                          textTransform: "capitalize",
                        }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.dot }} />
                          {m.type}
                        </span>
                      </div>
                      <div style={{ color: "#1C1C1E", lineHeight: 1.45, paddingRight: 12 }}>
                        {isEditing ? (
                          <textarea
                            autoFocus
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSaveEdit(m);
                              if (e.key === "Escape") setEditingId(null);
                            }}
                            rows={Math.min(6, Math.max(2, Math.ceil(editDraft.length / 60)))}
                            style={{
                              width: "100%", boxSizing: "border-box",
                              fontFamily: FONT, fontSize: 13,
                              padding: "6px 8px", borderRadius: 6,
                              border: "1px solid rgba(0,0,0,0.18)",
                              outline: "none", resize: "vertical",
                            }}
                          />
                        ) : (
                          <>
                            {m.key && (
                              <span style={{
                                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                                fontSize: 11, color: "#9CA3AF", marginRight: 6,
                              }}>{m.key}</span>
                            )}
                            {m.content}
                            {isInactive && m.superseded_by && (
                              <span style={{
                                marginLeft: 8, fontSize: 11, color: "#9CA3AF",
                                fontStyle: "italic",
                              }}>→ superseded by #{m.superseded_by}</span>
                            )}
                          </>
                        )}
                      </div>
                      <div style={{ color: "#6E6E73", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
                        {(m.confidence * 100).toFixed(0)}%
                      </div>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        {isEditing ? (
                          <>
                            <button onClick={() => handleSaveEdit(m)} style={iconBtn("primary")}>save</button>
                            <button onClick={() => setEditingId(null)} style={iconBtn()}>cancel</button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => { setEditingId(m.id); setEditDraft(m.content); }}
                              style={iconBtn()}
                              disabled={isInactive}
                              title={isInactive ? "Inactive — restore not supported here" : "Edit"}
                            >edit</button>
                            <button
                              onClick={() => handleDelete(m)}
                              style={{ ...iconBtn(), color: "#C76B6B" }}
                              disabled={isInactive}
                              title={isInactive ? "Already inactive" : "Forget"}
                            >×</button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>
    </PasswordGate>
  );
}

function iconBtn(variant?: "primary"): React.CSSProperties {
  const primary = variant === "primary";
  return {
    padding: "4px 10px",
    fontSize: 11.5, fontFamily: FONT, fontWeight: 500,
    border: primary ? "none" : "1px solid rgba(0,0,0,0.1)",
    background: primary ? "#1C1C1E" : "transparent",
    color: primary ? "#fff" : "#6E6E73",
    borderRadius: 6, cursor: "pointer",
  };
}
