import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { FONT, frost } from "../../ui";
import {
  createStickyNote,
  deleteNote,
  fetchStickyNotes,
  updateStickyNote,
  type StickyPos,
} from "../../services/api";

// Virtual sticky notes on the ambient home canvas — a lightweight FigJam-ish
// board. Double-click an empty patch of the void to spawn one; type → it
// persists as a real Note (home_pos + `sticky` tag) so it's searchable + feeds
// memory; leave it empty and click away → it evaporates (never hits the
// backend). Drag anywhere (the note follows the cursor 1:1); on drop it settles
// to the nearest legal spot — off the centre capture box + the left nav rail.
// Resize from any edge or corner (invisible handles). Drag onto the trash zone
// (revealed while dragging) to delete. Enter commits (Shift+Enter = newline).
//
// Positions are VIEWPORT FRACTIONS (0..1) so a note keeps its relative spot
// across screen sizes; size (w/h) is px.

const DEFAULT_W = 216;
const DEFAULT_H = 140;
const MIN_W = 150;
const MIN_H = 96;
const MAX_W = 560;
const MAX_H = 480;
const M = 12; // viewport margin
const TOP = 64; // keep clear of the top glow-card lane (LimboCards)
const NAV_BAND = 220; // vertical half-height of the open-nav panel
const NAV_OPEN_X = 240; // right edge of the nav panel when open
const NAV_STRIP_X = 40; // always-live left summon strip + grip
const DRAG_THRESHOLD = 4; // px before a press becomes a drag (vs a click-to-edit)
const SETTLE_MS = 260; // anchor animation duration

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface StickyHandle {
  /** Spawn a new (empty, editing) sticky at a viewport point, anchored legal. */
  createAt: (clientX: number, clientY: number) => void;
}

interface Sticky {
  key: string;
  id: number | null; // null until first persisted
  text: string;
  fx: number; // top-left as viewport fractions
  fy: number;
  w: number; // px
  h: number;
  editing: boolean;
}

export const StickyLayer = forwardRef<
  StickyHandle,
  { vp: { w: number; h: number }; center: { cx: number; cy: number; w: number }; hidden?: boolean }
>(function StickyLayer({ vp, center, hidden }, ref) {
  const [items, setItems] = useState<Sticky[]>([]);
  const [live, setLive] = useState<{ key: string; x: number; y: number } | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overTrash, setOverTrash] = useState(false);
  const [anim, setAnim] = useState<string[]>([]); // keys currently settling
  const keySeq = useRef(0);
  const drag = useRef<{ key: string; dx: number; dy: number; startX: number; startY: number; moved: boolean } | null>(null);
  const resz = useRef<{
    key: string; startX: number; startY: number; startW: number; startH: number;
    startLeft: number; startTop: number; dirX: -1 | 0 | 1; dirY: -1 | 0 | 1;
  } | null>(null);

  // ── geometry ───────────────────────────────────────────────────────────────
  const centerRect = useCallback(() => {
    const hw = center.w / 2 + 40;
    return { l: center.cx - hw, r: center.cx + hw, t: center.cy - 150, b: center.cy + 150 };
  }, [center]);

  const navMinX = useCallback(
    (y: number, h: number) => (Math.abs(y + h / 2 - vp.h / 2) < NAV_BAND ? NAV_OPEN_X : NAV_STRIP_X),
    [vp.h],
  );

  const clampVp = useCallback(
    (x: number, y: number, w: number, h: number): [number, number] => [
      Math.max(M, Math.min(vp.w - w - M, x)),
      Math.max(TOP, Math.min(vp.h - h - M, y)),
    ],
    [vp.w, vp.h],
  );

  // Snap a card box out of the forbidden zones + into the viewport (drop-time).
  const resolve = useCallback(
    (x: number, y: number, w: number, h: number): [number, number] => {
      [x, y] = clampVp(x, y, w, h);
      x = Math.max(x, navMinX(y, h));
      [x, y] = clampVp(x, y, w, h);
      const fr = centerRect();
      const overlaps = x < fr.r && x + w > fr.l && y < fr.b && y + h > fr.t;
      if (overlaps) {
        if (fr.b + 12 + h <= vp.h - M) y = fr.b + 12;
        else if (fr.t - 12 - h >= TOP) y = fr.t - 12 - h;
        else x = fr.r + 12;
        [x, y] = clampVp(x, y, w, h);
      }
      return [x, y];
    },
    [clampVp, navMinX, centerRect, vp.h],
  );

  const trashRect = useCallback(
    () => ({ cx: vp.w / 2, cy: vp.h - 60, hw: 78, hh: 38 }),
    [vp.w, vp.h],
  );
  const inTrash = useCallback(
    (px: number, py: number) => {
      const t = trashRect();
      return Math.abs(px - t.cx) < t.hw && Math.abs(py - t.cy) < t.hh;
    },
    [trashRect],
  );

  // Resolved px top-left (fractions → px → viewport-clamped). Zone-snap only
  // happens on drop, so a persisted note renders where it was left.
  const posOf = useCallback(
    (s: Sticky): [number, number] => {
      if (live && live.key === s.key) return [live.x, live.y];
      return clampVp(s.fx * vp.w, s.fy * vp.h, s.w, s.h);
    },
    [live, clampVp, vp.w, vp.h],
  );

  // ── load ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    void fetchStickyNotes()
      .then((notes) => {
        if (!alive) return;
        setItems(
          notes
            .filter((n) => n.home_pos)
            .map((n) => ({
              key: `s-${n.id}`,
              id: n.id,
              text: (n.content || "").replace(/<[^>]+>/g, "").trim() || n.excerpt || "",
              fx: n.home_pos!.x,
              fy: n.home_pos!.y,
              w: n.home_pos!.w ?? DEFAULT_W,
              h: n.home_pos!.h ?? DEFAULT_H,
              editing: false,
            })),
        );
      })
      .catch(() => {/* home stays quiet */});
    return () => { alive = false; };
  }, []);

  // ── create ─────────────────────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    createAt: (clientX: number, clientY: number) => {
      const [x, y] = resolve(clientX - DEFAULT_W / 2, clientY - DEFAULT_H / 2, DEFAULT_W, DEFAULT_H);
      const key = `new-${keySeq.current++}`;
      setItems((prev) => [
        ...prev,
        { key, id: null, text: "", fx: x / vp.w, fy: y / vp.h, w: DEFAULT_W, h: DEFAULT_H, editing: true },
      ]);
    },
  }), [resolve, vp.w, vp.h]);

  // ── mutations ────────────────────────────────────────────────────────────────
  const persistPos = useCallback((s: Sticky, fx: number, fy: number, w: number, h: number) => {
    if (s.id != null) {
      const pos: StickyPos = { x: fx, y: fy, w, h };
      void updateStickyNote(s.id, { home_pos: pos }).catch(() => {});
    }
  }, []);

  function setText(key: string, text: string) {
    setItems((prev) => prev.map((s) => (s.key === key ? { ...s, text } : s)));
  }

  function commitEdit(s: Sticky) {
    const text = s.text.trim();
    if (text === "") {
      setItems((prev) => prev.filter((x) => x.key !== s.key));
      if (s.id != null) void deleteNote(s.id).catch(() => {});
      return;
    }
    setItems((prev) => prev.map((x) => (x.key === s.key ? { ...x, text, editing: false } : x)));
    if (s.id == null) {
      void createStickyNote(text, { x: s.fx, y: s.fy, w: s.w, h: s.h })
        .then((n) => setItems((prev) => prev.map((x) => (x.key === s.key ? { ...x, id: n.id, key: `s-${n.id}` } : x))))
        .catch(() => {});
    } else {
      void updateStickyNote(s.id, { content: text }).catch(() => {});
    }
  }

  function removeSticky(s: Sticky) {
    setItems((prev) => prev.filter((x) => x.key !== s.key));
    if (s.id != null) void deleteNote(s.id).catch(() => {});
  }

  function startSettle(key: string) {
    setAnim((prev) => (prev.includes(key) ? prev : [...prev, key]));
    window.setTimeout(() => setAnim((prev) => prev.filter((k) => k !== key)), SETTLE_MS);
  }

  // ── drag (free-follow; anchor on release) ────────────────────────────────────
  function onPointerDown(e: React.PointerEvent, s: Sticky) {
    if (s.editing) return;
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    const [px, py] = posOf(s);
    drag.current = { key: s.key, dx: e.clientX - px, dy: e.clientY - py, startX: e.clientX, startY: e.clientY, moved: false };
    setDragKey(s.key);
    setLive({ key: s.key, x: px, y: py });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && (Math.abs(e.clientX - d.startX) > DRAG_THRESHOLD || Math.abs(e.clientY - d.startY) > DRAG_THRESHOLD)) {
      d.moved = true;
    }
    setLive({ key: d.key, x: e.clientX - d.dx, y: e.clientY - d.dy }); // raw — free across screen
    setOverTrash(inTrash(e.clientX, e.clientY));
  }

  function onPointerUp(e: React.PointerEvent, s: Sticky) {
    const d = drag.current;
    drag.current = null;
    setDragKey(null);
    setOverTrash(false);
    if (!d) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    setLive(null);
    if (!d.moved) {
      setItems((prev) => prev.map((x) => (x.key === s.key ? { ...x, editing: true } : x)));
      return;
    }
    if (inTrash(e.clientX, e.clientY)) { removeSticky(s); return; }
    const [x, y] = resolve(e.clientX - d.dx, e.clientY - d.dy, s.w, s.h);
    const fx = x / vp.w;
    const fy = y / vp.h;
    startSettle(s.key); // animate raw drop → legal anchor
    setItems((prev) => prev.map((x2) => (x2.key === s.key ? { ...x2, fx, fy } : x2)));
    persistPos(s, fx, fy, s.w, s.h);
  }

  // ── resize (invisible edge + corner handles) ─────────────────────────────────
  // dir picks which edge you grabbed: +1 grows toward that side (anchor fixed);
  // -1 pulls the near edge so the note's OPPOSITE edge stays put — i.e. the
  // top-left anchor slides by however much the size changed (clamped).
  function onResizeDown(e: React.PointerEvent, s: Sticky, dirX: -1 | 0 | 1, dirY: -1 | 0 | 1) {
    e.stopPropagation();
    const [left, top] = posOf(s);
    resz.current = {
      key: s.key, startX: e.clientX, startY: e.clientY, startW: s.w, startH: s.h,
      startLeft: left, startTop: top, dirX, dirY,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  // Resolve a resize gesture → new box (w/h px + left/top px), honoring clamps.
  function resizeBox(r: NonNullable<typeof resz.current>, e: React.PointerEvent) {
    const dx = e.clientX - r.startX;
    const dy = e.clientY - r.startY;
    let w = r.startW, h = r.startH, left = r.startLeft, top = r.startTop;
    if (r.dirX === 1) w = clamp(r.startW + dx, MIN_W, MAX_W);
    else if (r.dirX === -1) { w = clamp(r.startW - dx, MIN_W, MAX_W); left = r.startLeft + (r.startW - w); }
    if (r.dirY === 1) h = clamp(r.startH + dy, MIN_H, MAX_H);
    else if (r.dirY === -1) { h = clamp(r.startH - dy, MIN_H, MAX_H); top = r.startTop + (r.startH - h); }
    return { w, h, left, top };
  }
  function onResizeMove(e: React.PointerEvent) {
    const r = resz.current;
    if (!r) return;
    const { w, h, left, top } = resizeBox(r, e);
    setItems((prev) => prev.map((x) => (
      x.key === r.key ? { ...x, w, h, fx: left / vp.w, fy: top / vp.h } : x
    )));
  }
  function onResizeUp(e: React.PointerEvent, s: Sticky) {
    const r = resz.current;
    resz.current = null;
    if (!r) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    const { w, h, left, top } = resizeBox(r, e);
    persistPos(s, left / vp.w, top / vp.h, w, h);
  }

  // 4 edges + 4 corners — thin invisible hit-zones straddling the border.
  const HANDLES: { dirX: -1 | 0 | 1; dirY: -1 | 0 | 1; cursor: string; style: React.CSSProperties }[] = [
    { dirX: 0, dirY: -1, cursor: "ns-resize", style: { top: -3, left: 10, right: 10, height: 8 } },
    { dirX: 0, dirY: 1, cursor: "ns-resize", style: { bottom: -3, left: 10, right: 10, height: 8 } },
    { dirX: -1, dirY: 0, cursor: "ew-resize", style: { left: -3, top: 10, bottom: 10, width: 8 } },
    { dirX: 1, dirY: 0, cursor: "ew-resize", style: { right: -3, top: 10, bottom: 10, width: 8 } },
    { dirX: -1, dirY: -1, cursor: "nwse-resize", style: { top: -3, left: -3, width: 13, height: 13 } },
    { dirX: 1, dirY: 1, cursor: "nwse-resize", style: { bottom: -3, right: -3, width: 13, height: 13 } },
    { dirX: 1, dirY: -1, cursor: "nesw-resize", style: { top: -3, right: -3, width: 13, height: 13 } },
    { dirX: -1, dirY: 1, cursor: "nesw-resize", style: { bottom: -3, left: -3, width: 13, height: 13 } },
  ];

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 5, pointerEvents: "none", display: hidden ? "none" : "block" }}>
      {items.map((s) => {
        const [x, y] = posOf(s);
        const dragging = dragKey === s.key;
        const settling = anim.includes(s.key);
        return (
          <div
            key={s.key}
            data-sticky
            onPointerDown={(e) => onPointerDown(e, s)}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => onPointerUp(e, s)}
            style={{
              position: "absolute", left: x, top: y, width: s.w, height: s.h,
              pointerEvents: "auto", cursor: s.editing ? "text" : dragging ? "grabbing" : "grab",
              ...frost.panel, borderRadius: 14,
              border: `1px solid rgba(244,245,244,${s.editing ? 0.2 : 0.1})`,
              boxShadow: dragging ? "0 24px 70px rgba(0,0,0,0.6)" : "0 12px 40px rgba(0,0,0,0.4)",
              opacity: dragging && overTrash ? 0.55 : 1,
              padding: 13, boxSizing: "border-box", fontFamily: FONT,
              transition: dragging
                ? "none"
                : settling
                  ? `left ${SETTLE_MS}ms cubic-bezier(0.22,1,0.36,1), top ${SETTLE_MS}ms cubic-bezier(0.22,1,0.36,1)`
                  : "box-shadow 160ms ease, border-color 160ms ease",
            }}
          >
            {s.editing ? (
              <textarea
                data-no-drag
                autoFocus
                value={s.text}
                onChange={(e) => setText(s.key, e.target.value)}
                onBlur={() => commitEdit(s)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEdit(s); }
                  if (e.key === "Escape") { e.preventDefault(); commitEdit(s); }
                }}
                placeholder="note to self…"
                spellCheck={false}
                style={{
                  width: "100%", height: "100%", resize: "none", outline: "none", border: "none",
                  background: "transparent", color: "#F4F5F4", fontFamily: FONT, fontSize: 13.5, lineHeight: 1.5,
                }}
              />
            ) : (
              <div style={{
                width: "100%", height: "100%", overflow: "hidden", color: "rgba(244,245,244,0.88)",
                fontSize: 13.5, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "none",
              }}>
                {s.text}
              </div>
            )}

            {/* resize from any edge/corner — invisible hit-zones, no grip */}
            {HANDLES.map((hd, i) => (
              <div
                key={i}
                data-no-drag
                onPointerDown={(e) => onResizeDown(e, s, hd.dirX, hd.dirY)}
                onPointerMove={onResizeMove}
                onPointerUp={(e) => onResizeUp(e, s)}
                style={{ position: "absolute", cursor: hd.cursor, pointerEvents: "auto", ...hd.style }}
              />
            ))}
          </div>
        );
      })}

      {/* trash drop-zone — only while dragging */}
      {dragKey && (
        <div
          style={{
            position: "fixed", left: "50%", bottom: 28,
            display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 999,
            pointerEvents: "none", fontFamily: FONT, fontSize: 12.5, letterSpacing: 0.3,
            ...frost.panel,
            border: `1px solid ${overTrash ? "rgba(248,113,113,0.7)" : "rgba(244,245,244,0.12)"}`,
            color: overTrash ? "rgba(248,113,113,0.95)" : "rgba(244,245,244,0.5)",
            transform: `translateX(-50%) scale(${overTrash ? 1.08 : 1})`,
            transition: "transform 140ms ease, border-color 140ms ease, color 140ms ease",
          }}
        >
          <Trash2 size={15} strokeWidth={1.8} />
          {overTrash ? "release to delete" : "drag here to delete"}
        </div>
      )}
    </div>
  );
});
