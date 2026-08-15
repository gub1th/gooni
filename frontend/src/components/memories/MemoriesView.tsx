import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchMemories, fetchMemoryStats, deleteMemory, patchMemory,
  type ApiMemory, type MemoryType, type MemorySource,
} from "../../services/api";
import { MemoryBrain } from "../notes/MemoryBrain";
import { frostInk as ctok, FONT } from "../../ui";
import { relativeTimeShort as relativeTime } from "../../utils/date";

// Memories, as a VIEW on the index route rather than the `/memories` route it
// used to be. It was the last surface with its own path, which meant the shell
// had nothing to slide it over: `/` is where the home is mounted, so on
// `/memories` the panel arrived over an empty void and read as a page stamped on
// top of nothing — the exact symptom stage 1 set out to kill. `/memories` still
// resolves; it redirects here, carrying `?focus=` through, so every bookmark and
// every "view memory →" deep link keeps working.
//
// Its CONTENTS are untouched by this pass. Only where it is mounted changed.


// Type → tab color. Bright hues tuned for the dark-frost surface — the chip
// text (fg) rides a faint tint of the same hue, so both must read light. (The
// original darker fg/dot were built for a white table.)
const TYPE_COLORS: Record<MemoryType, { dot: string; bg: string; fg: string }> = {
  preference: { dot: "#4ADE80", bg: "rgba(74,222,128,0.14)",  fg: "#4ADE80" },
  goal:       { dot: "#A78BFA", bg: "rgba(124,58,237,0.18)",  fg: "#A78BFA" },
  fact:       { dot: "#60A5FA", bg: "rgba(37,99,235,0.18)",   fg: "#60A5FA" },
  routine:    { dot: "#FB923C", bg: "rgba(234,88,12,0.16)",   fg: "#FB923C" },
  constraint: { dot: "#F87171", bg: "rgba(220,38,38,0.16)",   fg: "#F87171" },
  episode:    { dot: "#9CA3AF", bg: "rgba(107,114,128,0.16)", fg: "#9CA3AF" },
};

const TYPE_ORDER: MemoryType[] = ["preference", "goal", "fact", "routine", "constraint", "episode"];

const PAGE_SIZE = 50;

export function MemoriesView({ focusId }: { focusId?: number }) {
  // Brief highlight on the row deep-linked via ?focus=<id>. Cleared 2.4s
  // after the scroll lands so the flash doesn't linger.
  const [flashId, setFlashId] = useState<number | null>(null);

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

  // Cursor pagination — 50/page, fetched on scroll-near-bottom. Cursor is
  // the last-seen memory id (see GET /memories docstring for why id, not
  // offset). Reset whenever the filter set changes (load() below).
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Debounce search input — table refetches on every keystroke otherwise.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 280);
    return () => clearTimeout(t);
  }, [search]);

  // Build the filter opts shared by the first page + every load-more.
  function pageOpts(): Parameters<typeof fetchMemories>[0] {
    const opts: Parameters<typeof fetchMemories>[0] = { limit: PAGE_SIZE, includeInactive };
    if (filter !== "all") opts.type = filter;
    if (debouncedSearch) opts.q = debouncedSearch;
    return opts;
  }

  async function load() {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    try {
      const [list, st] = await Promise.all([
        fetchMemories(pageOpts()),
        fetchMemoryStats(),
      ]);
      // Drop the response if a newer request has been kicked off — prevents
      // out-of-order reordering when the user clicks tabs fast.
      if (reqId !== reqIdRef.current) return;
      setMemories(list.memories);
      setTotal(list.total);
      setCursor(list.next_cursor);
      setHasMore(list.has_more);
      setStats(st.by_type);
    } catch (e) {
      console.error(e);
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }

  // Append the next older page. Guards against double-fire (scroll spam) and
  // stale appends (filter changed mid-fetch → reqId moved). Cursor is a plain
  // id boundary, so it stays valid even if that exact row was just deleted.
  async function loadMore() {
    if (loadingMore || !hasMore || cursor == null) return;
    const reqId = reqIdRef.current;
    setLoadingMore(true);
    try {
      const list = await fetchMemories({ ...pageOpts(), beforeId: cursor });
      if (reqId !== reqIdRef.current) return;
      setMemories((prev) => [...prev, ...list.memories]);
      setCursor(list.next_cursor);
      setHasMore(list.has_more);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingMore(false);
    }
  }

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) loadMore();
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, debouncedSearch, includeInactive]);

  // ?focus=<id> deep-link: scroll the matching row into view + flash it
  // briefly so the user can spot what was linked. Fires whenever the URL
  // param changes or memories list refreshes (filter switch, edit). The
  // 50ms delay is to let the DOM settle after a load — without it the
  // getElementById call can race ahead of React's render.
  useEffect(() => {
    const focus = focusId;
    if (!focus || memories.length === 0) return;
    const target = memories.find((m) => m.id === focus);
    if (!target) return;
    const t = setTimeout(() => {
      const el = document.getElementById(`mem-row-${focus}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlashId(focus);
    }, 50);
    const clearT = setTimeout(() => setFlashId(null), 2450);
    return () => { clearTimeout(t); clearTimeout(clearT); };
  }, [focusId, memories]);

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

  const tabs = useMemo(() => {
    return [
      { key: "all" as const, label: "All", count: Object.values(stats).reduce((a, b) => a + b, 0) },
      ...TYPE_ORDER
        .filter((t) => (stats[t] ?? 0) > 0 || filter === t)
        .map((t) => ({ key: t, label: t, count: stats[t] ?? 0 })),
    ];
  }, [stats, filter]);

  // Sidebar + PasswordGate live in __root.tsx's AppShell.
  return (
        <div onScroll={handleScroll} style={{ flex: 1, overflowY: "auto", fontFamily: FONT, background: ctok.sheet }}>
          <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 32px 80px" }}>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 18 }}>
              <div>
                <h1 style={{ fontSize: 26, fontWeight: 700, color: ctok.text, margin: 0, letterSpacing: "-0.4px" }}>
                  Memories
                </h1>
                <p style={{ fontSize: 13, color: ctok.muted, margin: "4px 0 0" }}>
                  Everything Gooni knows about you. {total} active.
                </p>
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <label style={{
                  fontSize: 12, color: ctok.muted,
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
                    padding: "6px 14px", borderRadius: 999,
                    border: `1px solid ${ctok.hairline}`,
                    background: "transparent", color: ctok.muted, cursor: "pointer", fontSize: 12, fontFamily: FONT,
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
                      background: active ? ctok.accentDim : "transparent",
                      color: active ? ctok.accent : ctok.muted,
                      border: active ? "1px solid transparent" : `1px solid ${ctok.hairline}`,
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

            {/* Brain section — top N of the current filter as floating bubbles
                around the neural-brain animation. Cap at 12 so the half-fan
                layout doesn't get crowded. Hides on empty filter results
                (the component itself returns null when memories.length === 0). */}
            <MemoryBrain
              memories={memories.filter((m) => m.is_active).slice(0, 12)}
              allMemories={memories.filter((m) => m.is_active)}
              title={filter === "all" ? "what gooni remembers" : `${filter} memories`}
              subtitle="Click a bubble to peek. Same content as the table below — surfaced visually so the shape of your memory is at-a-glance. Click the brain for the full graph."
            />

            {/* Search */}
            <div style={{ marginBottom: 14, marginTop: 18 }}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search memory content…"
                style={{
                  width: "100%", boxSizing: "border-box",
                  padding: "9px 14px", borderRadius: 10,
                  border: `1px solid ${ctok.border}`,
                  fontSize: 13, fontFamily: FONT, outline: "none",
                  background: ctok.inputBg, color: ctok.text,
                }}
              />
            </div>

            {/* Table */}
            <div style={{
              background: ctok.card,
              border: `1px solid ${ctok.border}`,
              borderRadius: 12,
              overflow: "hidden",
            }}>
              <div style={{
                display: "grid",
                gridTemplateColumns: "110px 110px 1fr 90px 110px",
                gap: 0,
                padding: "10px 16px",
                fontSize: 11, color: ctok.muted, letterSpacing: 0.4,
                textTransform: "uppercase", fontWeight: 600,
                background: ctok.cardRaised,
                borderBottom: `1px solid ${ctok.border}`,
              }}>
                <div>Time</div>
                <div>Type</div>
                <div>Memory</div>
                <div>Conf.</div>
                <div style={{ textAlign: "right" }}>Action</div>
              </div>

              {loading && memories.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: ctok.faint, fontSize: 13 }}>
                  Loading…
                </div>
              ) : memories.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: ctok.faint, fontSize: 13 }}>
                  No memories match.
                </div>
              ) : (
                memories.map((m) => {
                  const c = TYPE_COLORS[m.type];
                  const isEditing = editingId === m.id;
                  const isInactive = !m.is_active;
                  const isFlashing = flashId === m.id;
                  return (
                    <div
                      key={m.id}
                      id={`mem-row-${m.id}`}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "110px 110px 1fr 90px 110px",
                        gap: 0,
                        padding: "12px 16px",
                        fontSize: 13,
                        borderBottom: `1px solid ${ctok.border}`,
                        alignItems: "center",
                        opacity: isInactive ? 0.55 : 1,
                        background: isFlashing
                          ? "rgba(255, 230, 100, 0.28)"
                          : isInactive ? "rgba(255,255,255,0.03)" : "transparent",
                        boxShadow: isFlashing ? "inset 0 0 0 2px rgba(234,179,8,0.55)" : "none",
                        transition: "background 0.5s ease, box-shadow 0.5s ease",
                      }}
                    >
                      <div style={{ color: ctok.muted, fontSize: 12 }}>
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
                      <div style={{ color: ctok.text, lineHeight: 1.45, paddingRight: 12 }}>
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
                              border: `1px solid ${ctok.border}`,
                              background: ctok.inputBg, color: ctok.text,
                              outline: "none", resize: "vertical",
                            }}
                          />
                        ) : (
                          <>
                            {m.key && (
                              <span style={{
                                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                                fontSize: 11, color: ctok.muted, marginRight: 6,
                              }}>{m.key}</span>
                            )}
                            {m.content}
                            {isInactive && m.superseded_by && (
                              <span style={{
                                marginLeft: 8, fontSize: 11, color: ctok.muted,
                                fontStyle: "italic",
                              }}>→ superseded by #{m.superseded_by}</span>
                            )}
                            <SourceTrace source={m.source} />
                          </>
                        )}
                      </div>
                      <div style={{ color: ctok.muted, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
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
                              style={{ ...iconBtn(), color: ctok.bad }}
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

            {/* Pagination tail — scroll near the bottom pulls the next page. */}
            {memories.length > 0 && (
              <div style={{ padding: "16px 4px 4px", textAlign: "center", fontSize: 12, color: ctok.faint }}>
                {loadingMore
                  ? "Loading more…"
                  : hasMore
                    ? `${memories.length} of ${total} — scroll for more`
                    : `All ${total} loaded`}
              </div>
            )}
          </div>
        </div>
  );
}

// Provenance trace — "where did this memory come from". Note-sourced → click
// opens the note. Chat-sourced → click reveals the source utterance inline
// (no dedicated single-message view; the utterance text IS the trace). Renders
// nothing when no origin was recorded (old chat memories / injected prefs).
function SourceTrace({ source }: { source: MemorySource | null }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  if (!source) return null;

  const isNote = source.kind === "note";
  const label = isNote
    ? `from note: ${source.preview}`
    : `from ${source.channel || "chat"}${source.created_at ? ` · ${relativeTime(source.created_at)}` : ""}`;

  return (
    <div style={{ marginTop: 7 }}>
      <button
        onClick={() => {
          if (isNote && source.note_id != null) {
            navigate({
              to: "/",
              search: { note: source.note_id, conv: undefined, audit: undefined, segment: undefined, view: undefined },
            });
          } else {
            setOpen((v) => !v);
          }
        }}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "2px 9px", borderRadius: 999,
          border: `1px solid ${ctok.border}`, background: "transparent",
          color: ctok.faint, fontSize: 11, fontFamily: FONT, cursor: "pointer",
          transition: "color 0.12s, border-color 0.12s",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = ctok.text; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = ctok.faint; }}
        title={isNote ? "Open the source note" : "Show the source message"}
      >
        <span aria-hidden>{isNote ? "📄" : "💬"}</span>
        {label}
        <span aria-hidden style={{ opacity: 0.7 }}>{isNote ? "→" : open ? "▲" : "▼"}</span>
      </button>
      {open && !isNote && (
        <div style={{
          marginTop: 6, padding: "7px 11px", borderRadius: 8,
          background: ctok.inputBg, border: `1px solid ${ctok.border}`,
          fontSize: 12, color: ctok.muted, fontStyle: "italic", lineHeight: 1.5,
          maxWidth: 640,
        }}>
          “{source.preview}”
        </div>
      )}
    </div>
  );
}

function iconBtn(variant?: "primary"): React.CSSProperties {
  const primary = variant === "primary";
  return {
    padding: "4px 12px",
    fontSize: 11.5, fontFamily: FONT, fontWeight: primary ? 600 : 500,
    border: primary ? "none" : `1px solid ${ctok.hairline}`,
    background: primary ? ctok.accentDim : "transparent",
    color: primary ? ctok.accent : ctok.muted,
    borderRadius: 999, cursor: "pointer",
  };
}
