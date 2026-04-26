import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusesStore } from "../stores/useFocusesStore";
import type { ApiFocus, FocusStatus } from "../services/api";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";

const STATUS_COLORS: Record<FocusStatus, { bg: string; ring: string; fg: string }> = {
  committed: { bg: "rgba(74, 222, 128, 0.85)", ring: "#16A34A", fg: "#0B3D1A" },
  pending:   { bg: "rgba(250, 204, 21, 0.85)", ring: "#A16207", fg: "#3F2E0A" },
  someday:   { bg: "rgba(148, 163, 184, 0.85)", ring: "#475569", fg: "#1F2937" },
  done:      { bg: "rgba(99, 102, 241, 0.78)",  ring: "#4338CA", fg: "#1E1B4B" },
};

const STATUS_ORDER: FocusStatus[] = ["committed", "pending", "someday", "done"];

const CONTAINER_HEIGHT = 240;
const BUBBLE_MIN_R = 38;
const BUBBLE_MAX_R = 60;
const ADD_R = 28;
// Physics tuning. Drift is gentle so the bubbles read as "alive," not chaotic.
const DRIFT_ACCEL = 0.005;
const DAMPING = 0.985;
const BOUNCE_LOSS = 0.78;
const COLLISION_RESTITUTION = 0.82;

interface BubbleNode {
  id: string;          // string so the +add bubble can use a sentinel id
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  kind: "focus" | "add";
  focus?: ApiFocus;
}

// Physics-based floating focus bubbles. Each focus is a circle that drifts
// inside the container, collides with its neighbors and the walls, and gently
// rebalances. Click a bubble → opens an inline editor below the canvas. The
// "+" bubble adds a new focus.
export function FocusBubbles() {
  const { focuses, loaded, fetch, create, update, remove, heartbeat } = useFocusesStore();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editEndgoal, setEditEndgoal] = useState("");
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftEndgoal, setDraftEndgoal] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef<BubbleNode[]>([]);
  // Per-node DOM refs so the RAF loop sets transforms directly — no React
  // re-renders per frame.
  const nodeElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const rafIdRef = useRef<number>(0);

  useEffect(() => {
    if (!loaded) fetch();
  }, [loaded, fetch]);

  const visible = useMemo(() => focuses.filter((f) => f.status !== "done"), [focuses]);

  // Build nodes from current focuses + a synthetic "add" node. Re-runs only
  // when the visible-focus set changes (not on every render).
  useEffect(() => {
    const container = containerRef.current;
    const w = container?.clientWidth ?? 600;
    const h = CONTAINER_HEIGHT;

    // Try to preserve existing positions for focuses we already have so
    // status changes don't cause every bubble to teleport.
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));

    // Bubble radius scales mildly with focus age — older focuses read a
    // touch larger so the visual hierarchy isn't completely flat.
    const oldest = Math.max(
      1,
      ...visible.map((f) => f.last_activity_at ? new Date(f.last_activity_at).getTime() : Date.now()),
    );

    function focusRadius(f: ApiFocus): number {
      const last = f.last_activity_at ? new Date(f.last_activity_at).getTime() : Date.now();
      const ageDays = Math.max(0, (oldest - last) / (1000 * 60 * 60 * 24));
      // 0–30+ days → BUBBLE_MIN_R..BUBBLE_MAX_R
      const t = Math.min(1, ageDays / 30);
      return BUBBLE_MIN_R + (BUBBLE_MAX_R - BUBBLE_MIN_R) * t;
    }

    const next: BubbleNode[] = [];
    for (const f of visible) {
      const id = `f-${f.id}`;
      const existing = prev.get(id);
      const r = focusRadius(f);
      next.push(
        existing
          ? { ...existing, r, focus: f }
          : {
              id,
              x: r + Math.random() * Math.max(1, w - r * 2),
              y: r + Math.random() * Math.max(1, h - r * 2),
              vx: (Math.random() - 0.5) * 0.6,
              vy: (Math.random() - 0.5) * 0.6,
              r,
              kind: "focus",
              focus: f,
            }
      );
    }
    // Add bubble — always present.
    const addExisting = prev.get("add");
    next.push(
      addExisting
        ? { ...addExisting, r: ADD_R, kind: "add" }
        : {
            id: "add",
            x: w - ADD_R - 6,
            y: ADD_R + 6,
            vx: (Math.random() - 0.5) * 0.4,
            vy: (Math.random() - 0.5) * 0.4,
            r: ADD_R,
            kind: "add",
          }
    );
    nodesRef.current = next;
  }, [visible]);

  // RAF physics loop. Only one effect's lifetime so it doesn't get torn down
  // every render.
  useEffect(() => {
    function tick() {
      const container = containerRef.current;
      if (!container) {
        rafIdRef.current = requestAnimationFrame(tick);
        return;
      }
      const w = container.clientWidth;
      const h = CONTAINER_HEIGHT;
      const nodes = nodesRef.current;

      // Random gentle accel — keeps bubbles from settling into a static layout.
      for (const n of nodes) {
        n.vx += (Math.random() - 0.5) * DRIFT_ACCEL;
        n.vy += (Math.random() - 0.5) * DRIFT_ACCEL;
        n.vx *= DAMPING;
        n.vy *= DAMPING;
      }

      // Pairwise collision — circle-circle. O(n²) but n is small (typically <10).
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const minDist = a.r + b.r;
          const distSq = dx * dx + dy * dy;
          if (distSq >= minDist * minDist || distSq < 0.01) continue;
          const dist = Math.sqrt(distSq);
          const overlap = (minDist - dist) / 2;
          const nx = dx / dist;
          const ny = dy / dist;
          // Push apart so they no longer overlap.
          a.x -= nx * overlap;
          a.y -= ny * overlap;
          b.x += nx * overlap;
          b.y += ny * overlap;
          // Reflect velocities along the collision normal (equal-mass elastic).
          const va = a.vx * nx + a.vy * ny;
          const vb = b.vx * nx + b.vy * ny;
          const swap = (vb - va) * COLLISION_RESTITUTION;
          a.vx += nx * swap;
          a.vy += ny * swap;
          b.vx -= nx * swap;
          b.vy -= ny * swap;
        }
      }

      // Position update + wall bounce.
      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < n.r) { n.x = n.r; n.vx = -n.vx * BOUNCE_LOSS; }
        else if (n.x > w - n.r) { n.x = w - n.r; n.vx = -n.vx * BOUNCE_LOSS; }
        if (n.y < n.r) { n.y = n.r; n.vy = -n.vy * BOUNCE_LOSS; }
        else if (n.y > h - n.r) { n.y = h - n.r; n.vy = -n.vy * BOUNCE_LOSS; }

        // Cap top speed so a chaotic burst doesn't make bubbles tunnel.
        const sp = Math.hypot(n.vx, n.vy);
        if (sp > 1.4) {
          n.vx = (n.vx / sp) * 1.4;
          n.vy = (n.vy / sp) * 1.4;
        }

        const el = nodeElsRef.current.get(n.id);
        if (el) {
          el.style.transform = `translate3d(${n.x - n.r}px, ${n.y - n.r}px, 0)`;
        }
      }

      rafIdRef.current = requestAnimationFrame(tick);
    }
    rafIdRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafIdRef.current);
  }, []);

  function startEdit(f: ApiFocus) {
    setAdding(false);
    setEditingId(f.id);
    setEditName(f.name);
    setEditEndgoal(f.endgoal);
  }

  async function commitEdit() {
    if (editingId === null) return;
    const name = editName.trim();
    const endgoal = editEndgoal.trim();
    setEditingId(null);
    if (!name || !endgoal) return;
    try {
      await update(editingId, { name, endgoal });
    } catch (e) { console.error(e); }
  }

  async function cycleStatus(f: ApiFocus) {
    const i = STATUS_ORDER.indexOf(f.status);
    const next = STATUS_ORDER[(i + 1) % STATUS_ORDER.length];
    try { await update(f.id, { status: next }); } catch (e) { console.error(e); }
  }

  async function handleAdd() {
    const name = draftName.trim();
    const endgoal = draftEndgoal.trim();
    if (!name || !endgoal) return;
    try {
      await create({ name, endgoal, status: "committed" });
      setDraftName(""); setDraftEndgoal(""); setAdding(false);
    } catch (e) { console.error(e); }
  }

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px dashed rgba(0,0,0,0.07)" }}>
      <div style={{
        display: "flex", alignItems: "baseline", justifyContent: "space-between",
        marginBottom: 6,
      }}>
        <span style={{
          fontSize: 10, color: "#AEAEB2", letterSpacing: 0.7,
          textTransform: "uppercase", fontFamily: FONT,
        }}>focuses</span>
        <span style={{ fontSize: 10.5, color: "#C7C7CC", fontFamily: FONT }}>
          drag/click to edit · double-click status dot to cycle
        </span>
      </div>

      {/* Bubble play area — physics canvas, just an HTML container with
          absolutely-positioned div bubbles. */}
      <div
        ref={containerRef}
        style={{
          position: "relative",
          width: "100%",
          height: CONTAINER_HEIGHT,
          borderRadius: 12,
          background:
            "radial-gradient(circle at 30% 30%, rgba(74,222,128,0.05), transparent 70%), " +
            "radial-gradient(circle at 75% 70%, rgba(124,58,237,0.04), transparent 65%), " +
            "rgba(0,0,0,0.025)",
          overflow: "hidden",
          border: "1px solid rgba(0,0,0,0.05)",
        }}
      >
        {/* Empty state */}
        {visible.length === 0 && !adding && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            pointerEvents: "none",
            fontSize: 12, color: "#C7C7CC", fontFamily: FONT,
            textAlign: "center", padding: 16,
          }}>
            no focuses yet — click the <strong>+</strong> bubble to add one
          </div>
        )}

        {nodesRef.current.map((n) => {
          if (n.kind === "add") {
            return (
              <div
                key={n.id}
                ref={(el) => {
                  if (el) nodeElsRef.current.set(n.id, el);
                  else nodeElsRef.current.delete(n.id);
                }}
                onClick={() => { setEditingId(null); setAdding(true); }}
                title="Add focus"
                style={{
                  position: "absolute",
                  left: 0, top: 0,
                  width: n.r * 2, height: n.r * 2,
                  borderRadius: "50%",
                  background: "rgba(255,255,255,0.6)",
                  border: "2px dashed rgba(74,222,128,0.55)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  cursor: "pointer",
                  fontFamily: FONT, fontSize: 22, fontWeight: 500,
                  color: "#16A34A",
                  willChange: "transform",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "rgba(74,222,128,0.18)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.6)"; }}
              >+</div>
            );
          }
          const f = n.focus!;
          const c = STATUS_COLORS[f.status];
          // Font size scales with bubble radius so longer names downsize nicely.
          const fontSize = Math.max(10.5, Math.min(13, n.r / 4 + 4));
          return (
            <div
              key={n.id}
              ref={(el) => {
                if (el) nodeElsRef.current.set(n.id, el);
                else nodeElsRef.current.delete(n.id);
              }}
              onClick={() => startEdit(f)}
              onDoubleClick={(e) => { e.stopPropagation(); cycleStatus(f); }}
              title={`${f.name} — ${f.status}\n${f.endgoal}\nClick to edit · double-click to cycle status`}
              style={{
                position: "absolute",
                left: 0, top: 0,
                width: n.r * 2, height: n.r * 2,
                borderRadius: "50%",
                background: c.bg,
                border: `2px solid ${c.ring}`,
                color: c.fg,
                display: "flex", alignItems: "center", justifyContent: "center",
                textAlign: "center",
                padding: 4,
                boxSizing: "border-box",
                cursor: "pointer",
                fontFamily: FONT, fontSize, fontWeight: 600,
                lineHeight: 1.15,
                userSelect: "none",
                boxShadow: "0 4px 16px rgba(0,0,0,0.10), inset 0 -4px 10px rgba(0,0,0,0.08), inset 0 4px 10px rgba(255,255,255,0.35)",
                willChange: "transform",
                overflow: "hidden",
              }}
            >
              <span style={{
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                wordBreak: "break-word",
              }}>{f.name}</span>
            </div>
          );
        })}
      </div>

      {/* Inline edit drawer — same UX as before, just below the canvas. */}
      {editingId !== null && (
        <div
          style={{
            marginTop: 10,
            padding: 12,
            borderRadius: 10,
            background: "rgba(0,0,0,0.03)",
            border: "1px solid rgba(0,0,0,0.06)",
            display: "flex", flexDirection: "column", gap: 8,
          }}
        >
          <input
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              if (e.key === "Escape") setEditingId(null);
            }}
            style={{
              fontSize: 13.5, fontWeight: 500, fontFamily: FONT,
              border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6,
              padding: "5px 9px", outline: "none",
            }}
          />
          <textarea
            value={editEndgoal}
            onChange={(e) => setEditEndgoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commitEdit();
              if (e.key === "Escape") setEditingId(null);
            }}
            placeholder="What does done look like?"
            rows={2}
            style={{
              fontSize: 12.5, fontFamily: FONT,
              border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6,
              padding: "6px 9px", outline: "none", resize: "vertical",
            }}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={commitEdit} style={btnPrimary()}>Save</button>
            <button onClick={() => setEditingId(null)} style={btnGhost()}>Cancel</button>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => { if (editingId !== null) heartbeat(editingId); setEditingId(null); }}
              title="Mark as worked on today"
              style={btnGhost()}
            >♥ worked on it</button>
            <button
              onClick={() => {
                if (editingId === null) return;
                const f = focuses.find((x) => x.id === editingId);
                if (!f) return;
                if (confirm(`Delete focus "${f.name}"?`)) { remove(f.id); setEditingId(null); }
              }}
              style={{ ...btnGhost(), color: "#C76B6B" }}
            >Delete</button>
          </div>
        </div>
      )}

      {adding && (
        <div
          style={{
            marginTop: 10,
            padding: 12,
            borderRadius: 10,
            background: "rgba(74,222,128,0.06)",
            border: "1px dashed rgba(74,222,128,0.4)",
            display: "flex", flexDirection: "column", gap: 8,
          }}
        >
          <input
            autoFocus
            placeholder="Focus name (e.g. Ship Gooni v2)"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setAdding(false); }}
            style={{
              fontSize: 13.5, fontWeight: 500, fontFamily: FONT,
              border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6,
              padding: "5px 9px", outline: "none",
            }}
          />
          <textarea
            placeholder="Endgoal — what does done look like?"
            value={draftEndgoal}
            onChange={(e) => setDraftEndgoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAdd();
              if (e.key === "Escape") setAdding(false);
            }}
            rows={2}
            style={{
              fontSize: 12.5, fontFamily: FONT,
              border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6,
              padding: "6px 9px", outline: "none", resize: "vertical",
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleAdd} style={btnPrimary()}>Add focus</button>
            <button
              onClick={() => { setAdding(false); setDraftName(""); setDraftEndgoal(""); }}
              style={btnGhost()}
            >Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function btnPrimary(): React.CSSProperties {
  return {
    background: "#1C1C1E", color: "#fff",
    border: "none", borderRadius: 6, padding: "5px 12px",
    fontFamily: FONT, fontSize: 12, fontWeight: 500, cursor: "pointer",
  };
}
function btnGhost(): React.CSSProperties {
  return {
    background: "transparent", color: "#6E6E73",
    border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6, padding: "5px 12px",
    fontFamily: FONT, fontSize: 12, cursor: "pointer",
  };
}
