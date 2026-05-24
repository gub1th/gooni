import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ActiveRulesCard } from "./ActiveRulesCard";
import {
  BASE,
  apiFetch,
  deleteMessageRating,
  dispatchEvalToCc,
  fetchEvalSegmentFull,
  fetchEvalToolsLegend,
  fetchReflections,
  listEvalSegments,
  patchEvalSummary,
  postEvalFeedback,
  putMessageRating,
  runProdSnapshotEval,
  type EvalMessage,
  type EvalMessageRating,
  type EvalRunEvent,
  type EvalSegmentFull,
  type EvalSegmentSummary,
  type EvalStatus,
  type EvalToolCall,
  type EvalToolLegendEntry,
  type MessageTraceStep,
} from "../../services/api";
import { Check, Minus, X } from "lucide-react";
import { FONT } from "../../ui";


// Per-source visual identity. Tone matches Apple-Notes restraint that the
// rest of Gooni uses: muted accent dot + label, not loud full-fill badges.
// `accent` colors stay deliberately desaturated so cards read as a quiet
// grid, not a status board.
// Distinct per-source palette — Daniel called out that everything was
// the same green. WhatsApp gets the brand green; Telegram + iMessage get
// blues from their respective brand families (slightly differentiated so
// they're not literally identical); Web stays a neutral generic blue.
const SOURCE_STYLE: Record<
  string,
  { accent: string; label: string }
> = {
  web: { accent: "#378ADD", label: "Web" },
  telegram: { accent: "#229ED9", label: "Telegram" },
  whatsapp: { accent: "#25D366", label: "WhatsApp" },
  imessage: { accent: "#534AB7", label: "iMessage" },
};

// Color-coded status pills — DONE green / PENDING amber / NOT YET neutral.
// Same palette family as the dashboard's age indicator, so the eyes already
// know which is which.
const STATUS_STYLE: Record<EvalStatus, { color: string; bg: string; label: string }> = {
  not_yet: { color: "#8E8E93", bg: "#F2F2F7", label: "Not yet" },
  pending: { color: "#633806", bg: "#FAEEDA", label: "Pending" },
  done: { color: "#085041", bg: "#E1F5EE", label: "Done" },
};

const SOURCES = ["web", "telegram", "whatsapp", "imessage"] as const;
const STATUSES: EvalStatus[] = ["not_yet", "pending", "done"];

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
        list: undefined,
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
        background: "#FFFFFF",
        fontFamily: FONT,
        overflow: "hidden",
      }}
    >
      {/* Header — sentence case title + segment count + tabs. Keyboard
          shortcut hints hidden by default; press "?" to surface. */}
      <div
        style={{
          padding: "20px 24px 0",
          borderBottom: "1px solid rgba(0,0,0,0.06)",
          background: "#FFFFFF",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#1C1C1E" }}>Audit</h1>
          {tab === "convos" && (
            <span style={{ fontSize: 12, color: "#8E8E93", fontWeight: 500 }}>
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
                border: "1px solid rgba(0,0,0,0.10)",
                background: showShortcuts ? "rgba(10,132,255,0.10)" : "transparent",
                color: showShortcuts ? "#0A84FF" : "#8E8E93",
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
              <span style={{ fontSize: 11, color: "#8E8E93" }}>
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
                border: "1px solid #E5E5EA",
                borderRadius: 10,
                fontSize: 13,
                fontFamily: FONT,
                outline: "none",
                background: "#FAFAFA",
              }}
            />
            <ViewToggle mode={viewMode} onChange={setViewMode} />
          </div>

          {/* Filter rail — row 2: source · status · binary toggles · min. */}
          <div
            style={{
              padding: "0 24px 14px",
              borderBottom: "1px solid rgba(0,0,0,0.04)",
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
                  accent={SOURCE_STYLE[src]?.accent ?? "#8E8E93"}
                  count={sourcesFilter.includes(src) ? sourceCounts[src] ?? 0 : undefined}
                  onClick={() => toggleSource(src)}
                >
                  <Dot color={SOURCE_STYLE[src]?.accent ?? "#8E8E93"} />
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
              accent="#FF3B30"
              onClick={() => setHasFlagOnly((v) => !v)}
            >
              Flagged
            </FilterPill>
            <FilterPill
              active={hideRated}
              accent="#0A84FF"
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
                  border: "0.5px solid rgba(0,0,0,0.10)",
                  background: "transparent",
                  color: "#8E8E93",
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
                    background: "#FFFFFF",
                    border: "1px solid rgba(0,0,0,0.10)",
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
          <div style={{ flex: 1, overflow: "auto", padding: 24, background: "#FAFAFA" }}>
            {error && (
              <div style={{ color: "#FF3B30", fontSize: 13, marginBottom: 12 }}>{error}</div>
            )}
            {loading && visible.length === 0 ? (
              <div style={{ color: "#8E8E93", fontSize: 13 }}>Loading…</div>
            ) : visible.length === 0 ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  textAlign: "center",
                  padding: "60px 20px",
                  color: "#8E8E93",
                  gap: 12,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 500, color: "#1C1C1E" }}>
                  No conversations match these filters
                </div>
                <div style={{ fontSize: 12, color: "#8E8E93", maxWidth: 360 }}>
                  {segments.length === 0
                    ? "Widen your source / status pills, or clear the search."
                    : `All ${segments.length} loaded segment${segments.length === 1 ? "" : "s"} are below the min-msg threshold of ${minMessages}.`}
                </div>
                <button
                  onClick={clearAllFilters}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 8,
                    border: "1px solid rgba(0,0,0,0.10)",
                    background: "transparent",
                    color: "#0A84FF",
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
                  background: "#FFFFFF",
                  border: "1px solid #E5E5EA",
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

// ── Card ─────────────────────────────────────────────────────────────────────

function SegmentCard({
  seg,
  onClick,
  focused = false,
}: {
  seg: EvalSegmentSummary;
  onClick: () => void;
  focused?: boolean;
}) {
  const sourceStyle = SOURCE_STYLE[seg.source] ?? SOURCE_STYLE.web;
  const when = seg.last_message_at ? parseUtcIso(seg.last_message_at) : null;
  const ref = useRef<HTMLButtonElement>(null);
  // Auto-scroll the focused card into view so j/k feels like cursor nav,
  // not "you've now lost where you are." Block: nearest avoids unnecessary
  // jumping when the card is already visible.
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  return (
    <button
      ref={ref}
      onClick={onClick}
      style={{
        textAlign: "left",
        padding: "14px 16px",
        borderRadius: 12,
        background: focused ? "#EAF3FF" : "#FFFFFF",
        border: focused ? "1px solid #0A84FF" : "0.5px solid rgba(0,0,0,0.10)",
        cursor: "pointer",
        fontFamily: FONT,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 130,
        transition: "background 0.12s, border-color 0.12s",
        outline: "none",
      }}
      onMouseEnter={(e) => {
        if (focused) return;
        e.currentTarget.style.background = "#FAFAFA";
        e.currentTarget.style.borderColor = "rgba(0,0,0,0.18)";
      }}
      onMouseLeave={(e) => {
        if (focused) return;
        e.currentTarget.style.background = "#FFFFFF";
        e.currentTarget.style.borderColor = "rgba(0,0,0,0.10)";
      }}
    >
      {/* Top — source + status pill. Source reads as the primary id of
          this card, status reads as the state. */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: sourceStyle.accent,
            fontWeight: 600,
            letterSpacing: 0.1,
          }}
        >
          <Dot color={sourceStyle.accent} />
          {sourceStyle.label}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {seg.is_active && <ActiveBadge />}
          <StatusPill status={seg.eval_status} />
        </span>
      </div>
      {/* Middle — preview text, muted, wraps. */}
      <div
        style={{
          fontSize: 13,
          color: "#475569",
          lineHeight: 1.45,
          flex: 1,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
        }}
      >
        {seg.preview || <em style={{ color: "#8E8E93" }}>(no user message)</em>}
      </div>
      {/* Bottom — metadata + action indicators. */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
          color: "#8E8E93",
        }}
      >
        <span>
          {seg.message_count} msg{when ? ` · ${formatDate(when)}` : ""}
          {seg.cost_usd != null && seg.cost_usd > 0 && (
            <span style={{ color: "#8E8E93" }}> · ${seg.cost_usd.toFixed(4)}</span>
          )}
        </span>
        <span style={{ display: "flex", gap: 8 }}>
          {seg.flag_count > 0 && (
            <span style={{ color: "#A1742B" }}>{seg.flag_count} flag{seg.flag_count === 1 ? "" : "s"}</span>
          )}
          {seg.dispatched_to_cc_at && (
            <span style={{ color: "#0A84FF" }}>→ CC</span>
          )}
        </span>
      </div>
    </button>
  );
}

// ── Compact list row ─────────────────────────────────────────────────────────

function SegmentRow({
  seg,
  isFirst,
  onClick,
  focused = false,
}: {
  seg: EvalSegmentSummary;
  isFirst: boolean;
  onClick: () => void;
  focused?: boolean;
}) {
  const sourceStyle = SOURCE_STYLE[seg.source] ?? SOURCE_STYLE.web;
  const when = seg.last_message_at ? parseUtcIso(seg.last_message_at) : null;
  const statusStyle = STATUS_STYLE[seg.eval_status];
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  return (
    <button
      ref={ref}
      onClick={onClick}
      style={{
        textAlign: "left",
        padding: "10px 14px",
        background: focused ? "#EAF3FF" : "#FFFFFF",
        border: "none",
        borderTop: isFirst ? "none" : "1px solid #F2F2F7",
        borderLeft: focused ? "3px solid #0A84FF" : "3px solid transparent",
        cursor: "pointer",
        fontFamily: FONT,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minHeight: 48,
        transition: "background 0.08s",
      }}
      onMouseEnter={(e) => {
        if (focused) return;
        e.currentTarget.style.background = "#FAFAFA";
      }}
      onMouseLeave={(e) => {
        if (focused) return;
        e.currentTarget.style.background = "#FFFFFF";
      }}
    >
      {/* Primary row — source + msg count + time on the left, status pill
          on the right. The meaningful identifier of the segment lives
          here, not in the first-message preview (which is often a
          mid-thought fragment and looked like a chopped-up title). */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 12,
            color: sourceStyle.accent,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          <Dot color={sourceStyle.accent} />
          {sourceStyle.label}
        </span>
        <span style={{ fontSize: 11, color: "#8E8E93", flexShrink: 0 }}>
          · {seg.message_count} msg{when ? ` · ${formatDate(when)}` : ""}
        </span>
        <span style={{ flex: 1 }} />
        {seg.flag_count > 0 && (
          <span style={{ fontSize: 11, color: "#A1742B", flexShrink: 0 }}>
            {seg.flag_count} flag{seg.flag_count === 1 ? "" : "s"}
          </span>
        )}
        {seg.dispatched_to_cc_at && (
          <span style={{ fontSize: 11, color: "#0A84FF", flexShrink: 0 }}>→ CC</span>
        )}
        <span
          style={{
            fontSize: 10,
            color: statusStyle.color,
            background: statusStyle.bg,
            padding: "2px 6px",
            borderRadius: 4,
            letterSpacing: 0.3,
            fontWeight: 600,
            textTransform: "uppercase",
            flexShrink: 0,
          }}
        >
          {statusStyle.label}
        </span>
      </div>
      {/* Secondary row — first-message preview as muted snippet. ~80 char
          cap with ellipsis keeps a long stream-of-thought sentence from
          taking over the row. */}
      {seg.preview && (
        <div
          style={{
            fontSize: 12.5,
            color: "#6E6E73",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            lineHeight: 1.4,
          }}
        >
          {truncate(seg.preview, 90)}
        </div>
      )}
    </button>
  );
}

// ── View toggle ──────────────────────────────────────────────────────────────

function ViewToggle({
  mode,
  onChange,
}: {
  mode: "list" | "cards";
  onChange: (m: "list" | "cards") => void;
}) {
  // Matches FilterGroup's segmented look: gray track, active = white fill +
  // soft shadow. Keeps the whole toolbar visually consistent.
  const btn = (active: boolean): React.CSSProperties => ({
    padding: "3px 10px",
    fontSize: 12,
    fontFamily: FONT,
    background: active ? "#FFFFFF" : "transparent",
    color: active ? "#1C1C1E" : "#6E6E73",
    border: "none",
    borderRadius: 5,
    cursor: "pointer",
    lineHeight: 1,
    boxShadow: active ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
    fontWeight: active ? 600 : 500,
    transition: "background 0.1s, color 0.1s, box-shadow 0.1s",
    outline: "none",
  });
  return (
    <div
      style={{
        display: "inline-flex",
        padding: 2,
        background: "#F2F2F7",
        borderRadius: 7,
      }}
    >
      <button style={btn(mode === "list")} onClick={() => onChange("list")} title="List view">
        ≡
      </button>
      <button style={btn(mode === "cards")} onClick={() => onChange("cards")} title="Card view">
        ▦
      </button>
    </div>
  );
}

// ── Detail view ──────────────────────────────────────────────────────────────

function EvalDetailView({
  segmentId,
  onClose,
  onOpenNote,
}: {
  segmentId: number;
  onClose: () => void;
  onOpenNote?: (noteId: number) => void;
}) {
  const [data, setData] = useState<EvalSegmentFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [legend, setLegend] = useState<EvalToolLegendEntry[]>([]);
  const [legendOpen, setLegendOpen] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  // Dispatch modal: 'confirm' opens before send, 'success' after, with the
  // note id we navigate to via onOpenNote. 'error' shows the failure reason
  // inline instead of a browser alert().
  const [dispatchModal, setDispatchModal] = useState<
    | { state: "closed" }
    | { state: "confirm" }
    | { state: "running" }
    | { state: "success"; noteId: number; rewrote: boolean }
    | { state: "error"; message: string }
  >({ state: "closed" });

  async function reload() {
    try {
      setLoading(true);
      const full = await fetchEvalSegmentFull(segmentId);
      setData(full);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    fetchEvalToolsLegend()
      .then((r) => setLegend(r.tools))
      .catch(() => setLegend([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentId]);

  function handleDispatch() {
    if (!data) return;
    setDispatchModal({ state: "confirm" });
  }

  async function runDispatch() {
    setDispatching(true);
    setDispatchModal({ state: "running" });
    const wasDispatched = !!data?.segment.dispatched_to_cc_at;
    try {
      const res = await dispatchEvalToCc(segmentId);
      await reload();
      setDispatchModal({
        state: "success",
        noteId: res.note_id,
        rewrote: wasDispatched,
      });
    } catch (err) {
      setDispatchModal({
        state: "error",
        message: err instanceof Error ? err.message : "Dispatch failed",
      });
    } finally {
      setDispatching(false);
    }
  }

  // Cycle the segment status via the header pill — the single status entry
  // point. not_yet → pending → done → not_yet.
  async function cycleStatus() {
    if (!data) return;
    const order: EvalStatus[] = ["not_yet", "pending", "done"];
    const cur = data.segment.eval_status;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    try {
      await patchEvalSummary(segmentId, { eval_status: next });
      await reload();
    } catch (err) {
      console.error("status cycle failed", err);
    }
  }

  const seg = data?.segment;

  return (
    <div
      id="eval-print-root"
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        background: "#FAFAFA",
        fontFamily: FONT,
        overflow: "hidden",
      }}
    >
      {/* Print stylesheet — hides app chrome (sidebars, header buttons,
          dispatch / legend / status pill cycle hint) and lets the segment
          body flow into the printable page. window.print() → "Save as PDF"
          captures whatever's left visible. The button itself is marked
          eval-no-print so it doesn't shimmer into the saved PDF. */}
      <style>{`
        @media print {
          /* Let the page grow past viewport — ancestors have overflow:hidden
             + fixed heights in normal use, both must release for paged media
             or the printed content gets clipped to page 1. */
          html, body { height: auto !important; overflow: visible !important; }
          body * { visibility: hidden !important; }
          #eval-print-root, #eval-print-root * { visibility: visible !important; }
          /* Pull print-root to top of page and let height flow naturally.
             inset:0 locked us to viewport size → only first page rendered. */
          #eval-print-root {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            height: auto !important;
            max-height: none !important;
            overflow: visible !important;
            background: #fff !important;
            padding: 24px !important;
          }
          /* Neutralize inner scroll containers (transcript body, code blocks)
             so their content paginates instead of being trapped in a scroller. */
          #eval-print-root * {
            overflow: visible !important;
            max-height: none !important;
          }
          .eval-no-print { display: none !important; }
          /* StatusPill cursor hint isn't useful in a static PDF. */
          #eval-print-root button[disabled] { opacity: 1 !important; }
        }
      `}</style>
      {/* Header */}
      <div
        style={{
          padding: "16px 24px",
          borderBottom: "1px solid rgba(0,0,0,0.06)",
          background: "#FFFFFF",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexShrink: 0,
        }}
      >
        <button
          onClick={onClose}
          className="eval-no-print"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: 14,
            color: "#0A84FF",
            padding: 0,
          }}
        >
          ← Back
        </button>
        {seg && (
          <>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              Segment #{seg.id}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#3C3C43" }}>
              <Dot color={SOURCE_STYLE[seg.source]?.accent ?? "#8E8E93"} />
              {SOURCE_STYLE[seg.source]?.label}
            </span>
            {seg.is_active && <ActiveBadge />}
            <StatusPill status={seg.eval_status} onCycle={cycleStatus} />
            {data && <RatedProgressBadge data={data} />}
          </>
        )}
        <div className="eval-no-print" style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={() => setLegendOpen((v) => !v)}
            title="Tool legend — what each step means"
            style={{
              background: "none",
              border: "1px solid #E5E5EA",
              borderRadius: 6,
              padding: "4px 10px",
              cursor: "pointer",
              fontSize: 12,
              fontFamily: FONT,
            }}
          >
            ⓘ Legend
          </button>
          <button
            onClick={() => window.print()}
            title="Save this segment as a PDF (Cmd/Ctrl-P · Save as PDF)"
            style={{
              background: "transparent",
              color: "#0A84FF",
              border: "1px solid rgba(10,132,255,0.30)",
              borderRadius: 6,
              padding: "5px 12px",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              fontFamily: FONT,
            }}
          >
            Export PDF
          </button>
          <button
            onClick={handleDispatch}
            disabled={dispatching}
            style={{
              background: seg?.dispatched_to_cc_at ? "#34C759" : "#0A84FF",
              color: "#FFFFFF",
              border: "none",
              borderRadius: 6,
              padding: "6px 14px",
              cursor: dispatching ? "wait" : "pointer",
              fontSize: 12,
              fontWeight: 600,
              fontFamily: FONT,
              opacity: dispatching ? 0.6 : 1,
            }}
          >
            {dispatching
              ? "Dispatching…"
              : seg?.dispatched_to_cc_at
                ? "Re-dispatch ✓"
                : "Dispatch to Claude Code"}
          </button>
        </div>
      </div>

      {/* Body: summary editor + transcript */}
      <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
        {error && <div style={{ color: "#FF3B30" }}>{error}</div>}
        {loading && !data ? (
          <div style={{ color: "#8E8E93", fontSize: 13 }}>Loading…</div>
        ) : data ? (
          <>
            <SummaryEditor
              segmentId={segmentId}
              initial={data.segment}
              onSummaryPatched={(patch) =>
                setData((prev) =>
                  prev ? { ...prev, segment: { ...prev.segment, ...patch } } : prev,
                )
              }
            />
            <h3 style={{ marginTop: 24, marginBottom: 12, fontSize: 14, fontWeight: 600 }}>
              Transcript ({data.messages.length} messages)
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {data.messages.map((m) => (
                <MessageCard
                  key={m.id}
                  segmentId={segmentId}
                  msg={m}
                  onFeedbackChanged={reload}
                  onRatingPatched={(mid, rating) =>
                    setData((prev) =>
                      prev
                        ? {
                            ...prev,
                            messages: prev.messages.map((mm) =>
                              mm.id === mid ? { ...mm, rating } : mm,
                            ),
                          }
                        : prev,
                    )
                  }
                />
              ))}
            </div>
          </>
        ) : null}
      </div>

      {legendOpen && <ToolLegendPopup entries={legend} onClose={() => setLegendOpen(false)} />}

      {dispatchModal.state !== "closed" && (
        <DispatchModal
          modal={dispatchModal}
          alreadyDispatched={!!data?.segment.dispatched_to_cc_at}
          onConfirm={runDispatch}
          onClose={() => setDispatchModal({ state: "closed" })}
          onOpenNote={onOpenNote}
        />
      )}
    </div>
  );
}

// ── Dispatch modal ───────────────────────────────────────────────────────────

type DispatchModalState =
  | { state: "closed" }
  | { state: "confirm" }
  | { state: "running" }
  | { state: "success"; noteId: number; rewrote: boolean }
  | { state: "error"; message: string };

function DispatchModal({
  modal,
  alreadyDispatched,
  onConfirm,
  onClose,
  onOpenNote,
}: {
  modal: DispatchModalState;
  alreadyDispatched: boolean;
  onConfirm: () => void;
  onClose: () => void;
  onOpenNote?: (noteId: number) => void;
}) {
  if (modal.state === "closed") return null;

  return (
    <div
      onClick={modal.state === "running" ? undefined : onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.32)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        fontFamily: FONT,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#FFFFFF",
          borderRadius: 12,
          padding: "20px 22px",
          width: 420,
          maxWidth: "92vw",
          boxShadow: "0 20px 50px rgba(0,0,0,0.18)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {modal.state === "confirm" && (
          <>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#1C1C1E" }}>
              {alreadyDispatched ? "Re-dispatch this eval?" : "Dispatch this eval to Claude Code?"}
            </div>
            <div style={{ fontSize: 13, color: "#3C3C43", lineHeight: 1.5 }}>
              {alreadyDispatched
                ? "Overwrites the existing Claude Code note with the latest transcript + flags. Backlog item stays."
                : "Creates a note in the Claude Code space and a backlog item linking back to this segment."}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <ModalButton onClick={onClose} variant="ghost">Cancel</ModalButton>
              <ModalButton onClick={onConfirm} variant="primary">
                {alreadyDispatched ? "Re-dispatch" : "Dispatch"}
              </ModalButton>
            </div>
          </>
        )}
        {modal.state === "running" && (
          <div style={{ fontSize: 14, color: "#3C3C43" }}>Dispatching…</div>
        )}
        {modal.state === "success" && (
          <>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#1C1C1E" }}>
              {modal.rewrote ? "Note overwritten" : "Note created"}
            </div>
            <div style={{ fontSize: 13, color: "#3C3C43", lineHeight: 1.5 }}>
              Eval bundled into note <strong>#{modal.noteId}</strong> in the Claude Code space.
              Backlog item added.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <ModalButton onClick={onClose} variant="ghost">Close</ModalButton>
              {onOpenNote && (
                <ModalButton
                  onClick={() => {
                    onOpenNote(modal.noteId);
                    onClose();
                  }}
                  variant="primary"
                >
                  Open note →
                </ModalButton>
              )}
            </div>
          </>
        )}
        {modal.state === "error" && (
          <>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#FF3B30" }}>Dispatch failed</div>
            <div style={{ fontSize: 13, color: "#3C3C43", lineHeight: 1.5 }}>{modal.message}</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <ModalButton onClick={onClose} variant="ghost">Close</ModalButton>
              <ModalButton onClick={onConfirm} variant="primary">Retry</ModalButton>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ModalButton({
  children,
  onClick,
  variant,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant: "primary" | "ghost";
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: variant === "primary" ? "#0A84FF" : "transparent",
        color: variant === "primary" ? "#FFFFFF" : "#0A84FF",
        border: variant === "primary" ? "none" : "1px solid #E5E5EA",
        borderRadius: 6,
        padding: "6px 14px",
        fontSize: 13,
        fontWeight: 600,
        fontFamily: FONT,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

// ── Summary editor ───────────────────────────────────────────────────────────

function SummaryEditor({
  segmentId,
  initial,
  onSummaryPatched,
}: {
  segmentId: number;
  initial: EvalSegmentSummary;
  // Patch the segment summary into the parent's local state — same
  // "no full refetch" rule as MessageRatingRow.
  onSummaryPatched: (patch: Partial<EvalSegmentSummary>) => void;
}) {
  const [rating, setRating] = useState<number | null>(initial.overall_rating);
  const [comment, setComment] = useState(initial.overall_comment ?? "");
  const [saving, setSaving] = useState(false);
  // Status flips via the header pill, not here — Overall is just rating + comment.
  const dirty =
    rating !== initial.overall_rating ||
    comment !== (initial.overall_comment ?? "");

  async function save() {
    setSaving(true);
    try {
      const updated = await patchEvalSummary(segmentId, {
        overall_rating: rating,
        overall_comment: comment,
      });
      onSummaryPatched({
        overall_rating: updated.overall_rating,
        overall_comment: updated.overall_comment,
        eval_status: updated.eval_status,
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        background: "#FFFFFF",
        border: "1px solid #E5E5EA",
        borderRadius: 12,
        padding: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>Overall</strong>
        <RatingPicker value={rating} onChange={setRating} />
        {/* Status entry point moved to the clickable pill in the header.
            This row is now rating + comment + save only. */}
        <button
          onClick={save}
          disabled={!dirty || saving}
          style={{
            marginLeft: "auto",
            background: dirty ? "#0A84FF" : "#E5E5EA",
            color: dirty ? "#FFFFFF" : "#8E8E93",
            border: "none",
            borderRadius: 6,
            padding: "6px 14px",
            cursor: dirty && !saving ? "pointer" : "default",
            fontSize: 12,
            fontWeight: 600,
            fontFamily: FONT,
          }}
        >
          {saving ? "Saving…" : "Save summary"}
        </button>
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Overall comment for this segment (what worked, what didn't, what to fix)…"
        rows={3}
        style={{
          width: "100%",
          padding: 8,
          border: "1px solid #E5E5EA",
          borderRadius: 6,
          fontSize: 13,
          fontFamily: FONT,
          resize: "vertical",
          outline: "none",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}

// ── Message card with trace + step flags ─────────────────────────────────────

function MessageCard({
  segmentId,
  msg,
  onFeedbackChanged,
  onRatingPatched,
}: {
  segmentId: number;
  msg: EvalMessage;
  onFeedbackChanged: () => void;
  onRatingPatched: (messageId: number, rating: EvalMessageRating | null) => void;
}) {
  // Trace defaults to collapsed — flipped from the previous "expanded for
  // assistant" default because the wall-of-JSON was the #1 friction source
  // when reviewing a long segment. The reviewer opens trace only when the
  // reply itself looks suspect.
  const isAssistant = msg.role === "assistant";
  const [traceOpen, setTraceOpen] = useState(false);
  const trace = msg.trace ?? [];

  // Index step feedback by (step_key, step_index) so each step card knows
  // its existing rating/comment without scanning the whole list per render.
  const fbByStep = useMemo(() => {
    const map = new Map<string, EvalMessage["step_feedback"][number]>();
    for (const fb of msg.step_feedback) {
      map.set(`${fb.step_key}::${fb.step_index}`, fb);
    }
    return map;
  }, [msg.step_feedback]);

  // Subtle role distinction — Apple-Notes restraint, not iMessage bubbles.
  // User = white card on the left half. Assistant = soft tinted card on the
  // right half-ish, with a thin accent edge so the eye snaps to who said
  // what without bright bubbles fighting the trace cards.
  const cardStyle = isAssistant
    ? {
        background: "#F5F8FB",
        border: "1px solid #E2E9F0",
        borderLeft: "3px solid #B6CFE8",
      }
    : {
        background: "#FFFFFF",
        border: "1px solid #E5E5EA",
        borderLeft: "3px solid #D1D1D6",
      };

  return (
    <div
      style={{
        ...cardStyle,
        borderRadius: 12,
        padding: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.3,
          color: isAssistant ? "#3A6AA1" : "#6E6E73",
        }}
      >
        <strong>{msg.role}</strong>
        <span style={{ color: "#8E8E93" }}>· #{msg.id}</span>
        {msg.created_at && (
          <span style={{ color: "#8E8E93" }}>
            · {new Date(msg.created_at).toLocaleString()}
          </span>
        )}
        {msg.is_feedback && <span style={{ color: "#FF9500" }}>· feedback</span>}
      </div>
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: "#1C1C1E",
        }}
      >
        {msg.content}
      </div>

      {isAssistant && (
        <MessageRatingRow
          segmentId={segmentId}
          messageId={msg.id}
          existing={msg.rating}
          onRatingPatched={onRatingPatched}
        />
      )}

      {isAssistant && (
        <div style={{ marginTop: 12 }}>
          <button
            onClick={() => setTraceOpen((v) => !v)}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              color: "#0A84FF",
              fontSize: 12,
              fontFamily: FONT,
            }}
          >
            {traceOpen ? "▾" : "▸"} Trace
            {trace.length > 0
              ? ` (${trace.length} step${trace.length === 1 ? "" : "s"})`
              : " (none recorded)"}
          </button>
          {traceOpen && trace.length === 0 && (
            <div
              style={{
                marginTop: 6,
                fontSize: 12,
                color: "#8E8E93",
                fontStyle: "italic",
                lineHeight: 1.4,
              }}
            >
              No trace recorded for this assistant turn. Older replies (sent before
              the eval pipeline was instrumented) carry no trace data — only new
              chat turns will have intent / memory_recall / master_prompt /
              extracted_signals / memories_applied / tool_call / reply steps.
            </div>
          )}
          {traceOpen && trace.length > 0 && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
              {trace.map((step, idx) => {
                const stepKey = (step.key ?? step.type) as string;
                const fb = fbByStep.get(`${stepKey}::${idx}`) ?? null;
                return (
                  <StepCard
                    key={`${stepKey}-${idx}`}
                    segmentId={segmentId}
                    messageId={msg.id}
                    step={step}
                    stepIndex={idx}
                    existing={fb}
                    onChanged={onFeedbackChanged}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {isAssistant && msg.tool_calls.length > 0 && (
        <ToolCallsSection toolCalls={msg.tool_calls} />
      )}

      {isAssistant && <SelfTakePanel messageId={msg.id} />}
    </div>
  );
}

// ── Gooni's Self-Take ─────────────────────────────────────────────────────────
//
// Renders the per-message Reflection row (from the reflexion_service that
// fires after every assistant reply). Color-coded by severity:
//   1 = clean (gray, hidden by default since clean reflections are noise)
//   2 = notable (yellow)
//   3 = load-bearing (red)
// Pulls lazily — only fetches when the panel mounts in EvalView's drill-down.
function SelfTakePanel({ messageId }: { messageId: number }) {
  const { data } = useQuery({
    queryKey: ["reflections", "by-message", messageId],
    queryFn: () => fetchReflections({ messageId, limit: 1 }),
    staleTime: 60_000,
  });
  const reflection = data?.reflections?.[0];
  if (!reflection) return null;
  // Hide sev 1 by default — they're "nothing to learn" rows; keep them in
  // the DB for classifier eval, just don't clutter the UI per-message.
  if (reflection.severity < 2) return null;

  // Standard card chrome — the old palette had a warm orange/red shell
  // that didn't exist anywhere else in the app. Now: white card matching
  // the eval message bubbles, with severity expressed as a small pill in
  // the header (green/amber for sev 2/3) instead of bleeding into the
  // whole card surface.
  const pill = reflection.severity === 3
    ? { bg: "rgba(220,38,38,0.10)", color: "#B91C1C", label: "load-bearing" }
    : { bg: "rgba(245,158,11,0.12)", color: "#92400E", label: "notable" };

  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 12px",
        background: "#FFFFFF",
        border: "1px solid #E5E5EA",
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: "#8E8E93",
            fontWeight: 600,
          }}
        >
          Gooni's self-take
        </span>
        <span
          style={{
            display: "inline-flex", alignItems: "center",
            padding: "1px 6px", borderRadius: 999,
            background: pill.bg, color: pill.color,
            fontSize: 10, fontWeight: 600,
            letterSpacing: 0.3, textTransform: "uppercase",
          }}
        >
          sev {reflection.severity} · {pill.label}
        </span>
        <span style={{ fontSize: 11, color: "#8E8E93" }}>
          · {reflection.action_vs_described}
        </span>
      </div>
      {reflection.critique_summary && (
        <div style={{ fontSize: 13, color: "#1C1C1E", marginBottom: 4 }}>
          <strong>Daniel pushed back:</strong> {reflection.critique_summary}
        </div>
      )}
      {reflection.gap_exposed && (
        <div style={{ fontSize: 13, color: "#1C1C1E", marginBottom: 4 }}>
          <strong>Gap:</strong> {reflection.gap_exposed}
        </div>
      )}
      {reflection.proposed_self_fix && (
        <div style={{ fontSize: 13, color: "#1C1C1E" }}>
          <strong>Proposed fix:</strong> {reflection.proposed_self_fix}
        </div>
      )}
    </div>
  );
}

// ── Tool Calls audit section ─────────────────────────────────────────────────
//
// Renders the ground-truth ToolCall audit rows (separate from the
// Message.trace JSON). Trace shows what the orchestrator *intended* to
// run; the audit shows what *actually* executed — status (running/done/
// failed), error text on failures, duration. When chat hallucinates a
// tool name or a tool crashes mid-run, this is the only place that tells
// you the truth.
function ToolCallsSection({ toolCalls }: { toolCalls: EvalToolCall[] }) {
  const [open, setOpen] = useState(false);
  const failed = toolCalls.filter((tc) => tc.status === "failed").length;
  const running = toolCalls.filter((tc) => tc.status === "running").length;
  const summary = [
    `${toolCalls.length} call${toolCalls.length === 1 ? "" : "s"}`,
    failed > 0 ? `${failed} failed` : null,
    running > 0 ? `${running} running` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div style={{ marginTop: 12 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: failed > 0 ? "#FF3B30" : "#0A84FF",
          fontSize: 12,
          fontFamily: FONT,
        }}
      >
        {open ? "▾" : "▸"} Tool Calls ({summary})
      </button>
      {open && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {toolCalls.map((tc) => (
            <ToolCallRow key={tc.id} tc={tc} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallRow({ tc }: { tc: EvalToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const pillBg =
    tc.status === "done"
      ? "#E8F5E9"
      : tc.status === "failed"
      ? "#FFEBEE"
      : "#FFF8E1";
  const pillColor =
    tc.status === "done"
      ? "#1B5E20"
      : tc.status === "failed"
      ? "#B71C1C"
      : "#8D6E00";
  return (
    <div
      style={{
        border: "1px solid #E5E5EA",
        borderRadius: 8,
        padding: 8,
        background: "#FFFFFF",
        fontFamily: FONT,
        fontSize: 12,
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span
          style={{
            background: pillBg,
            color: pillColor,
            padding: "2px 6px",
            borderRadius: 4,
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 0.3,
            fontWeight: 600,
          }}
        >
          {tc.status}
        </span>
        <strong style={{ color: "#1C1C1E" }}>{tc.tool_name}</strong>
        {tc.duration_ms != null && (
          <span style={{ color: "#8E8E93" }}>· {tc.duration_ms}ms</span>
        )}
        <span style={{ color: "#8E8E93", marginLeft: "auto" }}>
          #{tc.id} {expanded ? "▾" : "▸"}
        </span>
      </div>
      {tc.error && (
        <div style={{ marginTop: 6, color: "#B71C1C", fontFamily: "ui-monospace, monospace", whiteSpace: "pre-wrap" }}>
          {tc.error}
        </div>
      )}
      {expanded && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {tc.args_json && (
            <details>
              <summary style={{ cursor: "pointer", color: "#3A6AA1" }}>args</summary>
              <pre
                style={{
                  margin: "4px 0 0 0",
                  padding: 8,
                  background: "#F5F8FB",
                  borderRadius: 6,
                  fontSize: 11,
                  overflowX: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {tc.args_json}
              </pre>
            </details>
          )}
          {tc.result_json && (
            <details>
              <summary style={{ cursor: "pointer", color: "#3A6AA1" }}>result</summary>
              <pre
                style={{
                  margin: "4px 0 0 0",
                  padding: 8,
                  background: "#F5F8FB",
                  borderRadius: 6,
                  fontSize: 11,
                  overflowX: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {tc.result_json}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ── Per-message rating row (👎/😐/👍 + optional comment) ─────────────────────

const RATING_COLOR_EVAL: Record<number, string> = { 1: "#791F1F", 2: "#6B7280", 3: "#0F6E56" };
const RATING_LABEL_EVAL: Record<number, string> = { 1: "bad", 2: "neutral", 3: "good" };

function MessageRatingRow({
  segmentId,
  messageId,
  existing,
  onRatingPatched,
}: {
  segmentId: number;
  messageId: number;
  existing: EvalMessage["rating"];
  // Patch-style callback: merges a single message's rating into the
  // parent's local state instead of triggering a full segment refetch
  // (Daniel's "why fetch full on every save" gripe). Pass null to clear
  // the rating row.
  onRatingPatched: (messageId: number, rating: EvalMessageRating | null) => void;
}) {
  const [comment, setComment] = useState(existing?.comment ?? "");
  const [pending, setPending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Only resync local buffer when switching to a different message.
  // Re-syncing on every existing.comment change clobbered typed-but-
  // unsaved text whenever setRating() fired (parent re-renders existing
  // with the freshly-saved rating, and that flipped existing.comment
  // back to its persisted value, wiping the in-flight comment).
  useEffect(() => {
    setComment(existing?.comment ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId]);

  // Auto-grow up to 3× the rows={3} default so a long rationale doesn't
  // hide behind a 3-line viewport. Caller-driven changes (the effect
  // above) also trip this via the comment dep.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const baseHeight = el.clientHeight || 60;
    const next = Math.min(el.scrollHeight, baseHeight * 3 + 40);
    el.style.height = `${next}px`;
  }, [comment]);

  const dirty = (existing?.comment ?? "") !== comment;
  // Save when there's any pending change AND we have something to save:
  // a rating, OR a non-empty comment. Empty rows are rejected by the
  // backend, so leaving both blank doesn't even need to round-trip.
  const hasContent = !!existing?.rating || comment.trim().length > 0;
  const canSave = dirty && hasContent && !pending;

  async function setRating(rating: 1 | 2 | 3) {
    setPending(true);
    try {
      if (existing?.rating === rating) {
        await deleteMessageRating(messageId);
        // Deletion clears the row entirely — but if there was a comment
        // we want to keep it, so re-put with rating=null. Simpler path:
        // delete clears everything (matches the historical UX where the
        // thumbs was the only thing). Comment goes with it.
        onRatingPatched(messageId, null);
      } else {
        // Carry the in-flight local comment so clicking a rating button
        // ALSO persists whatever Daniel typed but hasn't manually saved.
        // Falls back to the persisted value when local is empty.
        const commentToSend = comment.trim() || existing?.comment || null;
        const updated = await putMessageRating(segmentId, messageId, {
          rating,
          comment: commentToSend,
        });
        onRatingPatched(messageId, {
          id: updated.id,
          rating: updated.rating,
          comment: updated.comment,
          updated_at: updated.updated_at,
        });
      }
    } finally {
      setPending(false);
    }
  }

  async function saveComment() {
    if (!canSave) return;
    setPending(true);
    try {
      const updated = await putMessageRating(segmentId, messageId, {
        rating: existing?.rating ?? null,
        comment: comment.trim() || null,
      });
      onRatingPatched(messageId, {
        id: updated.id,
        rating: updated.rating,
        comment: updated.comment,
        updated_at: updated.updated_at,
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      style={{
        marginTop: 10,
        paddingTop: 10,
        borderTop: "1px dashed rgba(0,0,0,0.06)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, color: "#8E8E93", marginRight: 4 }}>Reply</span>
        {[1, 2, 3].map((r) => {
          const active = existing?.rating === r;
          const icon = r === 1
            ? <X size={14} strokeWidth={3} />
            : r === 2
              ? <Minus size={14} strokeWidth={3} />
              : <Check size={14} strokeWidth={3} />;
          return (
            <button
              key={r}
              onClick={() => setRating(r as 1 | 2 | 3)}
              disabled={pending}
              title={RATING_LABEL_EVAL[r]}
              style={{
                width: 28, height: 28, borderRadius: 8,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                background: active ? RATING_COLOR_EVAL[r] : "transparent",
                border: `1px solid ${active ? RATING_COLOR_EVAL[r] : "#E5E5EA"}`,
                color: active ? "#fff" : RATING_COLOR_EVAL[r],
                cursor: pending ? "wait" : "pointer",
                padding: 0, fontFamily: "inherit",
                transition: "background 120ms ease, transform 120ms ease",
                transform: active ? "scale(1.05)" : "scale(1)",
              }}
            >
              {icon}
            </button>
          );
        })}
      </div>
      {/* Full-width comment textbox always visible. Manual save — no autosave.
          Save button enables only when there's a rating + a buffer change. */}
      <textarea
        ref={textareaRef}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={existing?.rating ? "why this rating?" : "note (rating optional)"}
        rows={3}
        style={{
          width: "100%",
          fontSize: 12.5,
          fontFamily: FONT,
          lineHeight: 1.5,
          padding: "8px 10px",
          border: "1px solid #E5E5EA",
          borderRadius: 8,
          resize: "vertical",
          outline: "none",
          background: "#fff",
          color: "#1C1C1E",
          overflow: "hidden",
        }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        {dirty && (
          <button
            onClick={() => setComment(existing?.comment ?? "")}
            disabled={pending}
            style={{
              padding: "5px 12px", borderRadius: 6,
              border: "1px solid #E5E5EA", background: "transparent",
              color: "#6E6E73", fontSize: 11.5, fontWeight: 500,
              cursor: pending ? "wait" : "pointer", fontFamily: FONT,
            }}
          >
            Cancel
          </button>
        )}
        <button
          onClick={saveComment}
          disabled={!canSave}
          title={!dirty ? "no changes" : !hasContent ? "type a note or pick a rating" : "save note"}
          style={{
            padding: "5px 12px", borderRadius: 6,
            border: "none",
            background: canSave ? "#0A84FF" : "#E5E5EA",
            color: canSave ? "#fff" : "#8E8E93",
            fontSize: 11.5, fontWeight: 600,
            cursor: canSave ? "pointer" : "not-allowed",
            fontFamily: FONT,
          }}
        >
          {existing?.comment ? "Save" : "Add note"}
        </button>
      </div>
    </div>
  );
}

// ── Step card with flag popover ──────────────────────────────────────────────

function StepCard({
  segmentId,
  messageId,
  step,
  stepIndex,
  existing,
  onChanged,
}: {
  segmentId: number;
  messageId: number;
  step: MessageTraceStep;
  stepIndex: number;
  existing: EvalMessage["step_feedback"][number] | null;
  onChanged: () => void;
}) {
  const [flagOpen, setFlagOpen] = useState(false);
  const stepKey = (step.key ?? step.type) as string;

  // #98: surface tool name for tool_call rows. Tool name lives at
  // meta.tool (canonical) or input.name (older traces). Without this,
  // every tool_call renders identically as "tool_call — Captured tone
  // correction" and the reviewer can't tell which tool fired.
  const toolName =
    stepKey === "tool_call"
      ? ((step.meta as { tool?: string } | null | undefined)?.tool
        ?? (step.input as { name?: string } | null | undefined)?.name
        ?? null)
      : null;
  const headerLabel = renderStepHeaderLabel(step, stepKey);

  return (
    <div
      style={{
        background: "#FAFAFA",
        border: "1px solid #E5E5EA",
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#8E8E93" }}>
          {toolName ? `${stepKey}: ${toolName}` : stepKey}
        </span>
        <span style={{ fontSize: 13 }}>{headerLabel}</span>
        <button
          onClick={() => setFlagOpen((v) => !v)}
          style={{
            marginLeft: "auto",
            background: existing ? "#FFE5E5" : "transparent",
            border: existing ? "1px solid #FF3B30" : "1px solid #E5E5EA",
            borderRadius: 6,
            padding: "2px 8px",
            cursor: "pointer",
            fontSize: 12,
            fontFamily: FONT,
          }}
          title={existing ? `Rated ${existing.rating}/3 — click to edit` : "Flag this step"}
        >
          🚩 {existing ? `${existing.rating}/3` : "Flag"}
        </button>
      </div>

      {/* Step body — input/output preview */}
      <StepBody step={step} />

      {flagOpen && (
        <FlagEditor
          segmentId={segmentId}
          messageId={messageId}
          stepKey={stepKey}
          stepIndex={stepIndex}
          existing={existing}
          onClose={() => setFlagOpen(false)}
          onChanged={() => {
            setFlagOpen(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

// #100: distinguish short-circuit replies (no LLM call) from real LLM
// replies. Orchestrator stamps meta.usage.short_circuit=true when feedback_ack
// returns directly without hitting the chat model. Today both render as
// "Replied (Nms)" — reviewer can't tell which one produced the text.
function renderStepHeaderLabel(step: MessageTraceStep, stepKey: string): string {
  if (stepKey !== "reply") return step.label;
  const usage = (step.meta as { usage?: { short_circuit?: boolean } } | null | undefined)?.usage;
  const elapsed = (step.meta as { elapsed_ms?: number } | null | undefined)?.elapsed_ms;
  if (usage?.short_circuit) {
    return `Short-circuited (no LLM call)`;
  }
  // Replace generic "Replied (Nms)" with explicit "LLM reply (Nms)".
  return typeof elapsed === "number" ? `LLM reply (${elapsed}ms)` : "LLM reply";
}

// Auto-expand threshold — payloads under this many serialized chars open
// by default so the reviewer sees content without clicking. Master prompts
// + recall payloads are typically much longer; those stay collapsed so a
// single segment doesn't render a wall of text.
const STEP_AUTOEXPAND_MAX_CHARS = 600;

function StepBody({ step }: { step: MessageTraceStep }) {
  // Render input/output if present; fall back to legacy detail/args.
  const out = step.output ?? step.detail ?? null;
  const inp = step.input ?? step.args ?? null;
  const meta = step.meta ?? null;
  const hasContent = out != null || inp != null || (meta && Object.keys(meta).length > 0);
  if (!hasContent) return null;
  // #98: auto-expand short payloads so the reviewer doesn't have to click
  // "details" on every step card. Long payloads (master_prompt, recall) stay
  // collapsed to avoid a wall of text on every segment open.
  const totalLen =
    serializedLength(inp) + serializedLength(out) + serializedLength(meta);
  const shouldAutoExpand = totalLen <= STEP_AUTOEXPAND_MAX_CHARS;
  return (
    <details style={{ marginTop: 6 }} open={shouldAutoExpand}>
      <summary style={{ fontSize: 11, color: "#8E8E93", cursor: "pointer" }}>
        {shouldAutoExpand ? "collapse" : "show details"}
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
        {inp != null && (
          <CodeBlock label="input" value={inp} />
        )}
        {out != null && (
          <CodeBlock label="output" value={out} />
        )}
        {meta != null && Object.keys(meta).length > 0 && (
          <CodeBlock label="meta" value={meta} />
        )}
      </div>
    </details>
  );
}

function serializedLength(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "string") return v.length;
  try {
    return JSON.stringify(v).length;
  } catch {
    return String(v).length;
  }
}

function CodeBlock({ label, value }: { label: string; value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  // Big payloads (master_prompt, recall) get an expand button → modal that
  // un-escapes \n / \t into real line breaks so the assembled prompt is
  // actually readable instead of one JSON-string wall.
  const showExpand = text.length > 200;
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 2,
        }}
      >
        <span style={{ fontSize: 10, color: "#8E8E93" }}>{label}</span>
        {showExpand && (
          <button
            onClick={() => setExpanded(true)}
            title="View formatted (newlines expanded)"
            style={{
              background: "transparent",
              border: "1px solid #E5E5EA",
              borderRadius: 5,
              padding: "1px 6px",
              fontSize: 10,
              color: "#0A84FF",
              cursor: "pointer",
              fontFamily: FONT,
            }}
          >
            ⤢ formatted
          </button>
        )}
      </div>
      <pre
        style={{
          margin: 0,
          padding: 8,
          background: "#FFFFFF",
          border: "1px solid #E5E5EA",
          borderRadius: 6,
          fontSize: 11,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
          maxHeight: 200,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {text}
      </pre>
      {expanded && (
        <FormattedModal label={label} text={text} onClose={() => setExpanded(false)} />
      )}
    </div>
  );
}

// Modal that renders a payload with escaped \n / \t turned into real line
// breaks — the master_prompt step stores the assembled system prompt as a
// JSON object, so the inline <pre> shows it as one escaped string. Here the
// reviewer can read it laid out.
function FormattedModal({
  label,
  text,
  onClose,
}: {
  label: string;
  text: string;
  onClose: () => void;
}) {
  const formatted = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.32)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        fontFamily: FONT,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#FFFFFF",
          borderRadius: 12,
          padding: "16px 18px",
          width: "80vw",
          maxWidth: 860,
          maxHeight: "85vh",
          boxShadow: "0 20px 50px rgba(0,0,0,0.18)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#1C1C1E" }}>
            {label} — formatted
          </span>
          <button
            onClick={onClose}
            style={{
              marginLeft: "auto",
              background: "transparent",
              border: "1px solid #E5E5EA",
              borderRadius: 6,
              padding: "4px 12px",
              fontSize: 13,
              color: "#0A84FF",
              cursor: "pointer",
              fontFamily: FONT,
            }}
          >
            Close
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: "#FAFAFA",
            border: "1px solid #E5E5EA",
            borderRadius: 8,
            fontSize: 12,
            lineHeight: 1.5,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {formatted}
        </pre>
      </div>
    </div>
  );
}

// ── Flag editor popover ──────────────────────────────────────────────────────

function FlagEditor({
  segmentId,
  messageId,
  stepKey,
  stepIndex,
  existing,
  onClose,
  onChanged,
}: {
  segmentId: number;
  messageId: number;
  stepKey: string;
  stepIndex: number;
  existing: EvalMessage["step_feedback"][number] | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [rating, setRating] = useState<number | null>(existing?.rating ?? null);
  const [comment, setComment] = useState(existing?.comment ?? "");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (rating == null || ![1, 2, 3].includes(rating)) {
      alert("Pick a rating (1, 2, or 3)");
      return;
    }
    setSaving(true);
    try {
      await postEvalFeedback({
        segment_id: segmentId,
        message_id: messageId,
        step_key: stepKey,
        step_index: stepIndex,
        rating: rating as 1 | 2 | 3,
        comment: comment.trim() || null,
      });
      onChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to save flag");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        marginTop: 10,
        background: "#FFFFFF",
        border: "1px solid #FF3B30",
        borderRadius: 8,
        padding: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <RatingPicker value={rating} onChange={setRating} />
        <button
          onClick={onClose}
          style={{
            marginLeft: "auto",
            background: "none",
            border: "none",
            color: "#8E8E93",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          ✕ Cancel
        </button>
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="What's wrong / right with this step? (optional)"
        rows={2}
        style={{
          width: "100%",
          padding: 6,
          border: "1px solid #E5E5EA",
          borderRadius: 6,
          fontSize: 12,
          fontFamily: FONT,
          resize: "vertical",
          outline: "none",
          boxSizing: "border-box",
        }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
        <button
          onClick={submit}
          disabled={saving}
          style={{
            background: "#FF3B30",
            color: "#FFFFFF",
            border: "none",
            borderRadius: 6,
            padding: "4px 12px",
            cursor: saving ? "wait" : "pointer",
            fontSize: 12,
            fontWeight: 600,
            fontFamily: FONT,
          }}
        >
          {saving ? "Saving…" : existing ? "Update flag" : "Submit flag"}
        </button>
      </div>
    </div>
  );
}

// ── Tool legend popup ────────────────────────────────────────────────────────

function ToolLegendPopup({
  entries,
  onClose,
}: {
  entries: EvalToolLegendEntry[];
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.3)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#FFFFFF",
          borderRadius: 12,
          padding: 24,
          maxWidth: 600,
          maxHeight: "80vh",
          overflow: "auto",
          fontFamily: FONT,
          boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Tool / step legend</h3>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#8E8E93" }}
          >
            ✕
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {entries.map((e) => (
            <div key={e.key}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {e.name} <span style={{ color: "#8E8E93", fontWeight: 400 }}>({e.key})</span>
              </div>
              <div style={{ fontSize: 12, color: "#3A3A3C", marginTop: 2, lineHeight: 1.5 }}>
                {e.description}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Small UI helpers ─────────────────────────────────────────────────────────

function FilterDot() {
  // Subtle separator between filter groups. Pure decoration — matches the
  // spec's "Source: [..] · Status: [..] · [Flagged]" cadence.
  return (
    <span style={{ color: "#D1D1D6", fontSize: 12, padding: "0 2px", userSelect: "none" }}>·</span>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  // Inline label + chip cluster. Dropped the segmented-control track so
  // each chip stands on its own — active chips read as "the filter that's
  // narrowing the list," inactive chips as "click me to narrow further."
  // Matches the inclusive multi-select semantics: empty set = show all,
  // any selected = show only those.
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 11, color: "#8E8E93", fontWeight: 500 }}>{label}</span>
      <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
        {children}
      </div>
    </div>
  );
}

function FilterPill({
  active,
  accent,
  onClick,
  count,
  children,
}: {
  active: boolean;
  accent: string;
  onClick: () => void;
  // Optional match count for active pills — gives immediate feedback on
  // what the filter actually surfaces. Omit for binary toggles (Flagged,
  // Unrated) where the count would just duplicate the visible list size.
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        background: active ? `${accent}1A` : "transparent",
        color: active ? accent : "#8E8E93",
        border: active ? `0.5px solid ${accent}55` : "0.5px solid rgba(0,0,0,0.10)",
        borderRadius: 999,
        padding: "3px 10px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: active ? 600 : 500,
        fontFamily: FONT,
        transition: "background 0.1s, color 0.1s, border-color 0.1s",
        outline: "none",
      }}
    >
      {children}
      {count != null && active && (
        <span
          style={{
            background: `${accent}33`,
            color: accent,
            padding: "0 5px",
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 700,
            marginLeft: 1,
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        padding: "8px 14px",
        marginBottom: -1,
        cursor: "pointer",
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        fontFamily: FONT,
        color: active ? "#1C1C1E" : "#8E8E93",
        borderBottom: active ? "2px solid #1C1C1E" : "2px solid transparent",
      }}
    >
      {children}
    </button>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: color,
      }}
    />
  );
}

// Pulsing green badge that signals "this convo is currently active" —
// last_message_at < 30 min ago, server-derived. Halo ring uses keyframes
// so the dot reads as alive without being loud.
function ActiveBadge() {
  return (
    <span
      title="Active conversation — last message <30 min ago"
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        fontSize: 10, color: "#0F6E56", fontWeight: 600,
        letterSpacing: 0.4, textTransform: "uppercase",
      }}
    >
      <style>{`
        @keyframes gooni-active-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(34,197,94,0.55); }
          50%      { box-shadow: 0 0 0 5px rgba(34,197,94,0); }
        }
      `}</style>
      <span style={{
        width: 7, height: 7, borderRadius: "50%",
        background: "#22C55E",
        animation: "gooni-active-pulse 1.6s ease-out infinite",
      }} />
      live
    </span>
  );
}

function StatusPill({ status, onCycle }: { status: EvalStatus; onCycle?: () => void }) {
  const s = STATUS_STYLE[status];
  const clickable = !!onCycle;
  return (
    <button
      type="button"
      onClick={onCycle}
      disabled={!clickable}
      title={clickable ? "Click to cycle status" : undefined}
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 10,
        background: s.bg,
        color: s.color,
        fontSize: 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.3,
        border: "none",
        cursor: clickable ? "pointer" : "default",
        fontFamily: FONT,
      }}
    >
      {s.label}
    </button>
  );
}

// Tiny "N/M rated" badge in the eval detail header — gives the reviewer
// a quick sense of how far through a long segment they are without
// having to scroll. Counts only assistant messages (those are the ones
// that can carry a rating). A non-null rating (1/2/3) OR a non-empty
// comment counts the row as touched.
function RatedProgressBadge({ data }: { data: EvalSegmentFull }) {
  const assistantMsgs = data.messages.filter((m) => m.role === "assistant");
  const total = assistantMsgs.length;
  if (total === 0) return null;
  const rated = assistantMsgs.filter(
    (m) => m.rating && (m.rating.rating != null || (m.rating.comment ?? "").trim() !== ""),
  ).length;
  const pct = total === 0 ? 0 : Math.round((rated / total) * 100);
  const done = rated === total;
  return (
    <span
      title={`${rated} of ${total} assistant replies have a rating or note (${pct}%)`}
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 10,
        background: done ? "rgba(34,197,94,0.12)" : "rgba(10,132,255,0.10)",
        color: done ? "#15803D" : "#0A84FF",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.3,
        fontFamily: FONT,
      }}
    >
      {rated}/{total} rated
    </span>
  );
}

function RatingPicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  // Lucide X / Minus / Check w/ ops-board palette — parity with per-msg
  // rating row. Numbered prefix kept so the keyboard shortcut hints
  // (1/2/3) still read as labels.
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {[1, 2, 3].map((r) => {
        const active = value === r;
        const icon = r === 1
          ? <X size={14} strokeWidth={3} />
          : r === 2
            ? <Minus size={14} strokeWidth={3} />
            : <Check size={14} strokeWidth={3} />;
        return (
        <button
          key={r}
          onClick={() => onChange(value === r ? null : r)}
          title={`${r} = ${RATING_LABEL_EVAL[r]}`}
          style={{
            background: active ? RATING_COLOR_EVAL[r] : "transparent",
            color: active ? "#FFFFFF" : RATING_COLOR_EVAL[r],
            border: `1px solid ${active ? RATING_COLOR_EVAL[r] : "#E5E5EA"}`,
            borderRadius: 6,
            padding: "4px 10px",
            cursor: "pointer",
            fontSize: 13,
            fontFamily: FONT,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontVariantNumeric: "tabular-nums",
            transition: "background 120ms ease, color 120ms ease",
          }}
        >
          <span style={{ fontWeight: 600 }}>{r}</span>
          {icon}
          <span style={{ fontSize: 12 }}>{RATING_LABEL_EVAL[r]}</span>
        </button>
        );
      })}
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

// Backend stores last_message_at as naive UTC (SQLite drops tzinfo) and
// .isoformat() emits no 'Z' suffix. JS `new Date(str)` then parses as local
// → renders future-shifted by the local offset, producing "-1d ago" for
// stamps from a few hours back. Append 'Z' so JS parses as UTC.
function parseUtcIso(iso: string): Date {
  const hasTz = iso.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(iso);
  return new Date(hasTz ? iso : iso + "Z");
}

function formatDate(d: Date): string {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const diffMs = now.getTime() - d.getTime();
  // Defensive: future timestamps (clock skew, residual TZ bugs) → render as time-of-day.
  if (diffMs < 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

// ── Eval runs panel ──────────────────────────────────────────────────────────
// Lists golden-eval run artifacts (HTML scorecards in evals/reports/) plus
// the latest baseline metadata, served by /eval/runs. Click a row to open
// the scorecard in an inline iframe. Reports are gitignored, so this panel
// only has data on the machine that ran the eval — that's by design.

interface EvalRun {
  filename: string;
  size_bytes: number;
  mtime: number;
}

interface EvalBaselineMeta {
  filename?: string;
  composite_score: number | null;
  passed: number | null;
  n_cases: number | null;
  means: Record<string, number> | null;
  pipeline_model: string | null;
  pipeline_version: string | null;
  pipeline_source_hash: string | null;
  timestamp: string | null;
  total_cost_usd?: number | null;
  cost_per_case_usd?: number | null;
}

interface EvalBaselineDetail extends EvalBaselineMeta {
  case_ids?: string[];
  failed?: number;
  results?: Array<{
    id: string;
    status: string;
    stage: string;
    fails: string[];
    scores: Record<string, number>;
    judge_notes: string;
    judge_model: string;
    tools_called: (string | null)[];
    master_prompt_chars: number;
    cached?: boolean;
    cost?: { total_cost_usd?: number; by_model?: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number }> };
    context_summary?: {
      user_message?: string;
      seed_focuses?: unknown[];
      seed_memories?: unknown[];
      seed_prefs?: unknown[];
      history?: unknown[];
    };
  }>;
}

function EvalRunsPanel() {
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [baselines, setBaselines] = useState<Record<string, EvalBaselineMeta>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Run-Now state: tail-style log of the eval subprocess stdout. Cleared
  // each press. evalRunning gates the button so we don't double-fire.
  const [evalRunning, setEvalRunning] = useState(false);
  const [evalLog, setEvalLog] = useState<string[]>([]);
  const [evalError, setEvalError] = useState<string | null>(null);
  // Click-a-baseline → fetch full JSON → render per-case detail in right panel.
  // When set, takes over the right panel (reports iframe gets cleared).
  const [selectedBaselineFile, setSelectedBaselineFile] = useState<string | null>(null);
  const [baselineDetail, setBaselineDetail] = useState<EvalBaselineDetail | null>(null);
  const [baselineDetailLoading, setBaselineDetailLoading] = useState(false);
  const [baselineDetailError, setBaselineDetailError] = useState<string | null>(null);
  // Bump to force a refetch of /eval/runs after a fresh baseline lands.
  const [refreshTick, setRefreshTick] = useState(0);
  // Report HTML loaded via apiFetch (carries Bearer token). Iframes can't
  // attach Authorization headers, so on prod (AUTH_PASSWORD set) the iframe
  // approach 401'd. We fetch the HTML and render it inline via srcDoc, which
  // sandboxes it the same as a normal iframe but doesn't require a public
  // URL. Reports are HTML scorecards generated by run_orchestrator.
  const [reportHtml, setReportHtml] = useState<string>("");
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`${BASE}/eval/runs`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setRuns(data.runs || []);
        setBaselines(data.baselines_by_key || {});
        if ((data.runs || []).length > 0 && !selected) {
          setSelected(data.runs[0].filename);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "load failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  async function handleRunProdEval() {
    if (evalRunning) return;
    setEvalRunning(true);
    setEvalLog([]);
    setEvalError(null);
    try {
      await runProdSnapshotEval((evt: EvalRunEvent) => {
        if (evt.type === "status") {
          setEvalLog((prev) => [...prev, `· ${evt.message}`]);
        } else if (evt.type === "line") {
          setEvalLog((prev) => [...prev, evt.data]);
        } else if (evt.type === "error") {
          setEvalError(evt.message);
        } else if (evt.type === "done") {
          setEvalLog((prev) => [...prev, `· done (exit_code=${evt.exit_code})`]);
          // Trigger /eval/runs refetch so the new baseline shows up.
          setRefreshTick((n) => n + 1);
        }
      });
    } catch (e) {
      setEvalError(e instanceof Error ? e.message : "stream failed");
    } finally {
      setEvalRunning(false);
    }
  }

  useEffect(() => {
    if (!selected) {
      setReportHtml("");
      return;
    }
    let cancelled = false;
    async function loadReport() {
      setReportLoading(true);
      setReportError(null);
      try {
        const res = await apiFetch(`${BASE}/eval/runs/${encodeURIComponent(selected!)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!cancelled) setReportHtml(text);
      } catch (e) {
        if (!cancelled) setReportError(e instanceof Error ? e.message : "load failed");
      } finally {
        if (!cancelled) setReportLoading(false);
      }
    }
    loadReport();
    return () => { cancelled = true; };
  }, [selected]);

  // Click baseline → fetch full JSON.
  useEffect(() => {
    if (!selectedBaselineFile) {
      setBaselineDetail(null);
      return;
    }
    let cancelled = false;
    async function loadBaseline() {
      setBaselineDetailLoading(true);
      setBaselineDetailError(null);
      try {
        const res = await apiFetch(
          `${BASE}/eval/baselines/${encodeURIComponent(selectedBaselineFile!)}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setBaselineDetail(data);
      } catch (e) {
        if (!cancelled) setBaselineDetailError(e instanceof Error ? e.message : "load failed");
      } finally {
        if (!cancelled) setBaselineDetailLoading(false);
      }
    }
    loadBaseline();
    return () => { cancelled = true; };
  }, [selectedBaselineFile]);

  const baselineList = Object.values(baselines);

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden", background: "#FAFAFA" }}>
      {/* Left rail: run list */}
      <div style={{ width: 320, borderRight: "1px solid rgba(0,0,0,0.06)", overflowY: "auto", padding: "12px 0", flexShrink: 0 }}>
        {/* Run-against-live-prod-snapshot button. Triggers a backend subprocess
            that copies the live DB and runs the eval harness against the copy.
            Streams stdout SSE so we render per-case progress in the log box. */}
        <div style={{ padding: "0 16px 12px" }}>
          <button
            type="button"
            onClick={handleRunProdEval}
            disabled={evalRunning}
            style={{
              width: "100%",
              padding: "8px 12px",
              borderRadius: 8,
              border: "1px solid rgba(0,0,0,0.08)",
              background: evalRunning ? "#f0f0f0" : "#111",
              color: evalRunning ? "#999" : "#fff",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: evalRunning ? "wait" : "pointer",
              fontFamily: FONT,
              letterSpacing: 0.2,
              boxShadow: evalRunning ? "none" : "0 1px 2px rgba(0,0,0,0.06)",
            }}
          >
            {evalRunning ? "running eval…" : "▶ Run eval on prod snapshot"}
          </button>
          {evalError && (
            <div style={{ marginTop: 8, fontSize: 11, color: "#b3261e" }}>
              error: {evalError}
            </div>
          )}
          {evalLog.length > 0 && (
            <div
              style={{
                marginTop: 8,
                maxHeight: 180,
                overflowY: "auto",
                padding: "8px 10px",
                background: "#1a1a1a",
                color: "#dcdcdc",
                borderRadius: 6,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 10.5,
                lineHeight: 1.45,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {evalLog.slice(-200).map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}
        </div>
        <div style={{ padding: "0 16px 8px", fontSize: 11, color: "#8E8E93", textTransform: "uppercase", letterSpacing: 0.4 }}>
          Latest baselines
        </div>
        {baselineList.length === 0 ? (
          <div style={{ padding: "0 16px", fontSize: 12, color: "#8E8E93", lineHeight: 1.5 }}>
            no baselines yet — click <strong>▶ Run eval on prod snapshot</strong> above to generate one (or run <code>python -m evals.run_orchestrator --baseline</code> locally).
          </div>
        ) : (
          baselineList.map((b, i) => {
            const isSelected = b.filename && b.filename === selectedBaselineFile;
            return (
              <button
                key={i}
                type="button"
                disabled={!b.filename}
                onClick={() => {
                  if (!b.filename) return;
                  // Clicking a baseline takes over the right panel.
                  setSelectedBaselineFile(b.filename);
                  setSelected(null);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 16px",
                  border: "none",
                  borderBottom: "1px solid rgba(0,0,0,0.04)",
                  background: isSelected ? "rgba(0,0,0,0.04)" : "transparent",
                  cursor: b.filename ? "pointer" : "default",
                  fontFamily: FONT,
                  fontSize: 12,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontWeight: 600 }}>{b.pipeline_model}</span>
                  <span style={{ fontSize: 18, fontWeight: 700, color: (b.composite_score ?? 0) >= 75 ? "#0a8a3a" : (b.composite_score ?? 0) >= 60 ? "#9a7a00" : "#b3261e" }}>
                    {b.composite_score ?? "?"}
                  </span>
                </div>
                <div style={{ color: "#8E8E93", fontSize: 11, marginTop: 2 }}>
                  {b.passed}/{b.n_cases} passed · v{b.pipeline_version} · src={b.pipeline_source_hash?.slice(0, 6)}
                </div>
                {(b.total_cost_usd != null) && (
                  <div style={{ color: "#8E8E93", fontSize: 11, marginTop: 2 }}>
                    💰 ${b.total_cost_usd.toFixed(4)} total
                    {(b.cost_per_case_usd != null) && ` · $${b.cost_per_case_usd.toFixed(4)}/case`}
                  </div>
                )}
              </button>
            );
          })
        )}
        <div style={{ padding: "16px 16px 8px", fontSize: 11, color: "#8E8E93", textTransform: "uppercase", letterSpacing: 0.4 }}>
          Reports ({runs.length})
        </div>
        {loading ? (
          <div style={{ padding: "0 16px", fontSize: 12, color: "#8E8E93" }}>loading…</div>
        ) : error ? (
          <div style={{ padding: "0 16px", fontSize: 12, color: "#FF3B30" }}>error: {error}</div>
        ) : runs.length === 0 ? (
          <div style={{ padding: "0 16px", fontSize: 12, color: "#8E8E93", lineHeight: 1.5 }}>
            no reports yet — HTML scorecards are per-run artifacts. Click <strong>▶ Run eval on prod snapshot</strong> to generate one.
          </div>
        ) : (
          runs.map((r) => (
            <button
              key={r.filename}
              onClick={() => {
                setSelected(r.filename);
                setSelectedBaselineFile(null);
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 16px",
                background: selected === r.filename ? "#E8E8ED" : "transparent",
                border: "none",
                borderBottom: "1px solid rgba(0,0,0,0.04)",
                cursor: "pointer",
                fontFamily: FONT,
                fontSize: 12,
              }}
            >
              <div style={{ fontWeight: selected === r.filename ? 600 : 400, color: "#1C1C1E", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.filename.replace(/^report_/, "").replace(/\.html$/, "")}
              </div>
              <div style={{ color: "#8E8E93", fontSize: 11, marginTop: 2 }}>
                {formatDate(new Date(r.mtime * 1000))} · {Math.round(r.size_bytes / 1024)} KB
              </div>
            </button>
          ))
        )}
      </div>
      {/* Right pane: baseline-detail (priority) OR report iframe (fallback). */}
      <div style={{ flex: 1, overflow: "auto", background: "#FFFFFF" }}>
        {selectedBaselineFile ? (
          baselineDetailLoading ? (
            <div style={{ padding: 24, color: "#8E8E93", fontSize: 13, fontFamily: FONT }}>
              loading baseline…
            </div>
          ) : baselineDetailError ? (
            <div style={{ padding: 24, color: "#FF3B30", fontSize: 13, fontFamily: FONT }}>
              error: {baselineDetailError}
            </div>
          ) : baselineDetail ? (
            <BaselineDetailPanel detail={baselineDetail} filename={selectedBaselineFile} />
          ) : null
        ) : !selected ? (
          <div style={{ padding: 24, color: "#8E8E93", fontSize: 13, fontFamily: FONT }}>
            Select a baseline or run on the left.
          </div>
        ) : reportLoading ? (
          <div style={{ padding: 24, color: "#8E8E93", fontSize: 13, fontFamily: FONT }}>
            loading report…
          </div>
        ) : reportError ? (
          <div style={{ padding: 24, color: "#FF3B30", fontSize: 13, fontFamily: FONT }}>
            error: {reportError}
          </div>
        ) : (
          <iframe
            key={selected}
            srcDoc={reportHtml}
            style={{ width: "100%", height: "100%", border: "none" }}
            title={selected}
            sandbox="allow-same-origin"
          />
        )}
      </div>
    </div>
  );
}


function BaselineDetailPanel({
  detail,
  filename,
}: {
  detail: EvalBaselineDetail;
  filename: string;
}) {
  const results = detail.results || [];
  const passedColor = "#0a8a3a";
  const failedColor = "#b3261e";
  return (
    <div style={{ padding: "20px 24px", fontFamily: FONT, color: "#1C1C1E" }}>
      <div style={{ fontSize: 11, color: "#8E8E93", textTransform: "uppercase", letterSpacing: 0.4 }}>
        Baseline
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4, wordBreak: "break-all" }}>
        {filename}
      </div>
      <div style={{ display: "flex", gap: 24, marginTop: 14, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 10.5, color: "#8E8E93", textTransform: "uppercase", letterSpacing: 0.4 }}>Composite</div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2, color: (detail.composite_score ?? 0) >= 75 ? passedColor : (detail.composite_score ?? 0) >= 60 ? "#9a7a00" : failedColor }}>
            {detail.composite_score ?? "?"}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10.5, color: "#8E8E93", textTransform: "uppercase", letterSpacing: 0.4 }}>Pass / total</div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>{detail.passed}/{detail.n_cases}</div>
        </div>
        {detail.total_cost_usd != null && (
          <div>
            <div style={{ fontSize: 10.5, color: "#8E8E93", textTransform: "uppercase", letterSpacing: 0.4 }}>Total cost</div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>${detail.total_cost_usd.toFixed(4)}</div>
            {detail.cost_per_case_usd != null && (
              <div style={{ fontSize: 11, color: "#8E8E93", marginTop: 1 }}>
                ${detail.cost_per_case_usd.toFixed(4)}/case
              </div>
            )}
          </div>
        )}
        <div>
          <div style={{ fontSize: 10.5, color: "#8E8E93", textTransform: "uppercase", letterSpacing: 0.4 }}>Pipeline</div>
          <div style={{ fontSize: 14, marginTop: 2 }}>
            v{detail.pipeline_version} · {detail.pipeline_model}
          </div>
          <div style={{ fontSize: 11, color: "#8E8E93" }}>src={detail.pipeline_source_hash?.slice(0, 8)}</div>
        </div>
      </div>

      {detail.means && Object.keys(detail.means).length > 0 && (
        <div style={{ marginTop: 18, padding: "10px 12px", background: "rgba(0,0,0,0.03)", borderRadius: 8, fontSize: 12.5 }}>
          <div style={{ fontSize: 10.5, color: "#8E8E93", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>
            Means
          </div>
          {Object.entries(detail.means).map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
              <span style={{ color: "#636366" }}>{k}</span>
              <span style={{ fontWeight: 600 }}>{Number(v).toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 22, fontSize: 10.5, color: "#8E8E93", textTransform: "uppercase", letterSpacing: 0.4 }}>
        Per-case results ({results.length})
      </div>
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
        {results.map((r) => {
          const ok = r.status === "PASS";
          return (
            <div
              key={r.id}
              style={{
                border: `1px solid ${ok ? "rgba(10,138,58,0.18)" : "rgba(179,38,30,0.20)"}`,
                background: ok ? "rgba(10,138,58,0.04)" : "rgba(179,38,30,0.04)",
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: 12.5,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                  <span style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: ok ? passedColor : failedColor,
                    color: "#fff",
                  }}>
                    {r.status}
                  </span>
                  <span style={{ fontWeight: 600, wordBreak: "break-all" }}>{r.id}</span>
                  {r.cached && (
                    <span style={{ fontSize: 10.5, color: "#8E8E93" }}>(cached)</span>
                  )}
                </div>
                <span style={{ fontSize: 11, color: "#8E8E93", flexShrink: 0 }}>
                  {r.judge_model || ""}
                  {r.cost?.total_cost_usd != null && ` · $${r.cost.total_cost_usd.toFixed(4)}`}
                </span>
              </div>
              {Object.keys(r.scores || {}).length > 0 && (
                <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 10 }}>
                  {Object.entries(r.scores).map(([dim, score]) => (
                    <span key={dim} style={{ fontSize: 11.5, color: "#636366" }}>
                      {dim}: <strong>{score}</strong>
                    </span>
                  ))}
                </div>
              )}
              {r.fails && r.fails.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  {r.fails.map((f, i) => (
                    <div key={i} style={{ fontSize: 11.5, color: failedColor }}>· {f}</div>
                  ))}
                </div>
              )}
              {r.judge_notes && (
                <div style={{ marginTop: 6, fontSize: 11.5, color: "#636366", lineHeight: 1.45 }}>
                  {r.judge_notes}
                </div>
              )}
              {r.tools_called && r.tools_called.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 11, color: "#8E8E93", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                  tools: {r.tools_called.filter(Boolean).join(", ")}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
