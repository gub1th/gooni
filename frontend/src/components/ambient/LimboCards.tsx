import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { FONT, z } from "../../ui";
import { TracedOutline } from "./TracedOutline";
import { GREEN } from "./wavePath";
import type { LogMessage, SignalPreviewSignal } from "../../services/api";

// Slice 2 — "limbo" items surfaced over the mark. A limbo item is a message
// the extractor flagged as commitment-shaped and still pending. Each surfaces
// as a traced green outline (the line reshaping into a card) in the top-center,
// quick to kill: Promise or Dismiss. Capped so a busy log can't wallpaper the
// calm home. Nothing pending → renders null.

const MAX_CARDS = 3;

function cadenceLabel(s: SignalPreviewSignal): string | null {
  switch (s.cadence) {
    case "daily": return "daily";
    case "n_per_week": return `${s.cadence_target ?? "?"}x/wk`;
    case "permanent_do": return "always";
    case "permanent_never": return "never";
    default: return null;
  }
}

export function LimboCards({
  items,
  onPromote,
  onDismiss,
}: {
  items: LogMessage[];
  onPromote: (m: LogMessage) => void;
  onDismiss: (m: LogMessage) => void;
}) {
  const shown = items.slice(0, MAX_CARDS);
  const overflow = items.length - shown.length;

  return (
    <div
      style={{
        position: "fixed", top: 24, left: "50%", transform: "translateX(-50%)",
        zIndex: z.overlay, display: "flex", flexDirection: "column", gap: 10,
        width: "min(440px, 92vw)", fontFamily: FONT, pointerEvents: "none",
      }}
    >
      {shown.map((m) => (
        <LimboCard key={m.id} message={m} onPromote={() => onPromote(m)} onDismiss={() => onDismiss(m)} />
      ))}
      {overflow > 0 && (
        <div style={{
          textAlign: "center", fontSize: 11, color: "rgba(244,245,244,0.4)",
          letterSpacing: 0.3, pointerEvents: "none",
        }}>
          +{overflow} more waiting
        </div>
      )}
    </div>
  );
}

function LimboCard({
  message: m,
  onPromote,
  onDismiss,
}: {
  message: LogMessage;
  onPromote: () => void;
  onDismiss: () => void;
}) {
  // trace the outline on the frame after mount so the draw-on runs
  const [show, setShow] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(r);
  }, []);

  const signals = m.signal_preview?.signals ?? [];
  const primary = signals[0];

  return (
    <TracedOutline
      show={show}
      radius={14}
      color={GREEN}
      strokeWidth={1.25}
      glow={0.35}
      style={{ pointerEvents: "auto" }}
    >
      <div
        style={{
          padding: "12px 14px", borderRadius: 14, color: "#F4F5F4",
          background: "color-mix(in srgb, #0b0f0d 58%, transparent)",
          backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <span aria-hidden style={{
            width: 7, height: 7, borderRadius: 999, marginTop: 5, flexShrink: 0,
            background: GREEN, boxShadow: `0 0 7px 1px ${GREEN}`,
          }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>
              {primary?.summary || primary?.utterance || m.content}
            </div>
            <div style={{
              display: "flex", gap: 8, marginTop: 5, flexWrap: "wrap",
              fontSize: 11, color: "rgba(244,245,244,0.55)",
            }}>
              {primary && cadenceLabel(primary) && (
                <span style={{
                  fontWeight: 600, padding: "1px 7px", borderRadius: 999,
                  background: "rgba(74,222,128,0.14)", color: GREEN,
                }}>
                  {cadenceLabel(primary)}
                </span>
              )}
              {primary && (primary.due_date || primary.due_hint) && (
                <span>due {primary.due_date || primary.due_hint}</span>
              )}
              {primary?.is_important && <span style={{ color: "#FBBF24", fontWeight: 600 }}>important</span>}
              {signals.length > 1 && <span>+{signals.length - 1} more</span>}
            </div>
          </div>
          <button
            onClick={onDismiss} title="Dismiss" aria-label="Dismiss"
            style={{ border: "none", background: "transparent", cursor: "pointer", color: "rgba(244,245,244,0.5)", padding: 2, flexShrink: 0 }}
          >
            <X size={14} strokeWidth={2.2} />
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 11 }}>
          <button
            onClick={onPromote}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              fontSize: 12, fontWeight: 700, padding: "6px 14px", borderRadius: 9,
              cursor: "pointer", border: "none", background: GREEN, color: "#06120a",
            }}
          >
            <Check size={13} strokeWidth={2.6} />
            Promise
          </button>
          <button
            onClick={onDismiss}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              fontSize: 12, fontWeight: 600, padding: "6px 14px", borderRadius: 9,
              cursor: "pointer", border: "1px solid rgba(244,245,244,0.18)",
              background: "transparent", color: "rgba(244,245,244,0.75)",
            }}
          >
            Dismiss
          </button>
        </div>
      </div>
    </TracedOutline>
  );
}
