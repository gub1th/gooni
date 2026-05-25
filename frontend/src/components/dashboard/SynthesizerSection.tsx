import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, RefreshCw, Check, X } from "lucide-react";
import { FONT } from "../../ui";
import {
  fetchFocusCandidates,
  promoteFocusCandidate,
  dismissFocusCandidate,
  runFocusCandidates,
  type ApiFocusCandidate,
} from "../../services/api";

// SynthesizerSection — proposed focus-shaped clusters surfaced by the
// synth pipeline. Each renders as a pill: name + "<N> evidence items"
// subline + inline ✓ (promote → real Focus) / ✗ (dismiss → stays in
// DB so synth doesn't re-surface).
//
// High-confidence candidates (≥0.70) surface first. Low-confidence
// collapse into a "+ N more" expander so the audit surface stays
// glanceable.
//
// Refresh icon triggers POST /focus-candidates/run synchronously. UI
// shows a spinner during the call. If the synth hasn't been run yet
// at all, that's the natural prompt to hit the button.

const HIGH_CONF_FLOOR = 0.7;

// Mid-weight purple — legible on BOTH the light card (#FFF) and the dark
// card (#2A2A2C), same way the promise-card greens/ambers read on both.
// The old #534AB7 was tuned for light only (≈3.3:1 on dark = washed out).
const SYNTH_PURPLE = "#7C6FE8";
// Translucent tint reads as pale lavender over a light card, subtle purple
// glow over a dark one — no solid light hex that turns into a glaring box.
const SYNTH_TINT = "rgba(124,111,232,0.13)";
const SYNTH_BORDER = "rgba(124,111,232,0.38)";

export function SynthesizerSection() {
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);
  const [showLow, setShowLow] = useState(false);

  const { data: candidates = [] } = useQuery<ApiFocusCandidate[]>({
    queryKey: ["focus-candidates", "proposed"],
    queryFn: () => fetchFocusCandidates("proposed"),
  });

  const highConf = candidates.filter((c) => c.confidence >= HIGH_CONF_FLOOR);
  const lowConf = candidates.filter((c) => c.confidence < HIGH_CONF_FLOOR);

  const handleRun = async () => {
    setRunning(true);
    try {
      await runFocusCandidates();
      qc.invalidateQueries({ queryKey: ["focus-candidates"] });
      qc.invalidateQueries({ queryKey: ["focuses"] });
    } catch (e) { console.error(e); } finally {
      setRunning(false);
    }
  };

  const handlePromote = async (id: number) => {
    try {
      await promoteFocusCandidate(id);
      qc.invalidateQueries({ queryKey: ["focus-candidates"] });
      qc.invalidateQueries({ queryKey: ["focuses"] });
    } catch (e) { console.error(e); }
  };

  const handleDismiss = async (id: number) => {
    try {
      await dismissFocusCandidate(id);
      qc.invalidateQueries({ queryKey: ["focus-candidates"] });
    } catch (e) { console.error(e); }
  };

  return (
    <div style={{ fontFamily: FONT }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 6,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 500, color: SYNTH_PURPLE,
          letterSpacing: 0.3, display: "flex", alignItems: "center", gap: 4,
        }}>
          <Sparkles size={11} /> SYNTHESIZER
        </div>
        <button
          onClick={handleRun}
          disabled={running}
          title={running ? "Running…" : "Re-run synthesizer"}
          style={{
            background: "none", border: "none",
            cursor: running ? "default" : "pointer",
            color: "var(--gooni-muted, #8E8E93)", padding: 2,
            display: "flex", alignItems: "center",
          }}
        >
          <RefreshCw
            size={12}
            style={{
              animation: running ? "gooni-spin 0.8s linear infinite" : "none",
            }}
          />
        </button>
      </div>

      {highConf.length === 0 && lowConf.length === 0 && (
        <div style={{
          fontSize: 12, color: "var(--gooni-muted, #8E8E93)",
          padding: "8px 0",
        }}>
          {running ? "Running synth…" : "No proposals. Hit ↻ to run the synthesizer."}
        </div>
      )}

      {highConf.map((c) => (
        <Pill
          key={c.id}
          candidate={c}
          tone="primary"
          onPromote={() => handlePromote(c.id)}
          onDismiss={() => handleDismiss(c.id)}
        />
      ))}

      {lowConf.length > 0 && (
        <>
          {showLow && lowConf.map((c) => (
            <Pill
              key={c.id}
              candidate={c}
              tone="secondary"
              onPromote={() => handlePromote(c.id)}
              onDismiss={() => handleDismiss(c.id)}
            />
          ))}
          <button
            onClick={() => setShowLow((v) => !v)}
            style={{
              background: "none", border: "none",
              cursor: "pointer", color: "var(--gooni-muted, #8E8E93)",
              fontSize: 11, padding: "4px 0", fontFamily: FONT,
            }}
          >
            {showLow ? `− hide ${lowConf.length} low-conf` : `+ ${lowConf.length} more`}
          </button>
        </>
      )}
    </div>
  );
}

function Pill({ candidate, tone, onPromote, onDismiss }: {
  candidate: ApiFocusCandidate;
  tone: "primary" | "secondary";
  onPromote: () => void;
  onDismiss: () => void;
}) {
  const bg = tone === "primary" ? SYNTH_TINT : "var(--gooni-hover, rgba(0,0,0,0.04))";
  const titleColor = "var(--gooni-text, #1C1C1E)";
  const subColor = tone === "primary" ? SYNTH_PURPLE : "var(--gooni-muted, #8E8E93)";
  const evidenceCount = candidate.evidence?.length ?? 0;
  return (
    <div style={{
      background: bg, borderRadius: 8,
      padding: "8px 12px", marginBottom: 6,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 8,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12, fontWeight: 500, color: titleColor,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {candidate.name}
        </div>
        <div style={{ fontSize: 11, color: subColor }}>
          {evidenceCount} signal{evidenceCount === 1 ? "" : "s"}
          {" · "}
          {(candidate.confidence * 100).toFixed(0)}% conf
          {candidate.seen_count > 1 ? ` · seen ${candidate.seen_count}×` : ""}
        </div>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <ActionBtn icon={<Check size={11} />} tone={tone} onClick={onPromote} title="Promote" />
        <ActionBtn icon={<X size={11} />} tone={tone} onClick={onDismiss} title="Dismiss" />
      </div>
    </div>
  );
}

function ActionBtn({ icon, tone, onClick, title }: {
  icon: React.ReactNode; tone: "primary" | "secondary"; onClick: () => void; title: string;
}) {
  const borderColor = tone === "primary" ? SYNTH_BORDER : "var(--gooni-border, rgba(0,0,0,0.10))";
  const color = tone === "primary" ? SYNTH_PURPLE : "var(--gooni-text, #1C1C1E)";
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 22, height: 22, borderRadius: 6,
        background: "var(--gooni-card, #fff)",
        border: `0.5px solid ${borderColor}`,
        color, cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 0,
      }}
    >
      {icon}
    </button>
  );
}
