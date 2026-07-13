import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  deleteMessageRating,
  fetchReflections,
  putMessageRating,
  type EvalMessage,
  type EvalMessageRating,
  type EvalStatus,
  type EvalToolCall,
} from "../../services/api";
import { Check, Minus, X } from "lucide-react";
import { frostInk as ctok, FONT } from "../../ui";
import { RATING_COLOR_EVAL, RATING_LABEL_EVAL } from "./evalShared";
import { StepCard } from "./TraceStepCard";

// ── Message card with trace + step flags ─────────────────────────────────────

export function MessageCard({
  segmentId,
  msg,
  onFeedbackChanged,
  onRatingPatched,
}: {
  segmentId: number;
  msg: EvalMessage;
  onFeedbackChanged: () => void;
  onRatingPatched: (
    messageId: number,
    rating: EvalMessageRating | null,
    segmentStatus?: EvalStatus,
  ) => void;
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

  // Role distinction comes from the header label color (assistant = accent,
  // user = muted) + the rating/trace affordances that only render on
  // assistant turns — not from card outlines. Both rows sit on the same
  // surface (#0C0C0C card on the black canvas); depth is surface, not stroke.
  return (
    <div
      style={{
        background: ctok.card,
        borderRadius: 14,
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
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: isAssistant ? ctok.accent : ctok.faint,
        }}
      >
        <strong>{msg.role}</strong>
        <span style={{ color: ctok.faint }}>· #{msg.id}</span>
        {msg.created_at && (
          <span style={{ color: ctok.faint }}>
            · {new Date(msg.created_at).toLocaleString()}
          </span>
        )}
        {msg.is_feedback && <span style={{ color: ctok.warn }}>· feedback</span>}
      </div>
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: ctok.text,
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
              color: ctok.accent,
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
                color: ctok.muted,
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
    ? { bg: ctok.badDim, color: ctok.bad, label: "load-bearing" }
    : { bg: "rgba(224,168,62,0.14)", color: ctok.warn, label: "notable" };

  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 12px",
        background: ctok.cardRaised,
        borderRadius: 14,
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
            letterSpacing: "0.08em",
            color: ctok.faint,
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
        <span style={{ fontSize: 11, color: ctok.muted }}>
          · {reflection.action_vs_described}
        </span>
      </div>
      {reflection.critique_summary && (
        <div style={{ fontSize: 13, color: ctok.text, marginBottom: 4 }}>
          <strong>Daniel pushed back:</strong> {reflection.critique_summary}
        </div>
      )}
      {reflection.gap_exposed && (
        <div style={{ fontSize: 13, color: ctok.text, marginBottom: 4 }}>
          <strong>Gap:</strong> {reflection.gap_exposed}
        </div>
      )}
      {reflection.proposed_self_fix && (
        <div style={{ fontSize: 13, color: ctok.text }}>
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
          color: failed > 0 ? ctok.danger : ctok.accent,
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
      ? ctok.accentDim
      : tc.status === "failed"
      ? ctok.badDim
      : "rgba(224,168,62,0.14)";
  const pillColor =
    tc.status === "done"
      ? ctok.accent
      : tc.status === "failed"
      ? ctok.bad
      : ctok.warn;
  return (
    <div
      style={{
        borderRadius: 14,
        padding: 8,
        background: ctok.cardRaised,
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
            borderRadius: 999,
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 0.3,
            fontWeight: 600,
          }}
        >
          {tc.status}
        </span>
        <strong style={{ color: ctok.text }}>{tc.tool_name}</strong>
        {tc.duration_ms != null && (
          <span style={{ color: ctok.muted }}>· {tc.duration_ms}ms</span>
        )}
        <span style={{ color: ctok.muted, marginLeft: "auto" }}>
          #{tc.id} {expanded ? "▾" : "▸"}
        </span>
      </div>
      {tc.error && (
        <div style={{ marginTop: 6, color: ctok.bad, fontFamily: ctok.mono, whiteSpace: "pre-wrap" }}>
          {tc.error}
        </div>
      )}
      {expanded && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {tc.args_json && (
            <details>
              <summary style={{ cursor: "pointer", color: ctok.accent }}>args</summary>
              <pre
                style={{
                  margin: "4px 0 0 0",
                  padding: 8,
                  background: ctok.codeBg,
                  color: ctok.text,
                  fontFamily: ctok.mono,
                  borderRadius: 8,
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
              <summary style={{ cursor: "pointer", color: ctok.accent }}>result</summary>
              <pre
                style={{
                  margin: "4px 0 0 0",
                  padding: 8,
                  background: ctok.codeBg,
                  color: ctok.text,
                  fontFamily: ctok.mono,
                  borderRadius: 8,
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
  onRatingPatched: (
    messageId: number,
    rating: EvalMessageRating | null,
    segmentStatus?: EvalStatus,
  ) => void;
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
        onRatingPatched(
          messageId,
          {
            id: updated.id,
            rating: updated.rating,
            comment: updated.comment,
            updated_at: updated.updated_at,
          },
          updated.segment_eval_status,
        );
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
      onRatingPatched(
        messageId,
        {
          id: updated.id,
          rating: updated.rating,
          comment: updated.comment,
          updated_at: updated.updated_at,
        },
        updated.segment_eval_status,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      style={{
        marginTop: 10,
        paddingTop: 10,
        borderTop: `1px solid ${ctok.hairline}`,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, color: ctok.faint, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginRight: 4 }}>Reply</span>
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
                width: 28, height: 28, borderRadius: 999,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                background: active ? `${RATING_COLOR_EVAL[r]}1F` : "transparent",
                border: active ? "none" : `1px solid ${ctok.hairline}`,
                color: RATING_COLOR_EVAL[r],
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
          boxSizing: "border-box",
          fontSize: 12.5,
          fontFamily: FONT,
          lineHeight: 1.5,
          padding: "8px 10px",
          border: "none",
          borderRadius: 14,
          resize: "vertical",
          outline: "none",
          background: ctok.inputBg,
          color: ctok.text,
          overflow: "hidden",
        }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        {dirty && (
          <button
            onClick={() => setComment(existing?.comment ?? "")}
            disabled={pending}
            style={{
              padding: "5px 14px", borderRadius: 999,
              border: `1px solid ${ctok.hairline}`, background: "transparent",
              color: ctok.muted, fontSize: 12, fontWeight: 600,
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
            padding: "5px 14px", borderRadius: 999,
            border: "none",
            background: ctok.accentDim,
            color: ctok.accent,
            opacity: canSave ? 1 : 0.4,
            fontSize: 12, fontWeight: 600,
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
