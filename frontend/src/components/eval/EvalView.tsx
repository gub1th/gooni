import { useEffect, useMemo, useState } from "react";
import { ChatAuditPanel } from "./ChatAuditPanel";
import {
  dispatchEvalToCc,
  fetchEvalSegmentFull,
  fetchEvalToolsLegend,
  listEvalSegments,
  patchEvalSummary,
  postEvalFeedback,
  type EvalMessage,
  type EvalSegmentFull,
  type EvalSegmentSummary,
  type EvalStatus,
  type EvalToolLegendEntry,
  type MessageTraceStep,
} from "../../services/api";

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

const RATING_OPTIONS: { value: 1 | 2 | 3; label: string; emoji: string }[] = [
  { value: 1, label: "Bad", emoji: "👎" },
  { value: 2, label: "Meh", emoji: "😐" },
  { value: 3, label: "Good", emoji: "👍" },
];

type Tab = "eval" | "audit";

export function EvalView() {
  const [tab, setTab] = useState<Tab>("eval");
  const [segments, setSegments] = useState<EvalSegmentSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters live in component state — no URL plumbing yet, can be added later.
  const [sourcesFilter, setSourcesFilter] = useState<string[]>([...SOURCES]);
  const [statusesFilter, setStatusesFilter] = useState<EvalStatus[]>([...STATUSES]);
  const [hasFlagOnly, setHasFlagOnly] = useState(false);
  // Min message count: filters out the noise of one-off "asd" / "hi" segments
  // that flood bot conversations. 3 is a low default that still cuts ~half
  // the obviously-trivial segments without hiding short legitimate ones.
  const [minMessages, setMinMessages] = useState(3);
  const [search, setSearch] = useState("");

  const [selectedSegmentId, setSelectedSegmentId] = useState<number | null>(null);

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
    () => segments.filter((s) => s.message_count >= minMessages),
    [segments, minMessages]
  );

  if (selectedSegmentId != null) {
    return (
      <EvalDetailView
        segmentId={selectedSegmentId}
        onClose={() => {
          setSelectedSegmentId(null);
          loadSegments();
        }}
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
          {tab === "eval" && (
            <span style={{ fontSize: 12, color: "#8E8E93" }}>
              {visible.length}
              {visible.length !== total ? ` of ${total}` : ""} segments
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 0, marginTop: 14 }}>
          <TabButton active={tab === "eval"} onClick={() => setTab("eval")}>Eval</TabButton>
          <TabButton active={tab === "audit"} onClick={() => setTab("audit")}>Chat audit</TabButton>
        </div>
      </div>

      {tab === "audit" ? (
        // Inline the chat-audit content so the tab is the actual thing, not a
        // jump-link. Same component is reused by the legacy /chat-audit route.
        <div style={{ flex: 1, overflow: "auto", background: "#FAFAFA" }}>
          <ChatAuditPanel />
        </div>
      ) : (
        <>
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
            <FilterPill
              active={hasFlagOnly}
              accent="#FF3B30"
              onClick={() => setHasFlagOnly((v) => !v)}
            >
              Flagged
            </FilterPill>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 6 }}>
              <span style={{ fontSize: 11, color: "#8E8E93" }}>Min msgs:</span>
              <input
                type="number"
                min={1}
                max={999}
                value={minMessages}
                onChange={(e) => setMinMessages(Math.max(1, Number(e.target.value) || 1))}
                style={{
                  width: 50,
                  padding: "3px 6px",
                  border: "1px solid #E5E5EA",
                  borderRadius: 6,
                  fontSize: 12,
                  fontFamily: FONT,
                  outline: "none",
                  textAlign: "center",
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
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                  gap: 14,
                }}
              >
                {visible.map((seg) => (
                  <SegmentCard
                    key={seg.id}
                    seg={seg}
                    onClick={() => setSelectedSegmentId(seg.id)}
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
}: {
  seg: EvalSegmentSummary;
  onClick: () => void;
}) {
  const sourceStyle = SOURCE_STYLE[seg.source] ?? SOURCE_STYLE.web;
  const when = seg.last_message_at ? new Date(seg.last_message_at) : null;

  return (
    <button
      onClick={onClick}
      style={{
        textAlign: "left",
        padding: 14,
        borderRadius: 10,
        background: "#FFFFFF",
        border: "1px solid #E5E5EA",
        cursor: "pointer",
        fontFamily: FONT,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 130,
        transition: "background 0.12s, border-color 0.12s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "#FAFAFA";
        e.currentTarget.style.borderColor = "#D1D1D6";
      }}
      onMouseLeave={(e) => {
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
        <StatusPill status={seg.eval_status} />
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

// ── Detail view ──────────────────────────────────────────────────────────────

function EvalDetailView({ segmentId, onClose }: { segmentId: number; onClose: () => void }) {
  const [data, setData] = useState<EvalSegmentFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [legend, setLegend] = useState<EvalToolLegendEntry[]>([]);
  const [legendOpen, setLegendOpen] = useState(false);
  const [dispatching, setDispatching] = useState(false);

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

  async function handleDispatch() {
    if (!data) return;
    if (!confirm("Dispatch this eval to Claude Code as a note + backlog item?")) return;
    setDispatching(true);
    try {
      await dispatchEvalToCc(segmentId);
      await reload();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Dispatch failed");
    } finally {
      setDispatching(false);
    }
  }

  const seg = data?.segment;

  return (
    <div
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
            <StatusPill status={seg.eval_status} />
          </>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
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
              onUpdated={reload}
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
                />
              ))}
            </div>
          </>
        ) : null}
      </div>

      {legendOpen && <ToolLegendPopup entries={legend} onClose={() => setLegendOpen(false)} />}
    </div>
  );
}

// ── Summary editor ───────────────────────────────────────────────────────────

function SummaryEditor({
  segmentId,
  initial,
  onUpdated,
}: {
  segmentId: number;
  initial: EvalSegmentSummary;
  onUpdated: () => void;
}) {
  const [rating, setRating] = useState<number | null>(initial.overall_rating);
  const [comment, setComment] = useState(initial.overall_comment ?? "");
  const [status, setStatus] = useState<EvalStatus>(initial.eval_status);
  const [saving, setSaving] = useState(false);
  const dirty =
    rating !== initial.overall_rating ||
    comment !== (initial.overall_comment ?? "") ||
    status !== initial.eval_status;

  async function save() {
    setSaving(true);
    try {
      await patchEvalSummary(segmentId, {
        eval_status: status,
        overall_rating: rating,
        overall_comment: comment,
      });
      onUpdated();
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
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as EvalStatus)}
          style={{
            padding: "4px 8px",
            border: "1px solid #E5E5EA",
            borderRadius: 6,
            fontSize: 12,
            fontFamily: FONT,
          }}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_STYLE[s].label}
            </option>
          ))}
        </select>
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
}: {
  segmentId: number;
  msg: EvalMessage;
  onFeedbackChanged: () => void;
}) {
  // Trace defaults to expanded for assistant turns — that's the whole point
  // of the eval view. User can still collapse if they want a clean transcript.
  const isAssistant = msg.role === "assistant";
  const [traceOpen, setTraceOpen] = useState(isAssistant);
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
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ fontSize: 11, color: "#8E8E93", marginRight: 4 }}>{label}:</span>
      {children}
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
  // Apple-Notes-restraint pill: light gray surface, no bright fill on active.
  // The accent only colors the text (subtly) when active, leaving the grid
  // visually quiet. Inactive = ghost.
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        background: active ? "#F2F2F7" : "transparent",
        color: active ? "#1C1C1E" : "#8E8E93",
        border: `1px solid ${active ? "#D1D1D6" : "#E5E5EA"}`,
        borderRadius: 999,
        padding: "3px 10px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: active ? 500 : 400,
        fontFamily: FONT,
        opacity: active ? 1 : 0.85,
        // accent shows up as a left-edge bar when active to give a quiet hint
        // of which pill carries which source/status without filling the pill.
        boxShadow: active ? `inset 2px 0 0 ${accent}` : "none",
        transition: "background 0.12s, color 0.12s, box-shadow 0.12s",
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

function StatusPill({ status }: { status: EvalStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span
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
      }}
    >
      {s.label}
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
  // #101: button label shows number + emoji + word so the reviewer sees
  // what 1/2/3 mean without hovering for the title tooltip. Title kept
  // for accessibility / longer keyboard exploration.
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {RATING_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(value === opt.value ? null : opt.value)}
          title={`${opt.value} = ${opt.label}`}
          style={{
            background: value === opt.value ? "#0A84FF" : "transparent",
            color: value === opt.value ? "#FFFFFF" : "#1C1C1E",
            border: "1px solid #E5E5EA",
            borderRadius: 6,
            padding: "4px 10px",
            cursor: "pointer",
            fontSize: 13,
            fontFamily: FONT,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <span style={{ fontWeight: 600 }}>{opt.value}</span>
          <span>{opt.emoji}</span>
          <span style={{ fontSize: 12 }}>{opt.label.toLowerCase()}</span>
        </button>
      ))}
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function formatDate(d: Date): string {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}
