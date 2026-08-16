import { useState } from "react";
import {
  postEvalFeedback,
  type EvalMessage,
  type MessageTraceStep,
} from "../../services/api";
import { frostInk as ctok, FONT, z } from "../../ui";
import { decodeEscapes } from "../../utils/decodeEscapes";
import { RatingPicker } from "./EvalAtoms";

// ── Step card with flag popover ──────────────────────────────────────────────

export function StepCard({
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
        background: ctok.cardRaised,
        borderRadius: 14,
        padding: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: ctok.muted, flexShrink: 0, paddingTop: 1, fontFamily: ctok.mono }}>
          {toolName ? `${stepKey}: ${toolName}` : stepKey}
        </span>
        {/* Take the remaining width and wrap — long verify/critique labels
            used to overflow the card and get hard-clipped with no ellipsis. */}
        <span style={{ fontSize: 13, flex: 1, minWidth: 0, lineHeight: 1.4, overflowWrap: "anywhere", color: ctok.text }}>
          {headerLabel}
        </span>
        <button
          onClick={() => setFlagOpen((v) => !v)}
          style={{
            marginLeft: "auto",
            flexShrink: 0,
            background: existing ? ctok.badDim : "transparent",
            border: existing ? "none" : `1px solid ${ctok.hairline}`,
            color: existing ? ctok.bad : ctok.muted,
            borderRadius: 999,
            padding: "2px 8px",
            cursor: "pointer",
            fontSize: 12,
            fontFamily: FONT,
          }}
          title={existing ? `Rated ${existing.rating}/3 — click to edit` : "Flag this step"}
        >
          {existing ? `${existing.rating}/3` : "Flag"}
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
      <summary style={{ fontSize: 11, color: ctok.muted, cursor: "pointer" }}>
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
  const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  // Payloads (esp. reply/output text) arrive with JSON string escapes still
  // literal (\n \t \" \\ …) — decode once here so the inline preview shows
  // real line breaks instead of a wall of "\n" characters.
  const text = decodeEscapes(raw);
  // Big payloads (master_prompt, recall) get an expand button → modal for a
  // focused read.
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
        <span style={{ fontSize: 10, color: ctok.faint, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>{label}</span>
        {showExpand && (
          <button
            onClick={() => setExpanded(true)}
            title="View formatted (newlines expanded)"
            style={{
              background: "transparent",
              border: `1px solid ${ctok.hairline}`,
              borderRadius: 999,
              padding: "1px 8px",
              fontSize: 10,
              color: ctok.accent,
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
          background: ctok.codeBg,
          color: ctok.text,
          border: "none",
          borderRadius: 8,
          fontSize: 11,
          fontFamily: ctok.mono,
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

// Modal for a focused read of an already-decoded payload (see CodeBlock,
// which decodes JSON string escapes once before either the inline preview
// or this modal ever sees the text).
function FormattedModal({
  label,
  text,
  onClose,
}: {
  label: string;
  text: string;
  onClose: () => void;
}) {
  const formatted = text;
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
        zIndex: z.modalScrim,
        fontFamily: FONT,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: ctok.card,
          borderRadius: 14,
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
          <span style={{ fontSize: 14, fontWeight: 600, color: ctok.text }}>
            {label} — formatted
          </span>
          <button
            onClick={onClose}
            style={{
              marginLeft: "auto",
              background: "transparent",
              border: `1px solid ${ctok.hairline}`,
              borderRadius: 999,
              padding: "5px 14px",
              fontSize: 12,
              color: ctok.muted,
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
            background: ctok.codeBg,
            color: ctok.text,
            border: "none",
            borderRadius: 10,
            fontSize: 12,
            lineHeight: 1.5,
            fontFamily: ctok.mono,
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
        background: ctok.badDim,
        borderRadius: 14,
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
            color: ctok.muted,
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
          padding: 8,
          border: "none",
          borderRadius: 14,
          fontSize: 12,
          fontFamily: FONT,
          resize: "vertical",
          outline: "none",
          boxSizing: "border-box",
          background: ctok.inputBg,
          color: ctok.text,
        }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
        <button
          onClick={submit}
          disabled={saving}
          style={{
            background: ctok.badDim,
            color: ctok.bad,
            border: "none",
            borderRadius: 999,
            padding: "5px 14px",
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
