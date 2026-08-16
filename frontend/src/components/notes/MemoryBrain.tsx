import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ApiMemory } from "../../services/api";
import { NeuralBrain } from "../animations/NeuralBrain";
import { frostInk as ctok, FONT } from "../../ui";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";


interface MemoryBrainProps {
  memories: ApiMemory[];
  // Section header. Defaults to the per-note framing; override on the
  // /memories route where the brain shows everything Gooni remembers.
  title?: string;
  subtitle?: string;
  // The full set the graph MODAL expands into on brain click — the inline
  // strip stays capped (readability), the modal doesn't have to be. Falls
  // back to `memories` when the caller has nothing wider to offer.
  allMemories?: ApiMemory[];
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
  allMemories,
}: MemoryBrainProps) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<ApiMemory | null>(null);
  const [graphOpen, setGraphOpen] = useState(false);
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
  // NeuralBrain's rendered button is NOT square at this `size` — its own
  // wrap is 64x72 (a bit taller than wide) scaled by size/64, plus 12px of
  // button padding. The wrapper below used to be a plain BRAIN_SIZE² box,
  // shorter than the button it centers — so the button clipped against this
  // stage's `overflow: hidden` at the bottom. Sizing the wrapper to the
  // button's real footprint is what stops that.
  const brainOuterW = BRAIN_SIZE + 12;
  const brainOuterH = BRAIN_SIZE * 1.125 + 12;

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
          width: brainOuterW, height: brainOuterH,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <NeuralBrain size={BRAIN_SIZE} onClick={() => setGraphOpen(true)} />
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

      {graphOpen && (
        <MemoryGraphModal
          memories={allMemories ?? memories}
          onClose={() => setGraphOpen(false)}
          navigate={navigate}
        />
      )}
    </div>
  );
}

// ── Force-directed graph (restored) ─────────────────────────────────────────
// The full-screen graph used to be the same fan layout blown up — this brings
// back the earlier force-directed sim (custom physics, no library — mirrors
// the pre-v2-nuke `ExploreModal.tsx` notes graph, which ran the identical
// repel/spring/damping loop over notes instead of memories). Nodes are typed
// by memory kind (color = PALETTE, shared with the inline bubbles + the
// /memories table so a "goal" reads the same color everywhere); edges connect
// memories that are actually related given what `/memories` already returns
// (no API change): a supersession chain, memories extracted from the same
// note, and memories sharing a recall `key`. Nodes drift toward a per-TYPE
// anchor point arranged in a ring, which is what produces the type clustering
// — the sim still free-floats within a cluster so it doesn't look like a pie
// chart. Gooni (NeuralBrain) sits fixed at the canvas center as the anchor
// the whole graph orbits.

interface GraphEdge {
  from: number;
  to: number;
  weight: number; // 0..1, drives both spring strength and line opacity
}

interface SimNode {
  memory: ApiMemory;
  x: number; y: number;
  vx: number; vy: number;
  radius: number;
  anchorX: number; anchorY: number; // per-type cluster target
  lastFlash: number;
}

// Real relations only, derived from fields `/memories` already returns:
// supersession (a memory that replaced another), co-extraction (same source
// note), and shared recall slot (same `key`). No embeddings, no guessing.
function buildMemoryEdges(memories: ApiMemory[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const ids = new Set(memories.map((m) => m.id));

  for (const m of memories) {
    if (m.superseded_by != null && ids.has(m.superseded_by)) {
      edges.push({ from: m.id, to: m.superseded_by, weight: 0.95 });
    }
  }

  function starEdges(groupBy: (m: ApiMemory) => string | number | null, weight: number) {
    const groups = new Map<string | number, ApiMemory[]>();
    for (const m of memories) {
      const k = groupBy(m);
      if (k == null) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(m);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const [head, ...rest] = group;
      for (const g of rest) edges.push({ from: head.id, to: g.id, weight });
    }
  }
  starEdges((m) => m.source_note_id, 0.35);
  starEdges((m) => m.key, 0.5);

  return edges;
}

function buildSimNodes(memories: ApiMemory[], width: number, height: number): SimNode[] {
  const types = Array.from(new Set(memories.map((m) => m.type)));
  const ringR = Math.min(width, height) * 0.32;
  const cx = width / 2;
  const cy = height / 2;
  const anchorFor = new Map<string, { x: number; y: number }>();
  types.forEach((t, i) => {
    const angle = (i / Math.max(1, types.length)) * Math.PI * 2 - Math.PI / 2;
    anchorFor.set(t, { x: cx + Math.cos(angle) * ringR, y: cy + Math.sin(angle) * ringR });
  });
  return memories.map((m) => {
    const anchor = anchorFor.get(m.type) ?? { x: cx, y: cy };
    const jitter = 30;
    return {
      memory: m,
      x: anchor.x + (Math.random() - 0.5) * jitter,
      y: anchor.y + (Math.random() - 0.5) * jitter,
      vx: 0, vy: 0,
      radius: 4 + m.confidence * 5,
      anchorX: anchor.x, anchorY: anchor.y,
      lastFlash: -Infinity,
    };
  });
}

function stepGraph(
  nodes: SimNode[],
  edges: GraphEdge[],
  nodeIndex: Map<number, SimNode>,
  width: number,
  height: number,
) {
  const REPULSION = 2200;
  const SPRING_K = 0.02;
  const IDEAL_EDGE_LEN = 70;
  const ANCHOR_K = 0.006; // pull toward this node's type cluster
  const BRAIN_REPEL_R = 70; // keep clear of the center Gooni
  const DAMPING = 0.82;
  const MAX_SPEED = 12;
  const cx = width / 2, cy = height / 2;

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 0.01) {
        dx = (Math.random() - 0.5) * 0.5;
        dy = (Math.random() - 0.5) * 0.5;
        distSq = dx * dx + dy * dy + 0.01;
      }
      const dist = Math.sqrt(distSq);
      const f = REPULSION / distSq;
      a.vx += (dx / dist) * f; a.vy += (dy / dist) * f;
      b.vx -= (dx / dist) * f; b.vy -= (dy / dist) * f;
    }
  }
  for (const e of edges) {
    const a = nodeIndex.get(e.from);
    const b = nodeIndex.get(e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
    const f = (dist - IDEAL_EDGE_LEN) * SPRING_K * (0.5 + e.weight);
    a.vx += (dx / dist) * f; a.vy += (dy / dist) * f;
    b.vx -= (dx / dist) * f; b.vy -= (dy / dist) * f;
  }
  for (const n of nodes) {
    n.vx += (n.anchorX - n.x) * ANCHOR_K;
    n.vy += (n.anchorY - n.y) * ANCHOR_K;
    // Soft repel from the center Gooni so nodes don't sit on top of it.
    const dx = n.x - cx, dy = n.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
    if (dist < BRAIN_REPEL_R) {
      const f = (BRAIN_REPEL_R - dist) * 0.4;
      n.vx += (dx / dist) * f; n.vy += (dy / dist) * f;
    }
    n.vx *= DAMPING; n.vy *= DAMPING;
    const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
    if (sp > MAX_SPEED) { n.vx *= MAX_SPEED / sp; n.vy *= MAX_SPEED / sp; }
    n.x += n.vx; n.y += n.vy;
  }
}

// Full-screen graph view, opened by clicking the brain — a force-directed
// sim over every memory rather than the inline strip's capped 12, with nodes
// clustered by type and edges for real relations (supersession / same note /
// same key). Restores a click affordance the brain button carried
// ("Visualize notes" title, an `onClick` prop it never received) that had
// gone dead: nothing wired it to anything.
function MemoryGraphModal({
  memories,
  onClose,
  navigate,
}: {
  memories: ApiMemory[];
  onClose: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [selected, setSelected] = useState<ApiMemory | null>(null);
  const [hovered, setHovered] = useState<ApiMemory | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const theme = useGooniThemeStore((s) => s.theme);
  const edges = useMemo(() => buildMemoryEdges(memories), [memories]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const panel = panelRef.current;
    if (!canvas || !panel || memories.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let panelW = panel.clientWidth;
    let panelH = panel.clientHeight;
    function resize() {
      panelW = panel!.clientWidth;
      panelH = panel!.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = panelW * dpr;
      canvas!.height = panelH * dpr;
      canvas!.style.width = `${panelW}px`;
      canvas!.style.height = `${panelH}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(panel);

    const nodes = buildSimNodes(memories, panelW, panelH);
    const nodeIndex = new Map(nodes.map((n) => [n.memory.id, n]));
    let hoveredNode: SimNode | null = null;

    // Pre-warm so the graph opens already settled, not mid-explosion.
    for (let i = 0; i < 160; i++) stepGraph(nodes, edges, nodeIndex, panelW, panelH);

    // Random periodic flashes — same "neurons firing" feel as the notes graph.
    const FLASH_DURATION_MS = 520;
    const flashInterval = setInterval(() => {
      if (!nodes.length) return;
      nodes[Math.floor(Math.random() * nodes.length)].lastFlash = performance.now();
    }, 900);

    function toCanvasCoords(clientX: number, clientY: number) {
      const rect = canvas!.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    }
    function hitTest(clientX: number, clientY: number): SimNode | null {
      const c = toCanvasCoords(clientX, clientY);
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const dx = n.x - c.x, dy = n.y - c.y;
        const r = Math.max(7, n.radius + 4);
        if (dx * dx + dy * dy <= r * r) return n;
      }
      return null;
    }
    function onMove(e: PointerEvent) {
      const h = hitTest(e.clientX, e.clientY);
      if (h !== hoveredNode) {
        hoveredNode = h;
        setHovered(h?.memory ?? null);
        canvas!.style.cursor = h ? "pointer" : "default";
      }
    }
    function onDown(e: PointerEvent) {
      const h = hitTest(e.clientX, e.clientY);
      if (h) setSelected((prev) => (prev?.id === h.memory.id ? null : h.memory));
    }
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);

    const C = theme === "dark"
      ? { bg: "#0C0C0C", edgeRGB: "255,255,255", labelBg: "#E5E5E7", labelText: "#1C1C1E" }
      : { bg: "#f7f6f2", edgeRGB: "17,17,19", labelBg: "#1C1C1E", labelText: "#FFFFFF" };

    let raf = 0;
    function frame() {
      stepGraph(nodes, edges, nodeIndex, panelW, panelH);

      ctx!.clearRect(0, 0, panelW, panelH);
      ctx!.fillStyle = C.bg;
      ctx!.fillRect(0, 0, panelW, panelH);

      const now = performance.now();
      for (const e of edges) {
        const a = nodeIndex.get(e.from);
        const b = nodeIndex.get(e.to);
        if (!a || !b) continue;
        ctx!.strokeStyle = `rgba(${C.edgeRGB},${0.08 + e.weight * 0.22})`;
        ctx!.lineWidth = 0.6 + e.weight * 1.6;
        ctx!.beginPath();
        ctx!.moveTo(a.x, a.y);
        ctx!.lineTo(b.x, b.y);
        ctx!.stroke();
      }
      for (const n of nodes) {
        const isHover = hoveredNode === n;
        const flashAge = now - n.lastFlash;
        const flashT = Math.max(0, 1 - flashAge / FLASH_DURATION_MS);
        const intensity = isHover ? 1 : flashT;
        const palette = paletteFor(n.memory.type);

        ctx!.fillStyle = palette.accent;
        ctx!.beginPath();
        ctx!.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
        ctx!.fill();

        if (intensity > 0.05) {
          ctx!.strokeStyle = `rgba(74,222,128,${0.5 * intensity})`;
          ctx!.lineWidth = 2;
          ctx!.beginPath();
          ctx!.arc(n.x, n.y, n.radius + 4 + 3 * intensity, 0, Math.PI * 2);
          ctx!.stroke();
        }
      }

      if (hoveredNode) {
        const label = `${hoveredNode.memory.type} · ${hoveredNode.memory.content.slice(0, 48)}${hoveredNode.memory.content.length > 48 ? "…" : ""}`;
        ctx!.font = `600 12px ${FONT}`;
        const metrics = ctx!.measureText(label);
        const padX = 8;
        const boxW = metrics.width + padX * 2;
        const boxH = 22;
        const boxX = hoveredNode.x - boxW / 2;
        const boxY = hoveredNode.y + hoveredNode.radius + 10;
        ctx!.fillStyle = C.labelBg;
        ctx!.beginPath();
        const r = 6;
        ctx!.moveTo(boxX + r, boxY);
        ctx!.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + boxH, r);
        ctx!.arcTo(boxX + boxW, boxY + boxH, boxX, boxY + boxH, r);
        ctx!.arcTo(boxX, boxY + boxH, boxX, boxY, r);
        ctx!.arcTo(boxX, boxY, boxX + boxW, boxY, r);
        ctx!.closePath();
        ctx!.fill();
        ctx!.fillStyle = C.labelText;
        ctx!.textBaseline = "middle";
        ctx!.fillText(label, boxX + padX, boxY + boxH / 2 + 0.5);
      }

      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(flashInterval);
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
    };
  }, [memories, edges, theme]);

  const BRAIN_SIZE = 64;
  const brainOuterW = BRAIN_SIZE + 12;
  const brainOuterH = BRAIN_SIZE * 1.125 + 12;

  return (
    <div
      role="dialog"
      aria-label="Memory graph"
      style={{
        position: "fixed", inset: 0, zIndex: 200,
        background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: FONT,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          position: "relative",
          width: "min(94vw, 1040px)",
          height: "min(88vh, 680px)",
          background: ctok.card,
          border: `1px solid ${ctok.hairline}`,
          borderRadius: 16,
          overflow: "hidden",
          display: "flex", flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", zIndex: 2 }}>
          <div>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: ctok.text }}>memory graph</p>
            <p style={{ margin: "2px 0 0", fontSize: 11.5, color: ctok.muted }}>
              {memories.length} memor{memories.length === 1 ? "y" : "ies"} · {edges.length} link{edges.length === 1 ? "" : "s"} · click a node to peek
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: ctok.muted, fontSize: 20, lineHeight: 1, padding: 4,
            }}
          >×</button>
        </div>

        <div ref={panelRef} style={{ position: "relative", flex: 1, minHeight: 0 }}>
          <canvas ref={canvasRef} style={{ display: "block", position: "absolute", inset: 0 }} />

          {/* Gooni, fixed at the canvas center — everything else orbits it. */}
          <div style={{
            position: "absolute", left: "50%", top: "50%",
            transform: "translate(-50%, -50%)",
            width: brainOuterW, height: brainOuterH,
            display: "flex", alignItems: "center", justifyContent: "center",
            pointerEvents: "none",
          }}>
            <NeuralBrain size={BRAIN_SIZE} />
          </div>

          {memories.length === 0 && (
            <div style={{
              position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
              fontSize: 13, color: ctok.muted,
            }}>No memories yet.</div>
          )}

          {selected && (
            <div
              style={{
                position: "absolute", left: "50%", bottom: 20, transform: "translateX(-50%)",
                width: 320, maxWidth: "90%", background: ctok.sheet,
                borderRadius: 12, border: `1px solid ${ctok.hairline}`,
                padding: "12px 14px", zIndex: 5,
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
                  style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: ctok.muted, fontSize: 16, lineHeight: 1, padding: 2 }}
                  aria-label="Close peek"
                >×</button>
              </div>
              <div style={{ fontSize: 13, color: ctok.text, lineHeight: 1.5, marginBottom: 10 }}>
                {selected.content}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 10.5, color: ctok.muted }}>conf {Math.round(selected.confidence * 100)}%</div>
                <button
                  onClick={() => {
                    onClose();
                    navigate({ to: "/", search: { view: "memories", focus: selected.id } });
                  }}
                  style={{
                    fontSize: 11.5, fontWeight: 600, fontFamily: FONT,
                    padding: "5px 12px", borderRadius: 999,
                    background: ctok.text, color: ctok.card, border: "none", cursor: "pointer",
                  }}
                >
                  view memory →
                </button>
              </div>
            </div>
          )}

          {/* Suppress unused-var warning for `hovered` (re-renders for cursor + tooltip). */}
          <span style={{ display: "none" }}>{hovered?.id ?? ""}</span>
        </div>
      </div>
    </div>
  );
}
