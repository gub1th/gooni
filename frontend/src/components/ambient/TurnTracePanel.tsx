import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { FONT, frost, z } from "../../ui";
import { fetchTurnTrace, type TurnTrace, type EvalToolCall } from "../../services/api";

// Fullscreen audit panel for ONE chat turn — the trace from the orchestrator
// (intent → memory → prompt → tool calls → verify → reply) plus the tool-call
// audit rows and the post-turn reflexion. Opened from the recent-chat ribbon's
// per-turn audit button. Read-only; frosted to match the summoned-surface
// theme (the ribbon itself is bare text, this is the deep-dive).

const GREEN = "rgba(74,222,128,0.9)";
const SOURCE_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  imessage: "iMessage",
  web: "web",
};

export function TurnTracePanel({ messageId, onClose }: { messageId: number; onClose: () => void }) {
  const [data, setData] = useState<TurnTrace | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

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
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: z.modalScrim,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
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
          width: "min(920px, 94vw)",
          height: "min(90vh, 900px)",
          borderRadius: 18,
          border: "1px solid rgba(244,245,244,0.13)",
          boxShadow: "0 30px 90px rgba(0,0,0,0.65)",
          ...frost.sheet,
          color: "#F4F5F4",
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
            borderBottom: "1px solid rgba(244,245,244,0.08)",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.2 }}>Turn audit</span>
          {data && (
            <span
              style={{
                fontSize: 11,
                color: "rgba(244,245,244,0.5)",
                border: "1px solid rgba(244,245,244,0.18)",
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
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 22px 28px" }}>
          {state === "loading" && <Dim>loading trace…</Dim>}
          {state === "error" && <Dim>couldn't load this turn's trace</Dim>}
          {state === "ready" && data && <TraceBody data={data} />}
        </div>
      </div>
    </div>
  );
}

function TraceBody({ data }: { data: TurnTrace }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      {/* the exchange */}
      <Section title="Exchange">
        {data.user_message && (
          <Bubble who="you" text={data.user_message.content} />
        )}
        <Bubble who="gooni" text={data.message.content} />
      </Section>

      {/* orchestrator steps */}
      <Section title={`Trace · ${data.trace.length} step${data.trace.length === 1 ? "" : "s"}`}>
        {data.trace.length === 0 && <Dim>no trace recorded for this turn</Dim>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {data.trace.map((s, i) => (
            <div
              key={i}
              style={{
                borderLeft: "2px solid rgba(74,222,128,0.5)",
                paddingLeft: 12,
                display: "flex",
                flexDirection: "column",
                gap: 3,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: GREEN }}>
                {s.label || s.type}
              </div>
              {s.detail && <Mono>{s.detail}</Mono>}
              {s.args && Object.keys(s.args).length > 0 && (
                <Mono dim>{JSON.stringify(s.args, null, 2)}</Mono>
              )}
            </div>
          ))}
        </div>
      </Section>

      {/* tool calls */}
      {data.tool_calls.length > 0 && (
        <Section title={`Tool calls · ${data.tool_calls.length}`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {data.tool_calls.map((t) => (
              <ToolCallRow key={t.id} t={t} />
            ))}
          </div>
        </Section>
      )}

      {/* reflexion */}
      {data.reflection && (
        <Section title="Reflexion">
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
            <Field label="severity" value={String(data.reflection.severity)} />
            <Field label="acted vs described" value={data.reflection.action_vs_described} />
            {data.reflection.critique_summary && (
              <Field label="critique" value={data.reflection.critique_summary} />
            )}
            {data.reflection.gap_exposed && (
              <Field label="gap" value={data.reflection.gap_exposed} />
            )}
            {data.reflection.proposed_self_fix && (
              <Field label="self-fix" value={data.reflection.proposed_self_fix} />
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

function ToolCallRow({ t }: { t: EvalToolCall }) {
  const statusColor =
    t.status === "done" ? GREEN : t.status === "failed" ? "#FF6B6B" : "rgba(245,158,11,0.9)";
  return (
    <div
      style={{
        border: "1px solid rgba(244,245,244,0.1)",
        borderRadius: 10,
        padding: "10px 12px",
        background: "rgba(244,245,244,0.03)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{t.tool_name}</span>
        <span style={{ fontSize: 10.5, color: statusColor, textTransform: "uppercase", letterSpacing: 0.5 }}>
          {t.status}
        </span>
        {t.duration_ms != null && (
          <span style={{ fontSize: 10.5, color: "rgba(244,245,244,0.4)" }}>{t.duration_ms}ms</span>
        )}
      </div>
      {t.args_json && <Mono dim>{t.args_json}</Mono>}
      {t.error ? <Mono danger>{t.error}</Mono> : t.result_json && <Mono>{t.result_json}</Mono>}
    </div>
  );
}

// ── bits ────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: 1,
          textTransform: "uppercase",
          color: "rgba(244,245,244,0.4)",
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Bubble({ who, text }: { who: "you" | "gooni"; text: string }) {
  return (
    <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: who === "gooni" ? GREEN : "rgba(244,245,244,0.55)",
          minWidth: 44,
          flexShrink: 0,
        }}
      >
        {who}
      </span>
      <span style={{ fontSize: 13.5, lineHeight: 1.5, color: "rgba(244,245,244,0.92)", whiteSpace: "pre-wrap" }}>
        {text}
      </span>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 10 }}>
      <span style={{ fontSize: 12, color: "rgba(244,245,244,0.45)", minWidth: 120, flexShrink: 0 }}>
        {label}
      </span>
      <span style={{ fontSize: 13, color: "rgba(244,245,244,0.9)" }}>{value}</span>
    </div>
  );
}

function Mono({ children, dim, danger }: { children: React.ReactNode; dim?: boolean; danger?: boolean }) {
  return (
    <pre
      style={{
        margin: 0,
        fontFamily: "'SF Mono', Menlo, monospace",
        fontSize: 11.5,
        lineHeight: 1.5,
        color: danger ? "#FF9B9B" : dim ? "rgba(244,245,244,0.5)" : "rgba(244,245,244,0.82)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: 180,
        overflowY: "auto",
      }}
    >
      {children}
    </pre>
  );
}

function Dim({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, color: "rgba(244,245,244,0.45)" }}>{children}</div>;
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
  color: "rgba(244,245,244,0.6)",
};
