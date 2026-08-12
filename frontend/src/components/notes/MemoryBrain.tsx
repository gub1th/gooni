import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ApiMemory } from "../../services/api";
import { NeuralBrain } from "../animations/NeuralBrain";
import { frostInk as ctok, FONT } from "../../ui";


interface MemoryBrainProps {
  memories: ApiMemory[];
  // Section header. Defaults to the per-note framing; override on the
  // /memories route where the brain shows everything Gooni remembers.
  title?: string;
  subtitle?: string;
}

interface BubblePos {
  // Polar coordinates from the brain center, then resolved to (x,y) on layout.
  // Each memory gets a stable angle + radius so the layout doesn't reshuffle
  // on re-render. Float offset is animation-only — applied via CSS variable.
  angle: number;
  radius: number;
  driftPhase: number;  // seconds offset so bubbles don't all bob in sync
}

// Per-type identity hues. The type is meaning, so the colour stays — what
// changed is the FORM: these were pastel PLATES (`#FAF5FF` fills with dark ink
// on them), drawn for a white page, and on the void every bubble read as a small
// white pill. Now it is the bright hue as text over a 14% tint of itself, which
// is the same shape `frostInk.accent`/`accentDim` uses and the only one that
// works unchanged in both themes.
//
// The hues are deliberately the SAME as `MemoriesView`'s `TYPE_COLORS`: the
// bubbles and the table rows they mirror sit on one surface, and they used to
// disagree about what colour a `goal` is.
const PALETTE: Record<string, { bg: string; fg: string; border: string; accent: string }> = {
  preference: { bg: "rgba(74,222,128,0.14)",  fg: "#4ADE80", border: "rgba(74,222,128,0.30)",  accent: "#4ADE80" },
  goal:       { bg: "rgba(167,139,250,0.16)", fg: "#A78BFA", border: "rgba(167,139,250,0.32)", accent: "#A78BFA" },
  fact:       { bg: "rgba(96,165,250,0.16)",  fg: "#60A5FA", border: "rgba(96,165,250,0.32)",  accent: "#60A5FA" },
  routine:    { bg: "rgba(251,146,60,0.15)",  fg: "#FB923C", border: "rgba(251,146,60,0.32)",  accent: "#FB923C" },
  constraint: { bg: "rgba(248,113,113,0.15)", fg: "#F87171", border: "rgba(248,113,113,0.32)", accent: "#F87171" },
  episode:    { bg: "rgba(156,163,175,0.16)", fg: "#9CA3AF", border: "rgba(156,163,175,0.32)", accent: "#9CA3AF" },
  default:    { bg: "rgba(156,163,175,0.14)", fg: "#9CA3AF", border: "rgba(156,163,175,0.28)", accent: "#9CA3AF" },
};

function paletteFor(type: string) {
  return PALETTE[type] ?? PALETTE.default;
}

// Place bubbles on a half-fan above the brain. Even angle spread, alternating
// radius so adjacent bubbles don't overlap. Stable per memory id (no shuffle
// across renders).
function computeLayout(memories: ApiMemory[]): Map<number, BubblePos> {
  const map = new Map<number, BubblePos>();
  const count = memories.length;
  if (count === 0) return map;
  // Spread across the upper half-circle: -150° to -30° (top arc).
  const startDeg = -150;
  const endDeg = -30;
  memories.forEach((m, i) => {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const angleDeg = startDeg + (endDeg - startDeg) * t;
    const angle = (angleDeg * Math.PI) / 180;
    // Alternate radius for staggered look — odd-indexed bubbles slightly farther.
    // Tightened (was 110/138) so the bubble cluster sits closer to the brain
    // and the section header doesn't have a giant air-gap above the animation.
    const radius = i % 2 === 0 ? 78 : 100;
    const driftPhase = (i * 0.7) % 4;
    map.set(m.id, { angle, radius, driftPhase });
  });
  return map;
}

export function MemoryBrain({
  memories,
  title = "memories from this note",
  subtitle = 'Click a bubble to peek. Click "view memory" to jump to the memory page.',
}: MemoryBrainProps) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<ApiMemory | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const layout = useMemo(() => computeLayout(memories), [memories]);

  // Close the popover on outside click + Escape
  useEffect(() => {
    if (!selected) return;
    function onDoc(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setSelected(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSelected(null);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [selected]);

  if (memories.length === 0) return null;

  const BRAIN_SIZE = 56;

  return (
    <div
      ref={containerRef}
      style={{
        marginTop: 24, paddingTop: 14,
        borderTop: "1px solid rgba(0,0,0,0.06)",
        position: "relative",
      }}
    >
      <style>{`
        @keyframes memory-bubble-drift {
          0%, 100% { transform: translate(-50%, -50%) translateY(0px); }
          50%      { transform: translate(-50%, -50%) translateY(-4px); }
        }
        @keyframes memory-line-pulse {
          0%, 100% { opacity: 0.30; }
          50%      { opacity: 0.55; }
        }
      `}</style>

      <p style={{
        fontSize: 11, fontWeight: 600, color: ctok.faint, letterSpacing: 0.6,
        margin: "0 0 6px", fontFamily: FONT, textTransform: "uppercase",
      }}>
        {title}
      </p>
      <p style={{
        fontSize: 11.5, color: ctok.muted, margin: "0 0 6px",
        fontFamily: FONT,
      }}>
        {subtitle}
      </p>

      {/* Stage: brain anchored bottom-center, bubbles float in a tight half-
          arc above. Stage height + cy tightened (was 240px stage / cy=200)
          so the cluster lives close to the section header instead of leaving
          a wall of empty space above the brain. */}
      <div style={{ position: "relative", height: 170, maxWidth: 720, margin: "0 auto", overflow: "hidden" }}>
        {/* SVG layer for the brain → bubble lines. Full-bleed; lines drawn
            in client coords relative to the SVG. */}
        <svg
          width="100%" height="100%"
          viewBox="0 0 720 170"
          preserveAspectRatio="xMidYMid meet"
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          {memories.map((m, i) => {
            const pos = layout.get(m.id);
            if (!pos) return null;
            const cx = 360;
            const cy = 132;
            const tx = cx + Math.cos(pos.angle) * pos.radius;
            const ty = cy + Math.sin(pos.angle) * pos.radius;
            const accent = paletteFor(m.type).accent;
            return (
              <line
                key={m.id}
                x1={cx}
                y1={cy}
                x2={tx}
                y2={ty}
                stroke={accent}
                strokeWidth={1}
                strokeDasharray="3 3"
                style={{
                  animation: `memory-line-pulse 3.2s ease-in-out infinite ${i * 0.25}s`,
                }}
              />
            );
          })}
        </svg>

        {/* Brain anchored bottom-center */}
        <div style={{
          position: "absolute",
          left: "50%",
          bottom: 6,
          transform: "translateX(-50%)",
          width: BRAIN_SIZE, height: BRAIN_SIZE,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <NeuralBrain size={BRAIN_SIZE} />
        </div>

        {/* Bubbles. Positioned absolute relative to the 720x170 stage, mapped
            from the same polar layout the SVG used. */}
        {memories.map((m) => {
          const pos = layout.get(m.id);
          if (!pos) return null;
          const cx = 360;
          const cy = 132;
          const tx = cx + Math.cos(pos.angle) * pos.radius;
          const ty = cy + Math.sin(pos.angle) * pos.radius;
          const palette = paletteFor(m.type);
          const isSelected = selected?.id === m.id;
          return (
            <button
              key={m.id}
              onClick={() => setSelected(isSelected ? null : m)}
              style={{
                position: "absolute",
                left: `${(tx / 720) * 100}%`,
                top: ty,
                transform: "translate(-50%, -50%)",
                animation: `memory-bubble-drift 3.6s ease-in-out infinite ${pos.driftPhase}s`,
                padding: "5px 11px",
                borderRadius: 999,
                background: palette.bg,
                color: palette.fg,
                border: `1px solid ${isSelected ? palette.accent : palette.border}`,
                boxShadow: isSelected ? `0 0 0 3px ${palette.accent}33` : "none",
                fontFamily: FONT, fontSize: 11.5, fontWeight: 500,
                cursor: "pointer",
                maxWidth: 220,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                display: "inline-flex", alignItems: "center", gap: 5,
                transition: "box-shadow 0.15s, border-color 0.15s",
              }}
              title={m.content}
            >
              <span style={{ fontSize: 9.5, opacity: 0.7, textTransform: "uppercase", letterSpacing: 0.4 }}>{m.type}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {m.content.length > 38 ? m.content.slice(0, 38) + "…" : m.content}
              </span>
            </button>
          );
        })}

        {/* Popover — positioned just above the brain, centered. Compact card
            with full content + a CTA to deep-link into /memories with that
            row's detail modal opened (handled by ?focus= query param). */}
        {selected && (
          <div
            style={{
              position: "absolute",
              left: "50%",
              bottom: BRAIN_SIZE + 24,
              transform: "translateX(-50%)",
              width: 320, maxWidth: "90%",
              background: ctok.card,
              borderRadius: 12,
              border: `1px solid ${ctok.hairline}`,
              boxShadow: "none",
              padding: "12px 14px",
              fontFamily: FONT,
              zIndex: 5,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                fontSize: 10, fontWeight: 600,
                color: paletteFor(selected.type).fg,
                background: paletteFor(selected.type).bg,
                border: `1px solid ${paletteFor(selected.type).border}`,
                padding: "2px 8px", borderRadius: 999,
                textTransform: "uppercase", letterSpacing: 0.4,
              }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: paletteFor(selected.type).accent }} />
                {selected.type}
              </span>
              <button
                onClick={() => setSelected(null)}
                style={{
                  marginLeft: "auto", background: "none", border: "none",
                  cursor: "pointer", color: ctok.muted, fontSize: 16, lineHeight: 1,
                  padding: 2,
                }}
                aria-label="Close"
              >×</button>
            </div>
            <div style={{ fontSize: 13, color: ctok.text, lineHeight: 1.5, marginBottom: 10 }}>
              {selected.content}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 10.5, color: ctok.muted }}>
                conf {Math.round(selected.confidence * 100)}%
              </div>
              <button
                onClick={() => {
                  setSelected(null);
                  // Memories page reads ?focus= and opens the detail modal.
                  navigate({ to: "/", search: { view: "memories", focus: selected.id } });
                }}
                style={{
                  fontSize: 11.5, fontWeight: 600, fontFamily: FONT,
                  padding: "5px 12px", borderRadius: 999,
                  background: ctok.text, color: ctok.card,
                  border: "none", cursor: "pointer",
                }}
              >
                view memory →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
