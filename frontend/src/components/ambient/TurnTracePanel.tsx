import { useEffect, useMemo, useState } from "react";
import { X, ArrowUpRight } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { FONT, frost, frostInk, z } from "../../ui";
import { decodeEscapes } from "../../utils/decodeEscapes";
import {
  fetchTurnTrace,
  fetchSegmentForMessage,
  type TurnTrace,
  type EvalToolCall,
  type EvalReflectionInline,
  type MessageTraceStep,
} from "../../services/api";

// Fullscreen audit panel for ONE chat turn — a GLANCE overview of the
// pipeline that ran (extract → recall → prompt → tools → reply), each stage
// rendered as its essence (a chip, a pill, a bar) rather than raw JSON.
// Deliberately different from the eval page: no flagging, no per-step
// forensics. One deep-dive only — the assembled prompt, opened in a modal
// with newlines decoded. "full audit →" hands off to the eval page for the
// real review. Opened from the recent-chat ribbon's per-turn audit button.

// Panel vocabulary mapped onto the shared dark-frost token (ui/frostInk) — the
// same palette eval + memories consume, so the audit surfaces stay in lockstep.
const GREEN = frostInk.good;
const AMBER = frostInk.warn;
const RED = frostInk.bad;
const INK = frostInk.text;
const MUT_1 = frostInk.strong;
const MUT_2 = frostInk.muted;
const MUT_3 = frostInk.faint;
const MUT_4 = frostInk.dim;
const HAIR = frostInk.hairline;
const MONO = frostInk.mono;
// Green tints local to this panel (split-bar fills) — no shared analog.
const GREEN_DIM = "rgba(74,222,128,0.55)";
const GREEN_FAINT = "rgba(74,222,128,0.12)";

const SOURCE_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  imessage: "iMessage",
  web: "web",
};

const stepKey = (s: MessageTraceStep): string => s.key ?? s.type;

export function TurnTracePanel({ messageId, onClose }: { messageId: number; onClose: () => void }) {
  const [data, setData] = useState<TurnTrace | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [promptOpen, setPromptOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    fetchTurnTrace(messageId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Prompt modal owns Escape while open; only the outer panel closes here.
        if (!promptOpen) onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, promptOpen]);

  const prompt = useMemo(() => (data ? extractPrompt(data.trace) : null), [data]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: z.modalScrim,
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(5px)",
        WebkitBackdropFilter: "blur(5px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: FONT,
        animation: "turn-trace-fade 160ms ease",
      }}
    >
      <style>{`@keyframes turn-trace-fade { from { opacity: 0 } to { opacity: 1 } }`}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(760px, 94vw)",
          height: "min(88vh, 880px)",
          borderRadius: 18,
          border: `1px solid ${HAIR}`,
          boxShadow: "0 30px 90px rgba(0,0,0,0.65)",
          ...frost.sheet,
          color: INK,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "14px 18px",
            borderBottom: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.08)",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.2 }}>Turn audit</span>
          {data && (
            <span
              style={{
                fontSize: 11,
                color: MUT_2,
                border: `1px solid ${MUT_4}`,
                borderRadius: 999,
                padding: "2px 9px",
              }}
            >
              {SOURCE_LABEL[data.message.source] ?? data.message.source}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button aria-label="Close" onClick={onClose} style={closeBtn}>
            <X size={18} />
          </button>
        </div>

        {/* body */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 22px 24px" }}>
          {state === "loading" && <Dim>loading trace…</Dim>}
          {state === "error" && <Dim>couldn't load this turn's trace</Dim>}
          {state === "ready" && data && (
            <TraceBody data={data} onReadPrompt={() => setPromptOpen(true)} />
          )}
        </div>

        {/* footer — deep link to the full eval review */}
        {state === "ready" && data && (
          <DeepLinkFooter messageId={messageId} onClose={onClose} />
        )}
      </div>

      {promptOpen && prompt && (
        <PromptModal
          chars={prompt.chars}
          historyMsgs={prompt.historyMsgs}
          text={prompt.system}
          truncated={prompt.truncated}
          onClose={() => setPromptOpen(false)}
        />
      )}
    </div>
  );
}

// ── body ─────────────────────────────────────────────────────────────────

function TraceBody({ data, onReadPrompt }: { data: TurnTrace; onReadPrompt: () => void }) {
  const trace = data.trace;
  // Pipeline order for the spine: every step except the reply and the raw
  // tool_call steps (those are folded into rich tool nodes from the audit
  // rows), then the tool nodes, then the reply, then a reflexion flag.
  const otherSteps = trace.filter((s) => {
    const k = stepKey(s);
    return k !== "reply" && k !== "tool_call";
  });
  const replyStep = [...trace].reverse().find((s) => stepKey(s) === "reply") ?? null;
  const traceToolSteps = trace.filter((s) => stepKey(s) === "tool_call");
  const toolCalls = data.tool_calls;
  const totalMs = replyMs(replyStep);
  const refl = data.reflection && reflexionWorthShowing(data.reflection) ? data.reflection : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* the exchange */}
      <div>
        <ZoneLabel>Exchange</ZoneLabel>
        <div style={{ display: "grid", gridTemplateColumns: "44px 1fr", gap: "6px 10px" }}>
          {data.user_message && (
            <>
              <Who who="you" />
              <Said text={data.user_message.content} />
            </>
          )}
          <Who who="gooni" />
          <Said text={data.message.content} strong />
        </div>
      </div>

      {/* the pipeline spine */}
      <div>
        <ZoneLabel>{totalMs != null ? `Pipeline · ${totalMs}ms total` : "Pipeline"}</ZoneLabel>
        {trace.length === 0 ? (
          <Dim>no trace recorded for this turn</Dim>
        ) : (
          <div style={{ position: "relative", marginLeft: 2 }}>
            {/* the spine line */}
            <div
              style={{
                position: "absolute",
                left: 10,
                top: 8,
                bottom: 10,
                width: 2,
                background: `linear-gradient(${GREEN_DIM}, ${MUT_4})`,
              }}
            />
            {otherSteps.map((s, i) => (
              <StepNode key={`s${i}`} step={s} onReadPrompt={onReadPrompt} />
            ))}
            {toolCalls.length > 0
              ? toolCalls.map((t) => <ToolNode key={`t${t.id}`} t={t} />)
              : traceToolSteps.map((s, i) => (
                  <StepNode key={`ts${i}`} step={s} onReadPrompt={onReadPrompt} />
                ))}
            {replyStep && <ReplyNode step={replyStep} />}
            {refl && <ReflexionNode r={refl} />}
          </div>
        )}
      </div>
    </div>
  );
}

// ── spine node primitives ──────────────────────────────────────────────────

function Node({
  tone = "ok",
  glyph = "✓",
  stage,
  children,
  ms,
  sub,
}: {
  tone?: "ok" | "warn" | "bad";
  glyph?: string;
  stage: string;
  children?: React.ReactNode;
  ms?: string | null;
  sub?: React.ReactNode;
}) {
  const dotColor = tone === "bad" ? RED : tone === "warn" ? AMBER : GREEN;
  return (
    <div style={{ position: "relative", padding: "0 0 18px 34px" }}>
      <div
        style={{
          position: "absolute",
          left: 3,
          top: 1,
          width: 16,
          height: 16,
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          background: "#0a0d0c",
          border: `2px solid ${dotColor}`,
          color: dotColor,
          fontSize: 8.5,
        }}
      >
        {glyph}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: INK, letterSpacing: 0.1 }}>
          {stage}
        </span>
        {children}
        {ms && (
          <span
            style={{
              marginLeft: "auto",
              fontFamily: MONO,
              fontSize: 10.5,
              color: MUT_3,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {ms}
          </span>
        )}
      </div>
      {sub}
    </div>
  );
}

function Chip({ children, accent, dashed }: { children: React.ReactNode; accent?: boolean; dashed?: boolean }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: "2px 9px",
        borderRadius: 999,
        border: `1px ${dashed ? "dashed" : "solid"} ${accent ? GREEN_DIM : HAIR}`,
        background: accent ? GREEN_FAINT : "transparent",
        color: accent ? GREEN : dashed ? MUT_3 : MUT_1,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {children}
    </span>
  );
}

function Pill({ children, amber }: { children: React.ReactNode; amber?: boolean }) {
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        padding: "1px 8px",
        borderRadius: 6,
        background: amber ? "rgba(245,166,35,0.14)" : GREEN_FAINT,
        color: amber ? AMBER : GREEN,
        letterSpacing: 0.2,
      }}
    >
      {children}
    </span>
  );
}

function Ess({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 12.5, color: MUT_2 }}>{children}</span>;
}

// ── per-stage rendering ────────────────────────────────────────────────────

function StepNode({ step, onReadPrompt }: { step: MessageTraceStep; onReadPrompt: () => void }) {
  const k = stepKey(step);
  const meta = (step.meta ?? {}) as Record<string, number | undefined>;
  const output = step.output as Record<string, unknown> | undefined;

  switch (k) {
    case "pipeline_version": {
      const v = String((step.output as string) ?? step.detail ?? "");
      return (
        <Node stage="Pipeline">
          <Chip accent>{v}</Chip>
        </Node>
      );
    }
    case "extracted_signals": {
      const counts: Array<[string, number]> = [
        ["promise", meta.promise_count ?? 0],
        ["fitness", meta.fitness_count ?? 0],
        ["memory", meta.memory_count ?? 0],
        ["feature", meta.feature_count ?? 0],
        ["tone", meta.tone_count ?? 0],
      ];
      const hit = counts.filter(([, n]) => n > 0);
      const intent = output?.reply_intent as string | undefined;
      return (
        <Node stage="Extract">
          {hit.length === 0 ? (
            <Chip dashed>nothing captured</Chip>
          ) : (
            hit.map(([name, n]) => (
              <Pill key={name}>
                {n} {name}
                {n === 1 ? "" : "s"}
              </Pill>
            ))
          )}
          {intent && <Pill amber>reply: {intent}</Pill>}
        </Node>
      );
    }
    case "memory_recall": {
      const prefs = meta.prefs ?? 0;
      const cosine = meta.cosine ?? 0;
      return (
        <Node stage="Recall">
          <Ess>
            {prefs} prefs · {cosine} by similarity
          </Ess>
          {prefs + cosine > 0 && <RecallBar prefs={prefs} cosine={cosine} />}
        </Node>
      );
    }
    case "master_prompt": {
      const chars = (output?.system_total_chars as number) ?? 0;
      const hist = (step.input as { history_messages?: number } | undefined)?.history_messages ?? 0;
      return (
        <Node stage="Prompt">
          <Ess>
            {chars.toLocaleString()} chars · {hist} msgs history
          </Ess>
          <ReadPromptButton onClick={onReadPrompt} />
        </Node>
      );
    }
    case "memories_applied": {
      const a = meta.added_count ?? 0;
      const u = meta.updated_count ?? 0;
      const d = meta.deleted_count ?? 0;
      if (a + u + d === 0) return null; // pure-noop reconcile isn't glance-worthy
      return (
        <Node stage="Memory">
          <Ess>
            +{a} ~{u} −{d}
          </Ess>
        </Node>
      );
    }
    default:
      // intention / plan / verify / unknown — show the label as-is.
      return (
        <Node stage={humanize(k)}>
          <Ess>{step.label}</Ess>
        </Node>
      );
  }
}

function ReplyNode({ step }: { step: MessageTraceStep }) {
  const meta = (step.meta ?? {}) as { elapsed_ms?: number; usage?: { short_circuit?: boolean } };
  const output = step.output as { text?: string; preview?: string } | undefined;
  const shortCircuit = meta.usage?.short_circuit;
  const ms = meta.elapsed_ms != null ? `${meta.elapsed_ms}ms · ${shortCircuit ? "no LLM" : "LLM"}` : null;
  const text = output?.text ?? output?.preview ?? "";
  return (
    <Node
      stage="Reply"
      ms={ms}
      sub={
        text ? (
          <div
            style={{
              marginTop: 7,
              fontSize: 13,
              color: MUT_1,
              borderLeft: `2px solid ${GREEN_FAINT}`,
              paddingLeft: 10,
              whiteSpace: "pre-wrap",
            }}
          >
            {text}
          </div>
        ) : null
      }
    />
  );
}

function ToolNode({ t }: { t: EvalToolCall }) {
  const tone = t.status === "failed" ? "bad" : t.status === "running" ? "warn" : "ok";
  const glyph = t.status === "failed" ? "✕" : t.status === "running" ? "…" : "✓";
  const ms = t.duration_ms != null ? `${t.duration_ms}ms` : null;
  return (
    <Node
      stage="Tool"
      tone={tone}
      glyph={glyph}
      ms={ms}
      sub={
        t.error ? (
          <div
            style={{
              marginTop: 6,
              fontSize: 12,
              color: RED,
              fontFamily: MONO,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {t.error}
          </div>
        ) : null
      }
    >
      <span style={{ fontSize: 12.5, color: MUT_1, fontFamily: MONO }}>{t.tool_name}</span>
    </Node>
  );
}

function ReflexionNode({ r }: { r: EvalReflectionInline }) {
  const msg = r.critique_summary || r.gap_exposed || r.action_vs_described;
  return (
    <Node stage="Reflexion" tone="warn" glyph="!">
      <Ess>{msg}</Ess>
    </Node>
  );
}

function RecallBar({ prefs, cosine }: { prefs: number; cosine: number }) {
  return (
    <span
      style={{ display: "inline-flex", height: 6, width: 118, borderRadius: 4, overflow: "hidden" }}
      title={`${prefs} always-on prefs · ${cosine} cosine hits`}
    >
      <span style={{ flex: prefs || 0.01, background: MUT_4 }} />
      <span style={{ flex: cosine || 0.01, background: GREEN }} />
    </span>
  );
}

function ReadPromptButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontFamily: FONT,
        fontSize: 11.5,
        fontWeight: 600,
        color: GREEN,
        background: "transparent",
        border: `1px solid ${GREEN_DIM}`,
        borderRadius: 8,
        padding: "3px 10px",
        cursor: "pointer",
      }}
    >
      ⤢ read prompt
    </button>
  );
}

// ── deep-link footer ───────────────────────────────────────────────────────

function DeepLinkFooter({ messageId, onClose }: { messageId: number; onClose: () => void }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"idle" | "resolving" | "none">("idle");

  async function openFull() {
    setStatus("resolving");
    try {
      const segId = await fetchSegmentForMessage(messageId);
      if (segId == null) {
        setStatus("none");
        return;
      }
      onClose();
      navigate({
        to: "/",
        search: { audit: true, segment: segId, note: undefined, conv: undefined, view: undefined },
      });
    } catch {
      setStatus("none");
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 18px",
        borderTop: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.08)",
      }}
    >
      {status === "none" && (
        <span style={{ fontSize: 11.5, color: MUT_3 }}>not in the eval set yet</span>
      )}
      <button
        onClick={openFull}
        disabled={status === "resolving"}
        style={{
          marginLeft: "auto",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontFamily: FONT,
          fontSize: 12.5,
          fontWeight: 600,
          color: status === "resolving" ? MUT_3 : INK,
          background: "transparent",
          border: `1px solid ${HAIR}`,
          borderRadius: 9,
          padding: "5px 12px",
          cursor: status === "resolving" ? "wait" : "pointer",
        }}
      >
        {status === "resolving" ? "resolving…" : "full audit"}
        <ArrowUpRight size={14} />
      </button>
    </div>
  );
}

// ── prompt modal — the one deep-dive, newlines decoded ─────────────────────

function PromptModal({
  chars,
  historyMsgs,
  text,
  truncated,
  onClose,
}: {
  chars: number;
  historyMsgs: number;
  text: string;
  truncated: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: z.modalScrim + 1,
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily: FONT,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(760px, 96vw)",
          maxHeight: "84vh",
          display: "flex",
          flexDirection: "column",
          borderRadius: 16,
          border: `1px solid ${HAIR}`,
          boxShadow: "0 30px 90px rgba(0,0,0,0.7)",
          ...frost.sheet,
          color: INK,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 18px",
            borderBottom: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.08)",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 700 }}>Assembled prompt</span>
          <span style={{ fontFamily: MONO, fontSize: 11, color: MUT_3 }}>
            {chars.toLocaleString()} chars · {historyMsgs} msgs history
          </span>
          <button
            onClick={onClose}
            style={{
              marginLeft: "auto",
              background: "transparent",
              border: `1px solid ${MUT_4}`,
              color: MUT_2,
              borderRadius: 8,
              padding: "4px 12px",
              cursor: "pointer",
              fontFamily: FONT,
              fontSize: 12,
            }}
          >
            Close
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            overflow: "auto",
            padding: "18px 20px",
            fontFamily: MONO,
            fontSize: 12,
            lineHeight: 1.62,
            color: MUT_1,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {decodeEscapes(text)}
          {truncated && (
            <span style={{ color: MUT_3 }}>{"\n\n… (truncated at 12,000 chars — full text on the eval page)"}</span>
          )}
        </pre>
      </div>
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

// Pull the master_prompt step's payload for the prompt modal. output.system is
// already a real string (not JSON-escaped) in current traces, but older rows
// stored it escaped — decodeEscapes at render handles both.
function extractPrompt(trace: MessageTraceStep[]) {
  const step = trace.find((s) => stepKey(s) === "master_prompt");
  if (!step) return null;
  const output = step.output as
    | { system?: string; system_total_chars?: number; system_truncated?: boolean }
    | undefined;
  const input = step.input as { history_messages?: number } | undefined;
  return {
    system: output?.system ?? "",
    chars: output?.system_total_chars ?? 0,
    truncated: Boolean(output?.system_truncated),
    historyMsgs: input?.history_messages ?? 0,
  };
}

function replyMs(step: MessageTraceStep | null): number | null {
  if (!step) return null;
  const meta = step.meta as { elapsed_ms?: number } | undefined;
  return meta?.elapsed_ms ?? null;
}

// Surface a reflexion node only when it actually flags something — a clean
// self-check is noise on a glance panel.
function reflexionWorthShowing(r: EvalReflectionInline): boolean {
  return r.severity >= 2 || Boolean(r.gap_exposed) || r.user_critique_present;
}

function humanize(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ");
}

// ── small bits ─────────────────────────────────────────────────────────────

function ZoneLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 1.4,
        textTransform: "uppercase",
        color: MUT_3,
        marginBottom: 12,
      }}
    >
      {children}
    </div>
  );
}

function Who({ who }: { who: "you" | "gooni" }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 600, color: who === "gooni" ? GREEN : MUT_2, paddingTop: 1 }}>
      {who}
    </span>
  );
}

function Said({ text, strong }: { text: string; strong?: boolean }) {
  return (
    <span style={{ fontSize: 13.5, lineHeight: 1.5, color: strong ? MUT_1 : "rgb(var(--gooni-ink, 244 245 244) / 0.85)", whiteSpace: "pre-wrap" }}>
      {text}
    </span>
  );
}

function Dim({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, color: MUT_3 }}>{children}</div>;
}

const closeBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  borderRadius: 8,
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: MUT_2,
};
