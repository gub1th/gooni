import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ActiveRulesCard } from "./ActiveRulesCard";
import {
  listEvalSegments,
  patchEvalSummary,
  type EvalSegmentSummary,
  type EvalStatus,
} from "../../services/api";
import { color as ctok, FONT } from "../../ui";
import { Dot, FilterDot, FilterGroup, FilterPill, TabButton } from "./EvalAtoms";
import { EvalRunsPanel } from "./EvalRunsPanel";
import { SegmentCard, SegmentRow, ViewToggle } from "./SegmentGrid";
import { EvalDetailView } from "./SegmentDetail";
import {
  SOURCE_STYLE,
  SOURCES,
  STATUS_STYLE,
  STATUSES,
} from "./evalShared";

// "audit" tab merged into "convos" — active feedback rules now render at
// the top of the convos surface and the chat-audit feed is reachable via
// the legacy /chat-audit route for power-user use. See PR #259 ticket.
type Tab = "convos" | "runs";

export function EvalView({ onOpenNote, initialSegmentId = null }: {
  onOpenNote?: (noteId: number) => void;
  // When the user deep-links via ?segment=N (e.g. from the Ops eval section's
  // "open full" button), pre-open that segment's drilldown on mount.
  initialSegmentId?: number | null;
} = {}) {
  const [tab, setTab] = useState<Tab>("convos");
  const [segments, setSegments] = useState<EvalSegmentSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters use INCLUSIVE semantics — empty array = "show everything from
  // this group". Click a pill → only that one is shown. Click another →
  // multi-select adds it. Click an active pill → removes it; revert to
  // "all" when the set goes empty. Old deselect-mode (default = all
  // selected, click = remove) was the #1 complaint on the audit page —
  // people thought clicking "Done" would show only done segments.
  const [sourcesFilter, setSourcesFilter] = useState<string[]>([]);
  const [statusesFilter, setStatusesFilter] = useState<EvalStatus[]>([]);
  const [hasFlagOnly, setHasFlagOnly] = useState(false);
  // Card-grid is browseable; list is dense triage view. Persist user's
  // pick across sessions — bot users with 80+ segments will live in list.
  const [viewMode, setViewMode] = useState<"list" | "cards">(() => {
    if (typeof window === "undefined") return "list";
    const saved = window.localStorage.getItem("eval-view-mode");
    return saved === "cards" || saved === "list" ? saved : "list";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("eval-view-mode", viewMode);
    }
  }, [viewMode]);
  // Min message count: filters out the noise of one-off "asd" / "hi" segments
  // that flood bot conversations. 3 is a low default that still cuts ~half
  // the obviously-trivial segments without hiding short legitimate ones.
  const [minMessages, setMinMessages] = useState(3);
  // Inbox-zero default: hide segments where overall_rating is set. Closing
  // the loop on triage shrinks the visible list as you rate, which is the
  // psychological win — review feels like clearing an inbox, not staring
  // at a long flat scroll. Persisted across sessions.
  const [hideRated, setHideRated] = useState(() => {
    if (typeof window === "undefined") return true;
    const saved = window.localStorage.getItem("eval-hide-rated");
    return saved == null ? true : saved === "true";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("eval-hide-rated", String(hideRated));
    }
  }, [hideRated]);
  const [search, setSearch] = useState("");

  const [selectedSegmentId, setSelectedSegmentId] = useState<number | null>(initialSegmentId);

  // Mirror selection ↔ ?segment so the eval page is deep-linkable. Without
  // this Cmd+L returns gooni.com/ for any segment drilldown, and refresh
  // bounces back to the segment list.
  const navigate = useNavigate({ from: "/" });
  const selectSegment = (id: number | null) => {
    setSelectedSegmentId(id);
    navigate({
      search: {
        note: undefined,
        conv: undefined,
        audit: true,
        segment: id ?? undefined,
        view: undefined,
      },
      replace: true,
    });
  };

  // Honor a fresh ?segment=N navigation after mount too — e.g. user clicks
  // "open full" on an Ops drilldown while already on /audit.
  useEffect(() => {
    if (initialSegmentId != null) setSelectedSegmentId(initialSegmentId);
  }, [initialSegmentId]);

  async function loadSegments() {
    setLoading(true);
    setError(null);
    try {
      const data = await listEvalSegments({
        sources: sourcesFilter,
        statuses: statusesFilter,
        hasFlag: hasFlagOnly,
        search: search.trim() || undefined,
        limit: 200,
      });
      setSegments(data.segments);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load segments");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSegments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesFilter.join(","), statusesFilter.join(","), hasFlagOnly]);

  function toggleSource(src: string) {
    setSourcesFilter((cur) =>
      cur.includes(src) ? cur.filter((s) => s !== src) : [...cur, src]
    );
  }

  function toggleStatus(s: EvalStatus) {
    setStatusesFilter((cur) =>
      cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]
    );
  }

  // Apply min-messages filter client-side so the slider feels instant.
  // MUST be declared before any conditional return — React hooks have to
  // run in the same order every render.
  const visible = useMemo(
    () =>
      segments.filter(
        (s) =>
          s.message_count >= minMessages &&
          (!hideRated || s.overall_rating == null)
      ),
    [segments, minMessages, hideRated]
  );

  // Per-source / per-status counts over the visible set — drives the
  // count badges on active filter pills. We count against `visible` so
  // the badge tracks what's actually on screen given the OTHER filters.
  const sourceCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const seg of visible) {
      out[seg.source] = (out[seg.source] ?? 0) + 1;
    }
    return out;
  }, [visible]);
  const statusCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const seg of visible) {
      out[seg.eval_status] = (out[seg.eval_status] ?? 0) + 1;
    }
    return out;
  }, [visible]);

  function clearAllFilters() {
    setSourcesFilter([]);
    setStatusesFilter([]);
    setHasFlagOnly(false);
    setSearch("");
  }

  // Keyboard cursor for one-key triage. j/k move; 1/2/3 rate the focused
  // segment and advance; n jumps to next unrated; Enter opens detail; Esc
  // clears the cursor. Skipped while a segment detail view is open or any
  // input is focused (so typing in search isn't hijacked).
  const [cursor, setCursor] = useState<number>(-1);
  useEffect(() => {
    // Reset cursor when filtered list shrinks/reshapes.
    if (cursor >= visible.length) setCursor(visible.length - 1);
  }, [visible.length, cursor]);
  // Triage in flight — guards against double-rating when key repeat fires
  // before the network round-trips.
  const triagingRef = useRef(false);

  // Keyboard-shortcut hint visibility. Hidden by default — shown when the
  // user presses "?" (standard convention) and toggles off the same way.
  // No persistence; we want it to feel ephemeral, not configured.
  const [showShortcuts, setShowShortcuts] = useState(false);
  // Mini-popover state for the "Min: N" dropdown (replaces the inline
  // number input in the filter rail).
  const [minOpen, setMinOpen] = useState(false);
  // Collapsible feedback rules — default collapsed (15 rules used to eat
  // the entire top of the page). Persisted across sessions.
  const [rulesOpen, setRulesOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("eval-rules-open") === "true";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("eval-rules-open", String(rulesOpen));
    }
  }, [rulesOpen]);

  async function triageRate(rating: 1 | 2 | 3) {
    if (cursor < 0 || cursor >= visible.length) return;
    if (triagingRef.current) return;
    triagingRef.current = true;
    const seg = visible[cursor];
    try {
      await patchEvalSummary(seg.id, {
        overall_rating: rating,
        eval_status: "done",
      });
      // Advance: when hideRated is on the rated card disappears, so the
      // same cursor index naturally points to the next card. Otherwise
      // bump cursor forward.
      if (!hideRated) setCursor((c) => Math.min(c + 1, visible.length - 1));
      await loadSegments();
    } finally {
      triagingRef.current = false;
    }
  }

  function jumpToNextUnrated() {
    const start = cursor + 1;
    for (let i = start; i < visible.length; i++) {
      if (visible[i].overall_rating == null) {
        setCursor(i);
        return;
      }
    }
    // Wrap to start if nothing found below.
    for (let i = 0; i <= cursor && i < visible.length; i++) {
      if (visible[i].overall_rating == null) {
        setCursor(i);
        return;
      }
    }
  }

  useEffect(() => {
    if (selectedSegmentId != null) return;
    function handler(e: KeyboardEvent) {
      // Skip when any text input is focused — search bar, comment fields, etc.
      const ae = document.activeElement;
      if (
        ae &&
        (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || (ae as HTMLElement).isContentEditable)
      ) {
        return;
      }
      if (visible.length === 0) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(Math.max(c, -1) + 1, visible.length - 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === "1" || e.key === "2" || e.key === "3") {
        e.preventDefault();
        void triageRate(Number(e.key) as 1 | 2 | 3);
      } else if (e.key === "n") {
        e.preventDefault();
        jumpToNextUnrated();
      } else if (e.key === "Enter") {
        if (cursor >= 0 && cursor < visible.length) {
          e.preventDefault();
          selectSegment(visible[cursor].id);
        }
      } else if (e.key === "Escape") {
        setCursor(-1);
      } else if (e.key === "?") {
        // Standard "show shortcuts" convention — same key toggles off.
        e.preventDefault();
        setShowShortcuts((v) => !v);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSegmentId, visible, cursor, hideRated]);

  if (selectedSegmentId != null) {
    return (
      <EvalDetailView
        segmentId={selectedSegmentId}
        onClose={() => {
          selectSegment(null);
          loadSegments();
        }}
        onOpenNote={onOpenNote}
      />
    );
  }

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        background: "var(--gooni-card, #FFFFFF)",
        fontFamily: FONT,
        overflow: "hidden",
      }}
    >
      {/* Header — sentence case title + segment count + tabs. Keyboard
          shortcut hints hidden by default; press "?" to surface. */}
      <div
        style={{
          padding: "20px 24px 0",
          borderBottom: `1px solid ${ctok.border}`,
          background: "var(--gooni-card, #FFFFFF)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: ctok.text }}>Audit</h1>
          {tab === "convos" && (
            <span style={{ fontSize: 12, color: ctok.muted, fontWeight: 500 }}>
              {visible.length}
              {visible.length !== total ? ` of ${total}` : ""} segments
            </span>
          )}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={() => setShowShortcuts((v) => !v)}
              title="Show keyboard shortcuts (?)"
              style={{
                width: 22,
                height: 22,
                borderRadius: "50%",
                border: `1px solid ${ctok.border}`,
                background: showShortcuts ? "rgba(10,132,255,0.10)" : "transparent",
                color: showShortcuts ? ctok.accent : ctok.muted,
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: FONT,
                lineHeight: 1,
                padding: 0,
              }}
            >
              ?
            </button>
            {showShortcuts && (
              <span style={{ fontSize: 11, color: ctok.muted }}>
                j/k · 1/2/3 · n · ⏎
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 0, marginTop: 14 }}>
          <TabButton active={tab === "convos"} onClick={() => setTab("convos")}>Conversations</TabButton>
          <TabButton active={tab === "runs"} onClick={() => setTab("runs")}>Runs</TabButton>
        </div>
      </div>

      {tab === "runs" ? (
        <EvalRunsPanel />
      ) : (
        <>
          {/* Active feedback rules — collapsed by default. Header shows
              count + dismiss; expands on click and persists in localStorage. */}
          <ActiveRulesCard
            collapsedDefault
            open={rulesOpen}
            onToggle={() => setRulesOpen((v) => !v)}
          />

          {/* Filter rail — row 1: search + view toggle. */}
          <div
            style={{
              padding: "12px 24px 8px",
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            <input
              type="search"
              placeholder="Search transcripts…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") loadSegments();
              }}
              style={{
                flex: 1,
                padding: "7px 14px",
                border: `1px solid ${ctok.border}`,
                borderRadius: 10,
                fontSize: 13,
                fontFamily: FONT,
                outline: "none",
                background: ctok.bg,
              }}
            />
            <ViewToggle mode={viewMode} onChange={setViewMode} />
          </div>

          {/* Filter rail — row 2: source · status · binary toggles · min. */}
          <div
            style={{
              padding: "0 24px 14px",
              borderBottom: `1px solid ${ctok.border}`,
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              alignItems: "center",
              rowGap: 8,
              flexShrink: 0,
            }}
          >
            <FilterGroup label="Source:">
              {SOURCES.map((src) => (
                <FilterPill
                  key={src}
                  active={sourcesFilter.includes(src)}
                  accent={SOURCE_STYLE[src]?.accent ?? ctok.muted}
                  count={sourcesFilter.includes(src) ? sourceCounts[src] ?? 0 : undefined}
                  onClick={() => toggleSource(src)}
                >
                  <Dot color={SOURCE_STYLE[src]?.accent ?? ctok.muted} />
                  {SOURCE_STYLE[src]?.label}
                </FilterPill>
              ))}
            </FilterGroup>
            <FilterDot />
            <FilterGroup label="Status:">
              {STATUSES.map((s) => (
                <FilterPill
                  key={s}
                  active={statusesFilter.includes(s)}
                  accent={STATUS_STYLE[s].color}
                  count={statusesFilter.includes(s) ? statusCounts[s] ?? 0 : undefined}
                  onClick={() => toggleStatus(s)}
                >
                  {STATUS_STYLE[s].label}
                </FilterPill>
              ))}
            </FilterGroup>
            <FilterDot />
            <FilterPill
              active={hasFlagOnly}
              accent={ctok.danger}
              onClick={() => setHasFlagOnly((v) => !v)}
            >
              Flagged
            </FilterPill>
            <FilterPill
              active={hideRated}
              accent={ctok.accent}
              onClick={() => setHideRated((v) => !v)}
            >
              {hideRated ? "Unrated" : "All ratings"}
            </FilterPill>
            <FilterDot />
            <div style={{ position: "relative" }}>
              <button
                onClick={() => setMinOpen((v) => !v)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 11,
                  fontWeight: 500,
                  fontFamily: FONT,
                  border: `0.5px solid ${ctok.border}`,
                  background: "transparent",
                  color: ctok.muted,
                  padding: "3px 10px",
                  borderRadius: 999,
                  cursor: "pointer",
                }}
              >
                Min: {minMessages} ▾
              </button>
              {minOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 6px)",
                    left: 0,
                    zIndex: 20,
                    background: "var(--gooni-card, #FFFFFF)",
                    border: `1px solid ${ctok.border}`,
                    borderRadius: 10,
                    padding: "10px 12px",
                    boxShadow: "0 4px 18px rgba(15,23,42,0.10)",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontFamily: FONT,
                  }}
                  onMouseLeave={() => setMinOpen(false)}
                >
                  <input
                    type="range"
                    min={1}
                    max={50}
                    value={minMessages}
                    onChange={(e) => setMinMessages(Math.max(1, Number(e.target.value) || 1))}
                    style={{ width: 140 }}
                  />
                  <span style={{ fontSize: 12, fontWeight: 600, width: 24, textAlign: "right" }}>
                    {minMessages}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Grid */}
          <div style={{ flex: 1, overflow: "auto", padding: 24, background: ctok.bg }}>
            {error && (
              <div style={{ color: ctok.danger, fontSize: 13, marginBottom: 12 }}>{error}</div>
            )}
            {loading && visible.length === 0 ? (
              <div style={{ color: ctok.muted, fontSize: 13 }}>Loading…</div>
            ) : visible.length === 0 ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  textAlign: "center",
                  padding: "60px 20px",
                  color: ctok.muted,
                  gap: 12,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 500, color: ctok.text }}>
                  No conversations match these filters
                </div>
                <div style={{ fontSize: 12, color: ctok.muted, maxWidth: 360 }}>
                  {segments.length === 0
                    ? "Widen your source / status pills, or clear the search."
                    : `All ${segments.length} loaded segment${segments.length === 1 ? "" : "s"} are below the min-msg threshold of ${minMessages}.`}
                </div>
                <button
                  onClick={clearAllFilters}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 8,
                    border: `1px solid ${ctok.border}`,
                    background: "transparent",
                    color: ctok.accent,
                    fontFamily: FONT,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Clear filters
                </button>
              </div>
            ) : viewMode === "list" ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  background: "var(--gooni-card, #FFFFFF)",
                  border: `1px solid ${ctok.border}`,
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                {visible.map((seg, i) => (
                  <SegmentRow
                    key={seg.id}
                    seg={seg}
                    isFirst={i === 0}
                    focused={i === cursor}
                    onClick={() => {
                      setCursor(i);
                      selectSegment(seg.id);
                    }}
                  />
                ))}
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                  gap: 14,
                }}
              >
                {visible.map((seg, i) => (
                  <SegmentCard
                    key={seg.id}
                    seg={seg}
                    focused={i === cursor}
                    onClick={() => {
                      setCursor(i);
                      setSelectedSegmentId(seg.id);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
