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
  type EvalMessage,
  type EvalMessageRating,
  type EvalSegmentFull,
  type EvalSegmentSummary,
  type EvalStatus,
  type EvalToolCall,
  type EvalToolLegendEntry,
  type MessageTraceStep,
} from "../../services/api";
import { Check, Minus, X } from "lucide-react";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

// Per-source visual identity. Tone matches Apple-Notes restraint that the
// rest of Gooni uses: muted accent dot + label, not loud full-fill badges.
// `accent` colors stay deliberately desaturated so cards read as a quiet
// grid, not a status board.
const SOURCE_STYLE: Record<
  string,
  { accent: string; label: string }
> = {
  web: { accent: "#0A84FF", label: "Web" },
  telegram: { accent: "#5AC8FA", label: "Telegram" },
  whatsapp: { accent: "#34C759", label: "WhatsApp" },
  imessage: { accent: "#8E8E93", label: "iMessage" },
};

const STATUS_STYLE: Record<EvalStatus, { color: string; bg: string; label: string }> = {
  not_yet: { color: "#8E8E93", bg: "#F2F2F7", label: "Not yet" },
  pending: { color: "#A1742B", bg: "#FFF8E6", label: "Pending" },
  done: { color: "#2A8F4D", bg: "#EAF6EE", label: "Done" },
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

  // Filters live in component state — no URL plumbing yet, can be added later.
  const [sourcesFilter, setSourcesFilter] = useState<string[]>([...SOURCES]);
  // Default hides "done" — typical workflow is triaging unrated/in-flight
  // segments. "done" stays one click away if you want to revisit closed ones.
  const [statusesFilter, setStatusesFilter] = useState<EvalStatus[]>(["not_yet", "pending"]);
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
      {/* Header — title + tabs */}
      <div
        style={{
          padding: "20px 24px 0",
          borderBottom: "1px solid rgba(0,0,0,0.06)",
          background: "#FFFFFF",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "#1C1C1E" }}>Audit</h1>
          {tab === "convos" && (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span
                style={{ fontSize: 11, color: "#8E8E93" }}
                title="j/k or ↑/↓ navigate · 1/2/3 rate · n next unrated · Enter open · Esc clear"
              >
                ⌨ j/k · 1/2/3 · n · ⏎
              </span>
              <span style={{ fontSize: 12, color: "#8E8E93" }}>
                {visible.length}
                {visible.length !== total ? ` of ${total}` : ""} segments
              </span>
            </div>
          )}
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
          {/* Active feedback rules — moved up from the old Chat audit tab.
              Renders at most ~8 rules (320px scroll cap) so the segment
              list stays the primary surface. */}
          <ActiveRulesCard />

          {/* Filter rail */}
          <div
            style={{
              padding: "12px 24px 14px",
              borderBottom: "1px solid rgba(0,0,0,0.04)",
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            <FilterGroup label="Source">
              {SOURCES.map((src) => (
                <FilterPill
                  key={src}
                  active={sourcesFilter.includes(src)}
                  accent={SOURCE_STYLE[src]?.accent ?? "#8E8E93"}
                  onClick={() => toggleSource(src)}
                >
                  <Dot color={SOURCE_STYLE[src]?.accent ?? "#8E8E93"} />
                  {SOURCE_STYLE[src]?.label}
                </FilterPill>
              ))}
            </FilterGroup>
            <FilterGroup label="Status">
              {STATUSES.map((s) => (
                <FilterPill
                  key={s}
                  active={statusesFilter.includes(s)}
                  accent={STATUS_STYLE[s].color}
                  onClick={() => toggleStatus(s)}
                >
                  {STATUS_STYLE[s].label}
                </FilterPill>
              ))}
            </FilterGroup>
            <div style={{ display: "inline-flex", padding: 2, background: "#F2F2F7", borderRadius: 7 }}>
              <FilterPill
                active={hasFlagOnly}
                accent="#FF3B30"
                onClick={() => setHasFlagOnly((v) => !v)}
              >
                Flagged
              </FilterPill>
            </div>
            <div style={{ display: "inline-flex", padding: 2, background: "#F2F2F7", borderRadius: 7 }}>
              <FilterPill
                active={hideRated}
                accent="#0A84FF"
                onClick={() => setHideRated((v) => !v)}
              >
                {hideRated ? "Inbox: unrated" : "Show all"}
              </FilterPill>
            </div>
            <ViewToggle mode={viewMode} onChange={setViewMode} />
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 6 }}>
              <span style={{ fontSize: 11, color: "#8E8E93" }}>Min msgs</span>
              <input
                type="number"
                min={1}
                max={999}
                value={minMessages}
                onChange={(e) => setMinMessages(Math.max(1, Number(e.target.value) || 1))}
                style={{
                  width: 44,
                  height: 24,
                  padding: "0 6px",
                  border: "none",
                  background: "#F2F2F7",
                  borderRadius: 6,
                  fontSize: 12,
                  fontFamily: FONT,
                  outline: "none",
                  textAlign: "center",
                  fontWeight: 600,
                  color: "#1C1C1E",
                }}
              />
            </div>
            <input
              type="search"
              placeholder="Search transcripts…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") loadSegments();
              }}
              style={{
                marginLeft: "auto",
                padding: "6px 12px",
                border: "1px solid #E5E5EA",
                borderRadius: 8,
                fontSize: 13,
                fontFamily: FONT,
                minWidth: 220,
                outline: "none",
                background: "#FAFAFA",
              }}
            />
          </div>

          {/* Grid */}
          <div style={{ flex: 1, overflow: "auto", padding: 24, background: "#FAFAFA" }}>
            {error && (
              <div style={{ color: "#FF3B30", fontSize: 13, marginBottom: 12 }}>{error}</div>
            )}
            {loading && visible.length === 0 ? (
              <div style={{ color: "#8E8E93", fontSize: 13 }}>Loading…</div>
            ) : visible.length === 0 ? (
              <div style={{ color: "#8E8E93", fontSize: 13 }}>
                {segments.length === 0
                  ? "No segments match these filters. Try widening source / status, or clear search."
                  : `All ${segments.length} segment${segments.length === 1 ? "" : "s"} have fewer than ${minMessages} messages. Lower "Min msgs" to see them.`}
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
        padding: 14,
        borderRadius: 10,
        background: focused ? "#EAF3FF" : "#FFFFFF",
        border: focused ? "1px solid #0A84FF" : "1px solid #E5E5EA",
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
        e.currentTarget.style.borderColor = "#D1D1D6";
      }}
      onMouseLeave={(e) => {
        if (focused) return;
        e.currentTarget.style.background = "#FFFFFF";
        e.currentTarget.style.borderColor = "#E5E5EA";
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            color: "#3C3C43",
            letterSpacing: 0.2,
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
      <div style={{ fontSize: 13, color: "#1C1C1E", lineHeight: 1.45, flex: 1 }}>
        {seg.preview
          ? truncate(seg.preview, 160)
          : <em style={{ color: "#8E8E93" }}>(no user message)</em>}
      </div>
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
        <span>{seg.message_count} msg</span>
        <span>{when ? formatDate(when) : "—"}</span>
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
        padding: "8px 14px",
        background: focused ? "#EAF3FF" : "#FFFFFF",
        border: "none",
        borderTop: isFirst ? "none" : "1px solid #F2F2F7",
        borderLeft: focused ? "3px solid #0A84FF" : "3px solid transparent",
        cursor: "pointer",
        fontFamily: FONT,
        display: "flex",
        alignItems: "center",
        gap: 12,
        minHeight: 36,
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
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontSize: 11,
          color: "#3C3C43",
          width: 64,
          flexShrink: 0,
        }}
      >
        <Dot color={sourceStyle.accent} />
        {sourceStyle.label}
      </span>
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
          width: 56,
          textAlign: "center",
          flexShrink: 0,
        }}
      >
        {statusStyle.label}
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 13,
          color: "#1C1C1E",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {seg.preview || (
          <em style={{ color: "#8E8E93" }}>(no user message)</em>
        )}
      </span>
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
          fontSize: 11,
          color: "#8E8E93",
          width: 56,
          textAlign: "right",
          flexShrink: 0,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {seg.message_count} msg
      </span>
      <span
        style={{
          fontSize: 11,
          color: "#8E8E93",
          width: 80,
          textAlign: "right",
          flexShrink: 0,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {when ? formatDate(when) : "—"}
      </span>
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
          body * { visibility: hidden !important; }
          #eval-print-root, #eval-print-root * { visibility: visible !important; }
          #eval-print-root { position: absolute !important; inset: 0 !important;
                             overflow: visible !important; background: #fff !important;
                             padding: 24px !important; }
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

  const palette = (
    reflection.severity === 3
      ? { bg: "#FFF5F5", border: "#FFD3D3", accent: "#FF3B30", label: "load-bearing" }
      : { bg: "#FFFBEA", border: "#FFE6A6", accent: "#FF9500", label: "notable" }
  );

  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 12px",
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderLeft: `3px solid ${palette.accent}`,
        borderRadius: 8,
      }}
    >
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.3,
          color: palette.accent,
          fontWeight: 600,
          marginBottom: 6,
        }}
      >
        Gooni's self-take · sev {reflection.severity} · {palette.label} · {reflection.action_vs_described}
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

  useEffect(() => {
    setComment(existing?.comment ?? "");
  }, [existing?.comment, messageId]);

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
        const updated = await putMessageRating(segmentId, messageId, {
          rating,
          comment: existing?.comment ?? null,
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
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div>
      <div style={{ fontSize: 10, color: "#8E8E93", marginBottom: 2 }}>{label}</div>
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

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  // Segmented-control container — single rounded pill housing all options.
  // Border lives on the container, not per-button, so the row reads as one
  // grouped control instead of a noisy cluster of competing pills.
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 11, color: "#8E8E93" }}>{label}</span>
      <div
        style={{
          display: "inline-flex",
          padding: 2,
          background: "#F2F2F7",
          borderRadius: 7,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function FilterPill({
  active,
  accent,
  onClick,
  children,
}: {
  active: boolean;
  accent: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  // Segment item — no border, no accent inset. Active = white fill on the
  // group's gray track (iOS segmented-control pattern). Accent stays as the
  // source dot inside the label, not painted onto the chrome.
  void accent;
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        background: active ? "#FFFFFF" : "transparent",
        color: active ? "#1C1C1E" : "#6E6E73",
        border: "none",
        borderRadius: 5,
        padding: "3px 10px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: active ? 600 : 500,
        fontFamily: FONT,
        boxShadow: active ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
        transition: "background 0.1s, color 0.1s, box-shadow 0.1s",
        outline: "none",
      }}
    >
      {children}
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
  composite_score: number | null;
  passed: number | null;
  n_cases: number | null;
  means: Record<string, number> | null;
  pipeline_model: string | null;
  pipeline_version: string | null;
  pipeline_source_hash: string | null;
  timestamp: string | null;
}

function EvalRunsPanel() {
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [baselines, setBaselines] = useState<Record<string, EvalBaselineMeta>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
  }, []);

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

  const baselineList = Object.values(baselines);

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden", background: "#FAFAFA" }}>
      {/* Left rail: run list */}
      <div style={{ width: 320, borderRight: "1px solid rgba(0,0,0,0.06)", overflowY: "auto", padding: "12px 0", flexShrink: 0 }}>
        <div style={{ padding: "0 16px 8px", fontSize: 11, color: "#8E8E93", textTransform: "uppercase", letterSpacing: 0.4 }}>
          Latest baselines
        </div>
        {baselineList.length === 0 ? (
          <div style={{ padding: "0 16px", fontSize: 12, color: "#8E8E93" }}>
            no baselines yet — run <code>python -m evals.run_orchestrator --baseline</code>
          </div>
        ) : (
          baselineList.map((b, i) => (
            <div key={i} style={{ padding: "8px 16px", borderBottom: "1px solid rgba(0,0,0,0.04)", fontFamily: FONT, fontSize: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontWeight: 600 }}>{b.pipeline_model}</span>
                <span style={{ fontSize: 18, fontWeight: 700, color: (b.composite_score ?? 0) >= 75 ? "#0a8a3a" : (b.composite_score ?? 0) >= 60 ? "#9a7a00" : "#b3261e" }}>
                  {b.composite_score ?? "?"}
                </span>
              </div>
              <div style={{ color: "#8E8E93", fontSize: 11, marginTop: 2 }}>
                {b.passed}/{b.n_cases} passed · v{b.pipeline_version} · src={b.pipeline_source_hash?.slice(0, 6)}
              </div>
            </div>
          ))
        )}
        <div style={{ padding: "16px 16px 8px", fontSize: 11, color: "#8E8E93", textTransform: "uppercase", letterSpacing: 0.4 }}>
          Reports ({runs.length})
        </div>
        {loading ? (
          <div style={{ padding: "0 16px", fontSize: 12, color: "#8E8E93" }}>loading…</div>
        ) : error ? (
          <div style={{ padding: "0 16px", fontSize: 12, color: "#FF3B30" }}>error: {error}</div>
        ) : runs.length === 0 ? (
          <div style={{ padding: "0 16px", fontSize: 12, color: "#8E8E93" }}>
            no reports — local artifact, only on the machine that ran the eval
          </div>
        ) : (
          runs.map((r) => (
            <button
              key={r.filename}
              onClick={() => setSelected(r.filename)}
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
      {/* Right pane: iframe (srcDoc carries the auth-fetched HTML) */}
      <div style={{ flex: 1, overflow: "hidden", background: "#FFFFFF" }}>
        {!selected ? (
          <div style={{ padding: 24, color: "#8E8E93", fontSize: 13, fontFamily: FONT }}>
            Select a run on the left.
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
