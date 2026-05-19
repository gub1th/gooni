import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { fetchNotesGraph, type GraphNode, type GraphEdge } from "../services/api";
import { useSpacesStore } from "../stores/useSpacesStore";

// Full-screen modal version of the semantic graph. Rendered as a portal-ish
// fixed overlay on top of the dashboard. Close via ×, backdrop click, or Esc.
// Click a node → closes modal and navigates to that note.

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  // Timestamp of the most recent auto-flash. Used to compute a fading
  // green-glow intensity each frame — makes the graph feel alive.
  lastFlash: number;
}

function buildSimNodes(nodes: GraphNode[], width: number, height: number): SimNode[] {
  return nodes.map((n, i) => {
    const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
    const r = 80 + Math.random() * 40;
    return {
      ...n,
      x: width / 2 + Math.cos(angle) * r,
      y: height / 2 + Math.sin(angle) * r,
      vx: 0, vy: 0,
      radius: 3 + n.size * 2.2,
      lastFlash: -Infinity,
    };
  });
}

// Lerp a dark node color toward the accent green for flash intensity `t`
// in [0, 1]. Written inline so the render loop doesn't allocate.
function flashColor(t: number): string {
  // Dark base: #1C1C1E = (28, 28, 30). Accent: #4ADE80 = (74, 222, 128).
  const r = Math.round(28 + (74 - 28) * t);
  const g = Math.round(28 + (222 - 28) * t);
  const b = Math.round(30 + (128 - 30) * t);
  return `rgb(${r},${g},${b})`;
}

function step(
  nodes: SimNode[],
  edges: GraphEdge[],
  nodeIndex: Map<number, SimNode>,
  width: number,
  height: number,
) {
  const REPULSION = 2800;
  const SPRING_K = 0.015;
  const IDEAL_EDGE_LEN = 110;
  const CENTER_K = 0.0015;
  const DAMPING = 0.82;
  const MAX_SPEED = 12;

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
      a.vx += (dx / dist) * f;
      a.vy += (dy / dist) * f;
      b.vx -= (dx / dist) * f;
      b.vy -= (dy / dist) * f;
    }
  }
  for (const e of edges) {
    const a = nodeIndex.get(e.from);
    const b = nodeIndex.get(e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
    const displacement = dist - IDEAL_EDGE_LEN;
    const k = SPRING_K * (0.5 + e.weight);
    const f = displacement * k;
    a.vx += (dx / dist) * f;
    a.vy += (dy / dist) * f;
    b.vx -= (dx / dist) * f;
    b.vy -= (dy / dist) * f;
  }
  for (const n of nodes) {
    n.vx += (width / 2 - n.x) * CENTER_K;
    n.vy += (height / 2 - n.y) * CENTER_K;
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
    if (sp > MAX_SPEED) {
      n.vx *= MAX_SPEED / sp;
      n.vy *= MAX_SPEED / sp;
    }
    n.x += n.vx;
    n.y += n.vy;
  }
}

interface ExploreModalProps {
  open: boolean;
  onClose: () => void;
}

export function ExploreModal({ open, onClose }: ExploreModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<SimNode | null>(null);
  const navigate = useNavigate();
  const viewRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const dragState = useRef<{ startX: number; startY: number; tx: number; ty: number } | null>(null);

  // Load graph only when opened; keep between opens so you don't re-fetch
  // every time, but re-fetch if explicitly requested via state reset (future).
  useEffect(() => {
    if (!open || graph) return;
    fetchNotesGraph().then(setGraph).catch((e) => setErr(String(e)));
  }, [open, graph]);

  // Escape-to-close.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || !graph) return;
    const canvas = canvasRef.current;
    const panel = panelRef.current;
    if (!canvas || !panel) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Canvas sizes to the modal PANEL, not the window — so the graph stays
    // inside its own surface and the backdrop remains visible around it.
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

    const nodes = buildSimNodes(graph.nodes, panelW, panelH);
    const nodeIndex = new Map(nodes.map((n) => [n.id, n]));
    let hovered: SimNode | null = null;

    // Connected components via union-find. Used to label the biggest cluster
    // so the user has a stable anchor while the force sim drifts. Only the
    // largest one gets a label — adding more would clutter the canvas.
    const parent = new Map<number, number>();
    function find(x: number): number {
      let p = parent.get(x) ?? x;
      while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
      parent.set(x, p);
      return p;
    }
    for (const n of graph.nodes) parent.set(n.id, n.id);
    for (const e of graph.edges) {
      const ra = find(e.from), rb = find(e.to);
      if (ra !== rb) parent.set(ra, rb);
    }
    const groups = new Map<number, number[]>();
    for (const n of graph.nodes) {
      const r = find(n.id);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(n.id);
    }
    let largestIds: number[] = [];
    for (const ids of groups.values()) {
      if (ids.length > largestIds.length) largestIds = ids;
    }
    const clusterNodes: SimNode[] = largestIds.length >= 3
      ? largestIds.map((id) => nodeIndex.get(id)!).filter(Boolean)
      : [];
    // Cluster label = most-common space among its nodes. Fallback "cluster".
    let clusterLabel = "";
    if (clusterNodes.length) {
      const counts = new Map<number | "general" | null, number>();
      for (const n of clusterNodes) {
        const k: number | null = n.space_id;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      let bestKey: number | "general" | null = null;
      let bestCount = 0;
      for (const [k, c] of counts) {
        if (c > bestCount) { bestCount = c; bestKey = k; }
      }
      const spaces = useSpacesStore.getState().spaces;
      const sp = spaces.find((s) => s.id === (bestKey ?? "general"));
      clusterLabel = sp ? sp.name : "cluster";
    }

    // Pre-warm the force sim so the camera fit below sees the settled
    // layout, not the initial circle. 200 steps is enough for the typical
    // 30-200 node graph to spread out.
    for (let i = 0; i < 200; i++) {
      step(nodes, graph.edges, nodeIndex, panelW, panelH);
    }
    // Fit camera to bbox of all nodes — guarantees every note is visible
    // on open without the user having to zoom out manually.
    {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of nodes) {
        minX = Math.min(minX, n.x - n.radius);
        minY = Math.min(minY, n.y - n.radius);
        maxX = Math.max(maxX, n.x + n.radius);
        maxY = Math.max(maxY, n.y + n.radius);
      }
      const PAD = 70;
      const contentW = (maxX - minX) + PAD * 2;
      const contentH = (maxY - minY) + PAD * 2;
      // Clamp to [0.25, 1.6] — same range as wheel zoom keeps it sane.
      const fitScale = Math.max(0.25, Math.min(1.6, Math.min(panelW / contentW, panelH / contentH)));
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      viewRef.current = {
        scale: fitScale,
        tx: panelW / 2 - cx * fitScale,
        ty: panelH / 2 - cy * fitScale,
      };
    }

    // Random periodic flashes — every ~900ms, pick a node and stamp its
    // lastFlash. Multiple flashes can overlap since the 500ms fade is
    // shorter than the 900ms pick cadence; gives the graph a "neurons
    // firing" feel. Cleared on unmount.
    const FLASH_DURATION_MS = 520;
    const flashInterval = setInterval(() => {
      if (!nodes.length) return;
      const n = nodes[Math.floor(Math.random() * nodes.length)];
      n.lastFlash = performance.now();
    }, 900);

    // Convert a pointer event's clientX/Y to canvas-local coords (since the
    // canvas is no longer at (0,0) — it lives inside the centered modal panel).
    function toCanvasCoords(clientX: number, clientY: number) {
      const rect = canvas!.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    }
    function toWorld(cx: number, cy: number) {
      const v = viewRef.current;
      return { x: (cx - v.tx) / v.scale, y: (cy - v.ty) / v.scale };
    }
    function hitTest(clientX: number, clientY: number): SimNode | null {
      const c = toCanvasCoords(clientX, clientY);
      const w = toWorld(c.x, c.y);
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const dx = n.x - w.x;
        const dy = n.y - w.y;
        const r = Math.max(6, n.radius + 3);
        if (dx * dx + dy * dy <= r * r) return n;
      }
      return null;
    }

    function onMove(e: PointerEvent) {
      if (dragState.current) {
        const v = viewRef.current;
        v.tx = dragState.current.tx + (e.clientX - dragState.current.startX);
        v.ty = dragState.current.ty + (e.clientY - dragState.current.startY);
        return;
      }
      const h = hitTest(e.clientX, e.clientY);
      if (h !== hovered) {
        hovered = h;
        setHoveredNode(h);
        canvas!.style.cursor = h ? "pointer" : "grab";
      }
    }
    function onDown(e: PointerEvent) {
      const h = hitTest(e.clientX, e.clientY);
      if (h) {
        onClose();
        navigate({ to: "/", search: { note: h.id, conv: undefined, list: undefined , audit: undefined, segment: undefined, view: undefined} });
        return;
      }
      dragState.current = {
        startX: e.clientX, startY: e.clientY,
        tx: viewRef.current.tx, ty: viewRef.current.ty,
      };
      canvas!.style.cursor = "grabbing";
    }
    function onUp() {
      dragState.current = null;
      canvas!.style.cursor = hovered ? "pointer" : "grab";
    }
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const v = viewRef.current;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const newScale = Math.max(0.25, Math.min(3, v.scale * factor));
      const c = toCanvasCoords(e.clientX, e.clientY);
      const k = newScale / v.scale;
      // Zoom toward cursor — in canvas-local coords now.
      v.tx = c.x - (c.x - v.tx) * k;
      v.ty = c.y - (c.y - v.ty) * k;
      v.scale = newScale;
    }
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.style.cursor = "grab";

    let raf = 0;
    function frame() {
      step(nodes, graph!.edges, nodeIndex, panelW, panelH);

      ctx!.clearRect(0, 0, panelW, panelH);
      ctx!.fillStyle = "#FAFAFA";
      ctx!.fillRect(0, 0, panelW, panelH);

      const v = viewRef.current;
      const now = performance.now();
      ctx!.save();
      ctx!.translate(v.tx, v.ty);
      ctx!.scale(v.scale, v.scale);

      for (const e of graph!.edges) {
        const a = nodeIndex.get(e.from);
        const b = nodeIndex.get(e.to);
        if (!a || !b) continue;
        ctx!.strokeStyle = `rgba(28,28,30,${0.08 + (e.weight - 0.6) * 0.5})`;
        ctx!.lineWidth = 0.6 + (e.weight - 0.6) * 2.2;
        ctx!.beginPath();
        ctx!.moveTo(a.x, a.y);
        ctx!.lineTo(b.x, b.y);
        ctx!.stroke();
      }
      for (const n of nodes) {
        const isHover = hovered === n;
        // Flash intensity decays from 1 → 0 over FLASH_DURATION_MS after
        // lastFlash. Hover always reads as full intensity so a manual
        // hover never gets washed out by an expiring flash.
        const flashAge = now - n.lastFlash;
        const flashT = Math.max(0, 1 - flashAge / FLASH_DURATION_MS);
        const intensity = isHover ? 1 : flashT;

        if (intensity > 0) {
          ctx!.fillStyle = flashColor(intensity);
        } else {
          ctx!.fillStyle = "#1C1C1E";
        }
        ctx!.beginPath();
        ctx!.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
        ctx!.fill();

        // Soft halo — scales with intensity so hovers and flashes both glow.
        if (intensity > 0.05) {
          ctx!.strokeStyle = `rgba(74,222,128,${0.45 * intensity})`;
          ctx!.lineWidth = 2 / v.scale;
          ctx!.beginPath();
          ctx!.arc(n.x, n.y, n.radius + (4 + 3 * intensity) / v.scale, 0, Math.PI * 2);
          ctx!.stroke();
        }
      }
      ctx!.restore();

      // Persistent label for the largest cluster. Anchored above the cluster
      // bbox in screen space so it floats with the sim but stays clear of
      // the nodes themselves (sits ~22px above the topmost node).
      if (clusterNodes.length && clusterLabel) {
        let cMinX = Infinity, cMaxX = -Infinity, cMinY = Infinity;
        for (const n of clusterNodes) {
          if (n.x < cMinX) cMinX = n.x;
          if (n.x > cMaxX) cMaxX = n.x;
          if (n.y - n.radius < cMinY) cMinY = n.y - n.radius;
        }
        const labelX = ((cMinX + cMaxX) / 2) * v.scale + v.tx;
        const labelY = cMinY * v.scale + v.ty - 22;
        ctx!.font = `700 11px ${FONT}`;
        ctx!.textAlign = "center";
        ctx!.textBaseline = "middle";
        ctx!.fillStyle = "rgba(28,28,30,0.32)";
        ctx!.fillText(clusterLabel.toUpperCase(), labelX, labelY);
        // Reset to defaults so the hover label below isn't affected.
        ctx!.textAlign = "start";
        ctx!.textBaseline = "alphabetic";
      }

      if (hovered) {
        const sx = hovered.x * v.scale + v.tx;
        const sy = hovered.y * v.scale + v.ty;
        const label = hovered.title;
        ctx!.font = `600 13px ${FONT}`;
        const metrics = ctx!.measureText(label);
        const padX = 8;
        const boxW = metrics.width + padX * 2;
        const boxH = 22;
        const boxX = sx - boxW / 2;
        const boxY = sy + hovered.radius + 10;
        ctx!.fillStyle = "#1C1C1E";
        ctx!.beginPath();
        const radius = 6;
        ctx!.moveTo(boxX + radius, boxY);
        ctx!.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + boxH, radius);
        ctx!.arcTo(boxX + boxW, boxY + boxH, boxX, boxY + boxH, radius);
        ctx!.arcTo(boxX, boxY + boxH, boxX, boxY, radius);
        ctx!.arcTo(boxX, boxY, boxX + boxW, boxY, radius);
        ctx!.closePath();
        ctx!.fill();
        ctx!.fillStyle = "#fff";
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
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [open, graph, navigate, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 300,
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "blur(2px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 40,
        fontFamily: FONT, color: "#1C1C1E",
      }}
    >
      {/* Centered modal panel — backdrop stays visible around it so you can
          see the dashboard behind, click it to close. */}
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          width: "min(1100px, 95vw)",
          height: "min(720px, 88vh)",
          background: "#FAFAFA",
          borderRadius: 14,
          border: "0.5px solid rgba(0,0,0,0.12)",
          boxShadow: "0 24px 72px rgba(0,0,0,0.25)",
          overflow: "hidden",
        }}
      >
        <canvas ref={canvasRef} style={{ display: "block" }} />

        {/* Header inside the panel */}
        <div style={{
          position: "absolute", top: 14, left: 16, right: 16,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          pointerEvents: "none",
        }}>
          <div style={{
            fontSize: 12, color: "#8E8E93",
            background: "rgba(255,255,255,0.85)", border: "0.5px solid rgba(0,0,0,0.08)",
            padding: "5px 11px", borderRadius: 8, letterSpacing: 0.2,
            fontWeight: 600, textTransform: "uppercase",
          }}>
            Notes map
          </div>
          <div style={{ display: "flex", gap: 8, pointerEvents: "auto" }}>
            <div style={{
              fontSize: 12, color: "#8E8E93",
              background: "rgba(255,255,255,0.85)", border: "0.5px solid rgba(0,0,0,0.08)",
              padding: "5px 11px", borderRadius: 8, letterSpacing: 0.2,
            }}>
              {graph ? `${graph.nodes.length} notes · ${graph.edges.length} links` : "loading…"}
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              title="Close (Esc)"
              style={{
                width: 28, height: 28, borderRadius: 8,
                border: "0.5px solid rgba(0,0,0,0.08)",
                background: "rgba(255,255,255,0.85)",
                color: "#6B6B70", fontSize: 16, lineHeight: 1,
                cursor: "pointer", fontFamily: FONT,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >×</button>
          </div>
        </div>

        {!graph && !err && <BrainLoadingOverlay />}
        {err && (
          <div style={{
            position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            fontSize: 13, color: "#C44",
          }}>Couldn't load graph: {err}</div>
        )}
        {graph && graph.nodes.length === 0 && (
          <div style={{
            position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            fontSize: 14, color: "#8E8E93", textAlign: "center", maxWidth: 320,
          }}>
            No notes with embeddings yet. Open a note and let it save — Gooni
            embeds on blur and the graph fills in.
          </div>
        )}

        <div style={{
          position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)",
          fontSize: 11, color: "#AEAEB2",
          background: "rgba(255,255,255,0.85)", border: "0.5px solid rgba(0,0,0,0.08)",
          padding: "4px 11px", borderRadius: 8, letterSpacing: 0.2,
        }}>
          drag · scroll to zoom · click a node to open · esc to close
        </div>

        {/* Suppress unused-var warning for hoveredNode (re-renders for cursor). */}
        <span style={{ display: "none" }}>{hoveredNode?.id ?? ""}</span>
      </div>
    </div>
  );
}

// Loading overlay — pulsing constellation of dots with connecting lines that
// chase. Sits at center while the graph payload loads. Pure CSS keyframes,
// no canvas, so it doesn't conflict with the real canvas mount below.
function BrainLoadingOverlay() {
  // 6 dots arranged in a hex around the center. Each dot pulses on a stagger.
  const dots = Array.from({ length: 6 }).map((_, i) => {
    const angle = (i / 6) * Math.PI * 2;
    return {
      x: Math.cos(angle) * 32,
      y: Math.sin(angle) * 32,
      delay: (i * 120),
    };
  });
  return (
    <div style={{
      position: "absolute", inset: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      flexDirection: "column", gap: 22, pointerEvents: "none",
    }}>
      <style>{`
        @keyframes gooni-brain-pulse {
          0%, 100% { transform: scale(1); opacity: 0.55; }
          50%      { transform: scale(1.6); opacity: 1; }
        }
        @keyframes gooni-brain-orbit {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes gooni-brain-line {
          0%   { stroke-dashoffset: 200; opacity: 0.15; }
          50%  { opacity: 0.45; }
          100% { stroke-dashoffset: 0;   opacity: 0.15; }
        }
      `}</style>
      <div style={{
        position: "relative", width: 96, height: 96,
        animation: "gooni-brain-orbit 14s linear infinite",
      }}>
        <svg viewBox="-50 -50 100 100" width="100%" height="100%" style={{ overflow: "visible" }}>
          {dots.map((d, i) => {
            const next = dots[(i + 1) % dots.length];
            return (
              <line
                key={`l${i}`}
                x1={d.x} y1={d.y} x2={next.x} y2={next.y}
                stroke="#1C1C1E" strokeWidth="0.6"
                strokeDasharray="200" strokeDashoffset="200"
                style={{
                  animation: `gooni-brain-line 2.4s ease-in-out ${d.delay}ms infinite`,
                }}
              />
            );
          })}
          {dots.map((d, i) => (
            <circle
              key={`c${i}`}
              cx={d.x} cy={d.y} r={3}
              fill="#1C1C1E"
              style={{
                transformOrigin: `${d.x}px ${d.y}px`,
                animation: `gooni-brain-pulse 1.6s ease-in-out ${d.delay}ms infinite`,
              }}
            />
          ))}
          {/* Center "core" dot — slower pulse, brand green */}
          <circle cx={0} cy={0} r={4} fill="#30A14E"
            style={{ transformOrigin: "center", animation: "gooni-brain-pulse 2.2s ease-in-out infinite" }} />
        </svg>
      </div>
      <div style={{ fontSize: 12, color: "#8E8E93", letterSpacing: 0.5, textTransform: "uppercase", fontWeight: 600 }}>
        wiring up your brain
      </div>
    </div>
  );
}
