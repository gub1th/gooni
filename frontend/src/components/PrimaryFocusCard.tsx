import { useEffect, useRef, useState } from "react";
import { fetchItemTree, updateItem, type ApiItemNode } from "../services/api";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

type DragSrc = { id: number };

// Module-level drag carrier — HTML5 dataTransfer drops focus across components,
// so we keep a tiny in-memory bus to coordinate ListView → here.
// (Only one drag in flight, so a single ref is fine.)
const dragBus: { current: DragSrc | null } = { current: null };

export function getPrimaryDragBus() { return dragBus; }

interface Props {
  // Bumped by callers (Dashboard) when the primary might have changed elsewhere.
  refreshKey?: number;
}

export function PrimaryFocusCard({ refreshKey }: Props) {
  const [primary, setPrimary] = useState<ApiItemNode | null>(null);
  const [focuses, setFocuses] = useState<ApiItemNode[]>([]);
  const [dragHover, setDragHover] = useState(false);
  const [picking, setPicking] = useState(false);
  // Animation key — incremented each time primary changes so the vine border re-runs.
  const [animKey, setAnimKey] = useState(0);
  const lastPrimaryId = useRef<number | null>(null);

  async function load() {
    try {
      const tree = await fetchItemTree();
      const all = tree.focuses;
      const prim = all.find((f) => f.is_primary) || null;
      setFocuses(all);
      setPrimary(prim);
      const newId = prim?.id ?? null;
      if (newId !== lastPrimaryId.current) {
        lastPrimaryId.current = newId;
        if (newId != null) setAnimKey((k) => k + 1);
      }
    } catch (e) {
      console.error("PrimaryFocusCard load failed", e);
    }
  }

  useEffect(() => { load(); }, [refreshKey]);

  // Listen for in-app promotion events from elsewhere (e.g. ListView's "Make
  // primary" button) so the card refreshes without a manual reload.
  useEffect(() => {
    const handler = () => { load(); };
    window.addEventListener("gooni-primary-changed", handler);
    return () => window.removeEventListener("gooni-primary-changed", handler);
  }, []);

  async function promote(id: number) {
    try {
      await updateItem(id, { is_primary: true });
      await load();
      setPicking(false);
    } catch (e) {
      console.error("promote failed", e);
    }
  }

  async function unsetPrimary() {
    if (!primary) return;
    try {
      await updateItem(primary.id, { is_primary: false });
      lastPrimaryId.current = null;
      await load();
    } catch (e) {
      console.error("unsetPrimary failed", e);
    }
  }

  // Visible state shapes:
  //   1. primary set → big card, vine animation, shows endgoal + progress
  //   2. primary unset, has focuses → drop zone + "Pick a focus" picker
  //   3. no focuses at all → empty hint
  const hasFocuses = focuses.length > 0;
  const isEmpty = !primary;

  return (
    <div
      onDragOver={(e) => {
        if (dragBus.current) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDragHover(true);
        }
      }}
      onDragLeave={() => setDragHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragHover(false);
        const src = dragBus.current;
        dragBus.current = null;
        if (src) promote(src.id);
      }}
      style={{
        position: "relative",
        background: primary ? "#FFFBEB" : "#FFFFFF",
        border: dragHover
          ? "2px dashed #F59E0B"
          : primary
          ? "1px solid #FCD34D"
          : "1px dashed rgba(0,0,0,0.18)",
        borderRadius: 14,
        padding: primary ? "20px 22px 18px" : "18px",
        marginBottom: 14,
        transition: "border-color 160ms, background 160ms",
        overflow: "hidden",
      }}
    >
      {/* Vine border animation — 4 SVG paths growing from each edge midpoint
          out to the corners. Re-keyed so it replays on each primary change. */}
      {primary && <VineBorder key={animKey} />}

      <style>{`
        @keyframes gooni-vine-grow {
          from { stroke-dashoffset: var(--vine-len); }
          to   { stroke-dashoffset: 0; }
        }
      `}</style>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, position: "relative", zIndex: 2 }}>
        <span style={{ fontSize: 14, color: "#F59E0B" }}>★</span>
        <span style={{
          fontSize: 11, color: primary ? "#92400E" : "#8E8E93",
          letterSpacing: 0.6, textTransform: "uppercase", fontWeight: 700,
        }}>
          Primary Focus
        </span>
        {primary && (
          <button
            onClick={unsetPrimary}
            title="Unset primary"
            style={{
              marginLeft: "auto", border: "none", background: "transparent",
              color: "#92400E", fontSize: 11, fontFamily: FONT, cursor: "pointer",
              padding: "2px 6px", borderRadius: 6,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(146,64,14,0.08)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            Unset
          </button>
        )}
      </div>

      {primary ? (
        <div style={{ position: "relative", zIndex: 2 }}>
          <div style={{
            fontSize: 22, fontWeight: 700, color: "#1C1C1E",
            lineHeight: 1.25, letterSpacing: "-0.3px", marginBottom: 6,
          }}>
            {primary.text}
          </div>
          {primary.endgoal && (
            <div style={{ fontSize: 13.5, color: "#5B4220", lineHeight: 1.5, marginBottom: 8 }}>
              {primary.endgoal}
            </div>
          )}
          {primary.progress.total > 0 && (
            <div style={{
              fontSize: 11, color: "#92400E",
              letterSpacing: 0.4, textTransform: "uppercase", fontWeight: 600,
            }}>
              {primary.progress.done} / {primary.progress.total} done
            </div>
          )}
        </div>
      ) : isEmpty && hasFocuses ? (
        <div style={{ position: "relative", zIndex: 2 }}>
          {picking ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {focuses.map((f) => (
                <button
                  key={f.id}
                  onClick={() => promote(f.id)}
                  style={{
                    border: "1px solid #E5E7EB", background: "#FFFFFF",
                    color: "#1C1C1E", fontFamily: FONT, fontSize: 13,
                    padding: "8px 12px", borderRadius: 8, cursor: "pointer",
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#F9FAFB"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#FFFFFF"; }}
                >
                  {f.text}
                </button>
              ))}
              <button
                onClick={() => setPicking(false)}
                style={{
                  border: "none", background: "transparent", color: "#9CA3AF",
                  fontFamily: FONT, fontSize: 12, cursor: "pointer", padding: "4px 0",
                  textAlign: "left",
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <p style={{ fontSize: 13, color: "#8E8E93", margin: 0, lineHeight: 1.5 }}>
                Drop a focus here, or click to spotlight one.
              </p>
              <button
                onClick={() => setPicking(true)}
                style={{
                  border: "1px solid #1C1C1E", background: "#1C1C1E", color: "#FFFFFF",
                  fontFamily: FONT, fontSize: 12, fontWeight: 600,
                  padding: "6px 12px", borderRadius: 8, cursor: "pointer", flexShrink: 0,
                }}
              >
                Pick focus
              </button>
            </div>
          )}
        </div>
      ) : (
        <p style={{ fontSize: 13, color: "#C7C7CC", margin: 0, lineHeight: 1.55, position: "relative", zIndex: 2 }}>
          No focuses yet. Add a focus first, then promote it here for the spotlight treatment.
        </p>
      )}
    </div>
  );
}

// ── Vine animation ─────────────────────────────────────────────────────────
// Four SVG strokes, one per edge, each starting at the edge midpoint and
// growing outward to both corners. strokeDasharray + strokeDashoffset gives us
// the "drawing" effect (grows from offset=full to offset=0). Each edge is one
// path so dasharray works in a straight line; we use four separate paths so
// they all start growing at the same time from their respective midpoints.
function VineBorder() {
  // Use an SVG that scales to the parent via viewBox + preserveAspectRatio="none".
  // The parent's borderRadius would clip a static border, but the SVG sits
  // inside it (overflow:hidden on parent), so the strokes hug the edge.
  const W = 1000;
  const H = 200;
  const r = 14;        // matches parent borderRadius
  const halfW = W / 2;
  const halfH = H / 2;
  const horizLen = halfW - r;
  const vertLen = halfH - r;

  const stroke = "#F59E0B";
  const sw = 2;

  // Each path goes from midpoint to corner, with a bend at the rounded corner.
  // Length used as both dasharray + initial offset.
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 1,
      }}
    >
      {/* Top edge — midpoint to top-left, midpoint to top-right */}
      <line
        x1={halfW} y1={0} x2={r} y2={0}
        stroke={stroke} strokeWidth={sw} strokeLinecap="round"
        style={{
          // @ts-expect-error css var
          "--vine-len": `${horizLen}`,
          strokeDasharray: horizLen,
          strokeDashoffset: horizLen,
          animation: "gooni-vine-grow 700ms cubic-bezier(0.22, 1, 0.36, 1) forwards",
        }}
      />
      <line
        x1={halfW} y1={0} x2={W - r} y2={0}
        stroke={stroke} strokeWidth={sw} strokeLinecap="round"
        style={{
          // @ts-expect-error css var
          "--vine-len": `${horizLen}`,
          strokeDasharray: horizLen,
          strokeDashoffset: horizLen,
          animation: "gooni-vine-grow 700ms cubic-bezier(0.22, 1, 0.36, 1) forwards",
        }}
      />
      {/* Bottom edge */}
      <line
        x1={halfW} y1={H} x2={r} y2={H}
        stroke={stroke} strokeWidth={sw} strokeLinecap="round"
        style={{
          // @ts-expect-error css var
          "--vine-len": `${horizLen}`,
          strokeDasharray: horizLen,
          strokeDashoffset: horizLen,
          animation: "gooni-vine-grow 700ms cubic-bezier(0.22, 1, 0.36, 1) forwards",
        }}
      />
      <line
        x1={halfW} y1={H} x2={W - r} y2={H}
        stroke={stroke} strokeWidth={sw} strokeLinecap="round"
        style={{
          // @ts-expect-error css var
          "--vine-len": `${horizLen}`,
          strokeDasharray: horizLen,
          strokeDashoffset: horizLen,
          animation: "gooni-vine-grow 700ms cubic-bezier(0.22, 1, 0.36, 1) forwards",
        }}
      />
      {/* Left edge */}
      <line
        x1={0} y1={halfH} x2={0} y2={r}
        stroke={stroke} strokeWidth={sw} strokeLinecap="round"
        style={{
          // @ts-expect-error css var
          "--vine-len": `${vertLen}`,
          strokeDasharray: vertLen,
          strokeDashoffset: vertLen,
          animation: "gooni-vine-grow 700ms cubic-bezier(0.22, 1, 0.36, 1) forwards",
        }}
      />
      <line
        x1={0} y1={halfH} x2={0} y2={H - r}
        stroke={stroke} strokeWidth={sw} strokeLinecap="round"
        style={{
          // @ts-expect-error css var
          "--vine-len": `${vertLen}`,
          strokeDasharray: vertLen,
          strokeDashoffset: vertLen,
          animation: "gooni-vine-grow 700ms cubic-bezier(0.22, 1, 0.36, 1) forwards",
        }}
      />
      {/* Right edge */}
      <line
        x1={W} y1={halfH} x2={W} y2={r}
        stroke={stroke} strokeWidth={sw} strokeLinecap="round"
        style={{
          // @ts-expect-error css var
          "--vine-len": `${vertLen}`,
          strokeDasharray: vertLen,
          strokeDashoffset: vertLen,
          animation: "gooni-vine-grow 700ms cubic-bezier(0.22, 1, 0.36, 1) forwards",
        }}
      />
      <line
        x1={W} y1={halfH} x2={W} y2={H - r}
        stroke={stroke} strokeWidth={sw} strokeLinecap="round"
        style={{
          // @ts-expect-error css var
          "--vine-len": `${vertLen}`,
          strokeDasharray: vertLen,
          strokeDashoffset: vertLen,
          animation: "gooni-vine-grow 700ms cubic-bezier(0.22, 1, 0.36, 1) forwards",
        }}
      />
    </svg>
  );
}
