import { useEffect, useMemo, useState } from "react";
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

// Per-source visual identity. Border + badge so a glance at the grid tells
// you whether a card is web (browser session), Telegram (bot), WhatsApp, or
// iMessage. Match Apple-system colors for consistency with the rest of Gooni.
const SOURCE_STYLE: Record<
  string,
  { color: string; badge: string; label: string }
> = {
  web: { color: "#0A84FF", badge: "🌐", label: "Web" },
  telegram: { color: "#5AC8FA", badge: "✈", label: "Telegram" },
  whatsapp: { color: "#34C759", badge: "💬", label: "WhatsApp" },
  imessage: { color: "#8E8E93", badge: "📱", label: "iMessage" },
};

const STATUS_STYLE: Record<EvalStatus, { color: string; bg: string; label: string }> = {
  not_yet: { color: "#8E8E93", bg: "#F2F2F7", label: "Not yet" },
  pending: { color: "#FF9500", bg: "#FFF4E6", label: "Pending" },
  done: { color: "#34C759", bg: "#E8F8EE", label: "Done" },
};

const SOURCES = ["web", "telegram", "whatsapp", "imessage"] as const;
const STATUSES: EvalStatus[] = ["not_yet", "pending", "done"];

const RATING_OPTIONS: { value: 1 | 2 | 3; label: string; emoji: string }[] = [
  { value: 1, label: "Bad", emoji: "👎" },
  { value: 2, label: "Meh", emoji: "😐" },
  { value: 3, label: "Good", emoji: "👍" },
];

export function EvalView() {
  const [segments, setSegments] = useState<EvalSegmentSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters live in component state — no URL plumbing yet, can be added later.
  const [sourcesFilter, setSourcesFilter] = useState<string[]>([...SOURCES]);
  const [statusesFilter, setStatusesFilter] = useState<EvalStatus[]>([...STATUSES]);
  const [hasFlagOnly, setHasFlagOnly] = useState(false);
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
        limit: 100,
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
        background: "#FAFAFA",
        fontFamily: FONT,
        overflow: "hidden",
      }}
    >
      {/* Header + filters */}
      <div
        style={{
          padding: "20px 24px 16px",
          borderBottom: "1px solid rgba(0,0,0,0.06)",
          background: "#FFFFFF",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Eval</h1>
          <span style={{ fontSize: 13, color: "#8E8E93" }}>{total} segments</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <FilterGroup label="Source">
            {SOURCES.map((src) => (
              <FilterPill
                key={src}
                active={sourcesFilter.includes(src)}
                color={SOURCE_STYLE[src]?.color ?? "#8E8E93"}
                onClick={() => toggleSource(src)}
              >
                {SOURCE_STYLE[src]?.badge} {SOURCE_STYLE[src]?.label}
              </FilterPill>
            ))}
          </FilterGroup>
          <FilterGroup label="Status">
            {STATUSES.map((s) => (
              <FilterPill
                key={s}
                active={statusesFilter.includes(s)}
                color={STATUS_STYLE[s].color}
                onClick={() => toggleStatus(s)}
              >
                {STATUS_STYLE[s].label}
              </FilterPill>
            ))}
          </FilterGroup>
          <FilterPill
            active={hasFlagOnly}
            color="#FF3B30"
            onClick={() => setHasFlagOnly((v) => !v)}
          >
            🚩 Has flag
          </FilterPill>
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
            }}
          />
        </div>
      </div>

      {/* Grid */}
      <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
        {error && (
          <div style={{ color: "#FF3B30", fontSize: 13, marginBottom: 12 }}>{error}</div>
        )}
        {loading && segments.length === 0 ? (
          <div style={{ color: "#8E8E93", fontSize: 13 }}>Loading…</div>
        ) : segments.length === 0 ? (
          <div style={{ color: "#8E8E93", fontSize: 13 }}>
            No segments match these filters. Try widening source / status, or clear search.
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: 16,
            }}
          >
            {segments.map((seg) => (
              <SegmentCard
                key={seg.id}
                seg={seg}
                onClick={() => setSelectedSegmentId(seg.id)}
              />
            ))}
          </div>
        )}
      </div>
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
        padding: 16,
        borderRadius: 12,
        background: "#FFFFFF",
        border: `1px solid ${sourceStyle.color}33`,
        borderLeft: `4px solid ${sourceStyle.color}`,
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        cursor: "pointer",
        fontFamily: FONT,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 140,
        transition: "transform 0.1s, box-shadow 0.15s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.08)";
        e.currentTarget.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.04)";
        e.currentTarget.style.transform = "translateY(0)";
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: sourceStyle.color,
            letterSpacing: 0.3,
            textTransform: "uppercase",
          }}
        >
          {sourceStyle.badge} {sourceStyle.label}
        </span>
        <StatusPill status={seg.eval_status} />
      </div>
      <div style={{ fontSize: 13, color: "#1C1C1E", lineHeight: 1.4, flex: 1 }}>
        {seg.preview ? truncate(seg.preview, 160) : <em style={{ color: "#8E8E93" }}>(no user message)</em>}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: "#8E8E93" }}>
        <span>{seg.message_count} msg</span>
        <span>{when ? formatDate(when) : "—"}</span>
        {seg.flag_count > 0 && (
          <span style={{ color: "#FF3B30" }}>🚩 {seg.flag_count}</span>
        )}
        {seg.dispatched_to_cc_at && (
          <span style={{ color: "#0A84FF" }}>→ CC</span>
        )}
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
            <span style={{ fontSize: 12, color: "#8E8E93" }}>
              {SOURCE_STYLE[seg.source]?.badge} {SOURCE_STYLE[seg.source]?.label}
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
  const [traceOpen, setTraceOpen] = useState(false);
  const isAssistant = msg.role === "assistant";
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

  return (
    <div
      style={{
        background: "#FFFFFF",
        border: "1px solid #E5E5EA",
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
          color: "#8E8E93",
          textTransform: "uppercase",
          letterSpacing: 0.3,
        }}
      >
        <strong>{msg.role}</strong>
        <span>· #{msg.id}</span>
        {msg.created_at && <span>· {new Date(msg.created_at).toLocaleString()}</span>}
        {msg.is_feedback && <span style={{ color: "#FF9500" }}>· feedback</span>}
      </div>
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {msg.content}
      </div>

      {isAssistant && trace.length > 0 && (
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
            {traceOpen ? "▾" : "▸"} Trace ({trace.length} step{trace.length === 1 ? "" : "s"})
          </button>
          {traceOpen && (
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
        <span style={{ fontSize: 11, fontWeight: 600, color: "#8E8E93" }}>{stepKey}</span>
        <span style={{ fontSize: 13 }}>{step.label}</span>
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

function StepBody({ step }: { step: MessageTraceStep }) {
  // Render input/output if present; fall back to legacy detail/args. Always
  // collapsible so step cards stay compact in the timeline.
  const out = step.output ?? step.detail ?? null;
  const inp = step.input ?? step.args ?? null;
  const meta = step.meta ?? null;
  const hasContent = out != null || inp != null || (meta && Object.keys(meta).length > 0);
  if (!hasContent) return null;
  return (
    <details style={{ marginTop: 6 }}>
      <summary style={{ fontSize: 11, color: "#8E8E93", cursor: "pointer" }}>
        details
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
  color,
  onClick,
  children,
}: {
  active: boolean;
  color: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? color : "transparent",
        color: active ? "#FFFFFF" : color,
        border: `1px solid ${color}`,
        borderRadius: 12,
        padding: "3px 10px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 600,
        fontFamily: FONT,
      }}
    >
      {children}
    </button>
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
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {RATING_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(value === opt.value ? null : opt.value)}
          title={opt.label}
          style={{
            background: value === opt.value ? "#0A84FF" : "transparent",
            color: value === opt.value ? "#FFFFFF" : "#1C1C1E",
            border: "1px solid #E5E5EA",
            borderRadius: 6,
            padding: "4px 10px",
            cursor: "pointer",
            fontSize: 14,
            fontFamily: FONT,
          }}
        >
          {opt.emoji}
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
