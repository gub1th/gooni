import { useEffect, useState } from "react";
import {
  dispatchEvalToCc,
  fetchEvalSegmentFull,
  fetchEvalToolsLegend,
  patchEvalSummary,
  type EvalSegmentFull,
  type EvalSegmentSummary,
  type EvalStatus,
  type EvalToolLegendEntry,
} from "../../services/api";
import { color as ctok, FONT, z } from "../../ui";
import {
  ActiveBadge,
  Dot,
  ModalButton,
  RatedProgressBadge,
  RatingPicker,
  StatusPill,
} from "./EvalAtoms";
import { SOURCE_STYLE } from "./evalShared";
import { MessageCard } from "./MessageCard";
import { printSegmentPdf } from "./segmentPrint";

// ── Detail view ──────────────────────────────────────────────────────────────
export function EvalDetailView({
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
        background: ctok.bg,
        fontFamily: FONT,
        overflow: "hidden",
      }}
    >
      {/* Export PDF builds a standalone HTML doc + prints it in a hidden iframe
          (see printSegmentPdf) — no @media print clipping of the live app DOM. */}
      {/* Header */}
      <div
        style={{
          padding: "16px 24px",
          borderBottom: `1px solid ${ctok.border}`,
          background: "var(--gooni-card, #FFFFFF)",
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
            color: ctok.accent,
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
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--gooni-text, #3C3C43)" }}>
              <Dot color={SOURCE_STYLE[seg.source]?.accent ?? ctok.muted} />
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
              border: `1px solid ${ctok.border}`,
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
            onClick={() => data && printSegmentPdf(data)}
            disabled={!data}
            title="Save this segment as a PDF (full transcript + feedback)"
            style={{
              background: "transparent",
              color: ctok.accent,
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
              background: seg?.dispatched_to_cc_at ? "#34C759" : ctok.accent,
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
        {error && <div style={{ color: ctok.danger }}>{error}</div>}
        {loading && !data ? (
          <div style={{ color: ctok.muted, fontSize: 13 }}>Loading…</div>
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
                  onRatingPatched={(mid, rating, segmentStatus) =>
                    setData((prev) =>
                      prev
                        ? {
                            ...prev,
                            // Mirror the server's not_yet→pending bump (one-way)
                            // so the header pill updates without a full refetch.
                            segment: segmentStatus
                              ? { ...prev.segment, eval_status: segmentStatus }
                              : prev.segment,
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
        zIndex: z.modalScrim,
        fontFamily: FONT,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--gooni-card, #FFFFFF)",
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
            <div style={{ fontSize: 15, fontWeight: 600, color: ctok.text }}>
              {alreadyDispatched ? "Re-dispatch this eval?" : "Dispatch this eval to Claude Code?"}
            </div>
            <div style={{ fontSize: 13, color: "var(--gooni-text, #3C3C43)", lineHeight: 1.5 }}>
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
          <div style={{ fontSize: 14, color: "var(--gooni-text, #3C3C43)" }}>Dispatching…</div>
        )}
        {modal.state === "success" && (
          <>
            <div style={{ fontSize: 15, fontWeight: 600, color: ctok.text }}>
              {modal.rewrote ? "Note overwritten" : "Note created"}
            </div>
            <div style={{ fontSize: 13, color: "var(--gooni-text, #3C3C43)", lineHeight: 1.5 }}>
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
            <div style={{ fontSize: 15, fontWeight: 600, color: ctok.danger }}>Dispatch failed</div>
            <div style={{ fontSize: 13, color: "var(--gooni-text, #3C3C43)", lineHeight: 1.5 }}>{modal.message}</div>
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
        background: "var(--gooni-card, #FFFFFF)",
        border: `1px solid ${ctok.border}`,
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
            background: dirty ? ctok.accent : ctok.border,
            color: dirty ? "#FFFFFF" : ctok.muted,
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
          border: `1px solid ${ctok.border}`,
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
        zIndex: z.modalScrim,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--gooni-card, #FFFFFF)",
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
            style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: ctok.muted }}
          >
            ✕
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {entries.map((e) => (
            <div key={e.key}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {e.name} <span style={{ color: ctok.muted, fontWeight: 400 }}>({e.key})</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--gooni-text, #3A3A3C)", marginTop: 2, lineHeight: 1.5 }}>
                {e.description}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
