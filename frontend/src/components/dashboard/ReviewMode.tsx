import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, X, RefreshCw } from "lucide-react";
import { FONT } from "../../ui";
import { SectionShell } from "../StatsView";
import {
  fetchLimbo,
  fetchSessionSummaries,
  promoteLimboItem,
  dismissLimboItem,
  runBatch,
  type ApiLimboItem,
  type ApiSessionSummary,
  type LimboPromoteTarget,
} from "../../services/api";

// ReviewMode — the desktop triage surface for the ambient loop.
//   1. Session summaries (5am batch output) — navigable ← →, prose +
//      breakdown rendered from the note HTML.
//   2. Limbo queue — each captured idea/context as a pill with
//      promote→{todo|focus|promise|memory} / dismiss. mention_count floats
//      recurring items up (sorted server-side).
//
// Additive new dashboard mode — touches nothing in Today/Ops/Stats.

const PROMOTE_TARGETS: { t: LimboPromoteTarget; label: string }[] = [
  { t: "todo", label: "todo" },
  { t: "focus", label: "focus" },
  { t: "promise", label: "promise" },
  { t: "memory", label: "memory" },
];

export function ReviewMode() {
  const qc = useQueryClient();
  const [sessionIdx, setSessionIdx] = useState(0);
  const [running, setRunning] = useState(false);

  const { data: sessions = [] } = useQuery<ApiSessionSummary[]>({
    queryKey: ["session-summaries"],
    queryFn: () => fetchSessionSummaries(30),
  });
  const { data: limbo = [] } = useQuery<ApiLimboItem[]>({
    queryKey: ["limbo"],
    queryFn: () => fetchLimbo(100),
  });

  const handleRun = async () => {
    setRunning(true);
    try {
      await runBatch(24);
      qc.invalidateQueries({ queryKey: ["session-summaries"] });
      qc.invalidateQueries({ queryKey: ["limbo"] });
    } catch (e) { console.error(e); } finally { setRunning(false); }
  };

  const promote = async (id: number, target: LimboPromoteTarget) => {
    try {
      await promoteLimboItem(id, target);
      qc.invalidateQueries({ queryKey: ["limbo"] });
      qc.invalidateQueries({ queryKey: ["todos"] });
      qc.invalidateQueries({ queryKey: ["focuses"] });
    } catch (e) { console.error(e); }
  };
  const dismiss = async (id: number) => {
    try {
      await dismissLimboItem(id);
      qc.invalidateQueries({ queryKey: ["limbo"] });
    } catch (e) { console.error(e); }
  };

  const idx = Math.min(sessionIdx, Math.max(0, sessions.length - 1));
  const current = sessions[idx];

  return (
    <div style={{ fontFamily: FONT, color: "var(--gooni-text, #1C1C1E)" }}>
      {/* Session summary, navigable */}
      <SectionShell
        label="Session review"
        right={
          <button
            onClick={handleRun}
            disabled={running}
            title="Run the batch processor now"
            style={{
              background: "none", border: "none", cursor: running ? "default" : "pointer",
              color: "var(--gooni-muted, #8E8E93)", display: "flex", alignItems: "center",
              gap: 4, fontSize: 11, fontFamily: FONT,
            }}
          >
            <RefreshCw size={12} style={{ animation: running ? "gooni-spin 0.8s linear infinite" : "none" }} />
            {running ? "processing…" : "run batch"}
          </button>
        }
      >
        {sessions.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)" }}>
            no processed sessions yet. dump some thoughts, then hit “run batch”.
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{current?.title ?? "Session"}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <NavBtn disabled={idx <= 0} onClick={() => setSessionIdx(idx - 1)}><ChevronLeft size={14} /></NavBtn>
                <span style={{ fontSize: 11, color: "var(--gooni-muted, #8E8E93)" }}>
                  {idx + 1}/{sessions.length}
                </span>
                <NavBtn disabled={idx >= sessions.length - 1} onClick={() => setSessionIdx(idx + 1)}><ChevronRight size={14} /></NavBtn>
              </div>
            </div>
            <div
              style={{ fontSize: 13, lineHeight: 1.5 }}
              // Content is server-built, TipTap-safe HTML (no scripts).
              dangerouslySetInnerHTML={{ __html: current?.content ?? "" }}
            />
          </div>
        )}
      </SectionShell>

      {/* Limbo queue — triage */}
      <SectionShell label={`Needs review${limbo.length ? ` · ${limbo.length}` : ""}`}>
        {limbo.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)" }}>
            nothing in limbo. ideas the batch can’t auto-type land here for you to promote.
          </div>
        ) : (
          limbo.map((item) => (
            <div key={item.id} style={{
              background: "rgba(0,0,0,0.03)", borderRadius: 8, padding: "10px 12px",
              marginBottom: 8,
            }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13 }}>{item.text}</div>
                  <div style={{ fontSize: 11, color: "var(--gooni-muted, #8E8E93)", marginTop: 2 }}>
                    {item.kind_hint ?? "idea"}
                    {item.mention_count > 1 ? ` · ${item.mention_count}× mentioned` : ""}
                  </div>
                </div>
                <button onClick={() => dismiss(item.id)} title="Dismiss"
                  style={{
                    width: 22, height: 22, borderRadius: 6, background: "var(--gooni-card, #fff)",
                    border: "0.5px solid rgba(0,0,0,0.10)", color: "var(--gooni-text, #1C1C1E)",
                    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                    padding: 0, flexShrink: 0,
                  }}>
                  <X size={11} />
                </button>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                {PROMOTE_TARGETS.map((p) => (
                  <button key={p.t} onClick={() => promote(item.id, p.t)}
                    style={{
                      fontSize: 11, padding: "3px 10px", borderRadius: 6,
                      background: "var(--gooni-card, #fff)", border: "0.5px solid rgba(0,0,0,0.12)",
                      color: "var(--gooni-text, #1C1C1E)", cursor: "pointer", fontFamily: FONT,
                    }}>
                    → {p.label}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </SectionShell>
    </div>
  );
}

function NavBtn({ children, disabled, onClick }: {
  children: React.ReactNode; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        width: 24, height: 24, borderRadius: 6, background: "var(--gooni-card, #fff)",
        border: "0.5px solid rgba(0,0,0,0.10)", cursor: disabled ? "default" : "pointer",
        color: disabled ? "var(--gooni-faint, #C7C7CC)" : "var(--gooni-text, #1C1C1E)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
      }}>
      {children}
    </button>
  );
}
