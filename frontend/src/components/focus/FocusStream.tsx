import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  fetchFocusStream,
  type FocusStreamItem,
  type StreamEvent,
  type StreamThought,
} from "../../services/api";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { FONT } from "../../ui";
import { FOCUS_PALETTES, type FocusPalette } from "./focusPalette";

// The arcs canvas (reference: gooni-arcs-events.html). A single chronological
// column with a threading gutter: a spine, a node per entry, and an arc from
// each thought back to that topic's PREVIOUS occurrence — the "return", its
// size = how long you were away. Shortcuts device events interleave quietly
// (dash nodes, no arcs). Three slow ambient layers (arc pulse, arc sway, the
// capture wave) freeze under prefers-reduced-motion.
//
// The gutter is drawn IMPERATIVELY from measured card positions (like the
// mockup's build()/tick()) — React owns the cards, raw SVG owns the threads.

const X = 56; // node x inside the gutter
const GUTTER_W = 78;
const REFRESH_MS = 25_000;
const PAGE_DAYS = 7; // window size; "load older" grows it by this
const MAX_DAYS = 60;
const NS = "http://www.w3.org/2000/svg";

interface Link {
  older: number; // higher index = earlier in a newest-first list
  newer: number;
  base: SVGPathElement;
  glow: SVGPathElement;
  bow: number;
  sway: number;
  phase: number;
  trip: number;
  off: number;
}

// Deterministic per-index pseudo-random in [0,1) — so arcs keep the SAME sway/
// phase across rebuilds (a Math.random source would re-jitter every resize).
function rand(n: number): number {
  const r = Math.sin(n * 9973.13) * 43758.5453;
  return r - Math.floor(r);
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  parent: SVGElement,
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  parent.appendChild(n);
  return n as SVGElementTagNameMap[K];
}

// ── date helpers (all local; `at` arrives UTC-aware so new Date converts) ─────
function fmtClock(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
}
function dayKey(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
// Shortcuts events arrive as a raw "{subject} {event}" label ("claude open",
// "home arrive", "office leave"). Rephrase the common device verbs so app-opens
// AND location arrivals/leaves read like sentences rather than machine tokens.
// Unknown shapes pass through untouched (the vocab is open-ended server-side).
function formatEventLabel(raw: string): string {
  const s = (raw || "").trim();
  const m = s.match(/^(.*?)\s+(arrived?|left|leave|opened?|closed?|unlocked?|locked?|charging|plugged)$/i);
  if (!m) return s;
  const subject = m[1].trim();
  const verb = m[2].toLowerCase();
  if (verb.startsWith("arriv")) return `arrived at ${subject}`;
  if (verb === "left" || verb === "leave") return `left ${subject}`;
  if (verb.startsWith("open")) return `opened ${subject}`;
  if (verb.startsWith("close")) return `closed ${subject}`;
  if (verb.startsWith("unlock")) return `unlocked ${subject}`;
  if (verb.startsWith("lock")) return `locked ${subject}`;
  return s;
}

function dayHeading(at: string): { weekday: string; date: string } {
  const d = new Date(at);
  return {
    weekday: d.toLocaleDateString([], { weekday: "long" }),
    date: d.toLocaleDateString([], { day: "numeric", month: "long" }).toLowerCase(),
  };
}

export function FocusStream() {
  const theme = useGooniThemeStore((s) => s.theme);
  const pal = FOCUS_PALETTES[theme];

  const [items, setItems] = useState<FocusStreamItem[]>([]);
  const [days, setDays] = useState(PAGE_DAYS);
  const [loaded, setLoaded] = useState(false);
  const loadingMoreRef = useRef(false);

  const frameRef = useRef<HTMLDivElement>(null);
  const gutRef = useRef<SVGSVGElement>(null);
  const cardRefs = useRef<(HTMLElement | null)[]>([]);
  const ysRef = useRef<number[]>([]);
  const linksRef = useRef<Link[]>([]);

  // ── data ───────────────────────────────────────────────────────────────────
  const load = useCallback(async (d: number) => {
    try {
      const res = await fetchFocusStream(d);
      setItems(res.items);
      setLoaded(true);
    } catch {
      /* keep the last good frame */
    } finally {
      loadingMoreRef.current = false;
    }
  }, []);

  useEffect(() => {
    load(days);
    const id = window.setInterval(() => load(days), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load, days]);

  // Grow the window when scrolled near the bottom (infinite scroll back in time).
  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (loadingMoreRef.current || days >= MAX_DAYS) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) {
        loadingMoreRef.current = true;
        setDays((d) => Math.min(MAX_DAYS, d + PAGE_DAYS));
      }
    },
    [days],
  );

  // ── gutter (imperative, from measured card centers) ──────────────────────────
  const buildGutter = useCallback(() => {
    const frame = frameRef.current;
    const gut = gutRef.current;
    if (!frame || !gut) return;

    const top = frame.getBoundingClientRect().top;
    const ys = items.map((_, i) => {
      const n = cardRefs.current[i];
      if (!n) return 0;
      const r = n.getBoundingClientRect();
      return r.top - top + r.height / 2;
    });
    ysRef.current = ys;

    gut.setAttribute("height", String(frame.offsetHeight));
    gut.innerHTML = "";
    linksRef.current = [];
    if (ys.length === 0) return;

    // spine
    svgEl(gut, "line", {
      x1: X,
      y1: ys[0],
      x2: X,
      y2: ys[ys.length - 1],
      stroke: pal.spine,
      "stroke-width": 1,
    });

    // arcs: each thought → the previous (older = higher index) same-topic thought
    items.forEach((d, i) => {
      if (d.type !== "thought") return;
      let p = -1;
      for (let j = i + 1; j < items.length; j++) {
        const o = items[j];
        if (o.type === "thought" && o.topic === d.topic) {
          p = j;
          break;
        }
      }
      if (p < 0) return;
      const color = d.color || pal.accent;
      const g = svgEl(gut, "g", {});
      const base = svgEl(g, "path", {
        stroke: color,
        "stroke-width": 1.6,
        fill: "none",
        opacity: 0.4,
        "stroke-linecap": "round",
      });
      const glow = svgEl(g, "path", {
        stroke: color,
        "stroke-width": 2.6,
        fill: "none",
        opacity: 0.85,
        "stroke-linecap": "round",
      });
      linksRef.current.push({
        older: p,
        newer: i,
        base,
        glow,
        bow: Math.min(32, 10 + Math.abs(ys[p] - ys[i]) * 0.12),
        sway: 0.85 + rand(i) * 0.7,
        phase: rand(i + 101) * 6.28,
        trip: 11 + rand(i + 211) * 7,
        off: rand(i + 307) * 12,
      });
    });

    // nodes: thoughts = topic-color dot on a paper ring; events = a short dash
    items.forEach((d, i) => {
      if (d.type === "thought") {
        const color = d.color || pal.accent;
        svgEl(gut, "circle", { cx: X, cy: ys[i], r: 8, fill: color, opacity: i === 0 ? 0.18 : 0.07 });
        svgEl(gut, "circle", { cx: X, cy: ys[i], r: 5, fill: pal.paper });
        svgEl(gut, "circle", { cx: X, cy: ys[i], r: 3.4, fill: color });
      } else {
        svgEl(gut, "line", {
          x1: X - 4.5,
          y1: ys[i],
          x2: X + 4.5,
          y2: ys[i],
          stroke: pal.event,
          "stroke-width": 1.8,
          opacity: 0.55,
          "stroke-linecap": "round",
        });
      }
    });
  }, [items, pal]);

  // Rebuild after layout whenever the data or theme changes.
  useLayoutEffect(() => {
    buildGutter();
  }, [buildGutter]);

  // Rebuild on resize.
  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(buildGutter);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
    };
  }, [buildGutter]);

  // ── ambient animation (arc pulse + sway + capture wave) ──────────────────────
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const tick = (ms: number) => {
      const s = ms / 1000;
      const ys = ysRef.current;
      for (const l of linksRef.current) {
        const yO = ys[l.older];
        const yN = ys[l.newer];
        if (yO == null || yN == null) continue;
        const b = l.bow * (1 + 0.15 * Math.sin(s * l.sway + l.phase));
        const d = `M${X} ${yO} C ${X - b} ${yO}, ${X - b} ${yN}, ${X} ${yN}`;
        l.base.setAttribute("d", d);
        l.glow.setAttribute("d", d);
        // Travelling pulse older → newer (up the page in a newest-first list).
        const len = l.glow.getTotalLength();
        const dash = Math.max(16, len * 0.2);
        const prog = ((s + l.off) % l.trip) / l.trip;
        l.glow.setAttribute("stroke-dasharray", `${dash} ${len + dash}`);
        l.glow.setAttribute("stroke-dashoffset", String(dash - prog * (len + dash)));
      }
      if (!reduce) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── render ───────────────────────────────────────────────────────────────────
  let prevDay = "";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: pal.paper, minWidth: 0 }}>
      <div onScroll={onScroll} style={{ flex: 1, overflowY: "auto", padding: "20px 24px 30px" }}>
        <div ref={frameRef} style={{ maxWidth: 660, margin: "0 auto", position: "relative", fontFamily: FONT }}>
          <svg
            ref={gutRef}
            width={GUTTER_W}
            style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", overflow: "visible" }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginLeft: GUTTER_W }}>
            {loaded && items.length === 0 && (
              <div style={{ color: pal.ink3, fontSize: 13, padding: "40px 0", textAlign: "center" }}>
                nothing logged yet
              </div>
            )}
            {items.map((it, i) => {
              const k = dayKey(it.at);
              const newDay = k !== prevDay;
              prevDay = k;
              return (
                <div key={it.type === "thought" ? `t${it.batch_id}` : `e${it.label}-${it.at}`}>
                  {newDay && <DayHeader at={it.at} pal={pal} />}
                  {it.type === "thought" ? (
                    <ThoughtCard
                      it={it}
                      pal={pal}
                      ref={(el) => {
                        cardRefs.current[i] = el;
                      }}
                    />
                  ) : (
                    <EventCard
                      it={it}
                      pal={pal}
                      ref={(el) => {
                        cardRefs.current[i] = el;
                      }}
                    />
                  )}
                </div>
              );
            })}
            {days >= MAX_DAYS && items.length > 0 && (
              <div style={{ color: pal.ink3, fontSize: 11, textAlign: "center", padding: "14px 0 0" }}>
                · {MAX_DAYS} days ·
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── cards ──────────────────────────────────────────────────────────────────

function DayHeader({ at, pal }: { at: string; pal: FocusPalette }) {
  const h = dayHeading(at);
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, margin: "10px 0 6px" }}>
      <h2 style={{ fontSize: 20, fontWeight: 500, margin: 0, letterSpacing: "-0.01em", color: pal.ink }}>
        {h.weekday}
      </h2>
      <span style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: pal.ink3 }}>
        {h.date}
      </span>
    </div>
  );
}

// Sentence card — the headline unit. Third-person batch label, topic-color dot,
// hover-lift. (Click → provenance drawer is deferred: needs the transcript store.)
const ThoughtCard = forwardRef<HTMLDivElement, { it: StreamThought; pal: FocusPalette }>(
  function ThoughtCard({ it, pal }, ref) {
    const [hover, setHover] = useState(false);
    const color = it.color || pal.accent;
    return (
      <div
        ref={ref}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          background: pal.card,
          borderRadius: 18,
          boxShadow: hover ? pal.lift : pal.liftSm,
          padding: "15px 20px 17px",
          transform: hover ? "translateY(-2px)" : "none",
          transition: "transform .25s cubic-bezier(.2,.7,.3,1), box-shadow .25s",
        }}
      >
        <span
          style={{
            fontSize: 10,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: pal.ink3,
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, display: "inline-block" }} />
          {it.topic} · {fmtClock(it.at)}
          {it.thought_count > 1 && <span style={{ opacity: 0.7 }}>· {it.thought_count}</span>}
        </span>
        {it.image_url && (
          <img
            src={it.image_url}
            alt={it.sentence || "pinned image"}
            loading="lazy"
            style={{
              display: "block",
              width: "100%",
              maxHeight: 320,
              objectFit: "cover",
              borderRadius: 12,
              margin: "10px 0 0",
            }}
          />
        )}
        <p style={{ fontSize: 16.5, lineHeight: 1.5, margin: "8px 0 0", letterSpacing: "-0.005em", color: pal.ink }}>
          {it.sentence || "…"}
        </p>
      </div>
    );
  },
);

// Event card — passive device telemetry. Inverted weight: quieter than a
// thought (single line, no elevation, pulled toward the rail, category tint).
// Colour carries category; the small size says "observed, not said."
const EventCard = forwardRef<HTMLDivElement, { it: StreamEvent; pal: FocusPalette }>(
  function EventCard({ it, pal }, ref) {
    return (
      <div
        ref={ref}
        style={{
          marginLeft: -30,
          borderRadius: 13,
          padding: "9px 15px",
          display: "flex",
          alignItems: "baseline",
          gap: 11,
          fontSize: 13.5,
          lineHeight: 1.4,
          color: pal.ink2,
          background: `color-mix(in srgb, ${pal.event} ${Math.round(pal.tint * 100)}%, transparent)`,
        }}
      >
        <span style={{ fontSize: 11.5, color: pal.ink3, fontVariantNumeric: "tabular-nums", flex: "none" }}>
          {fmtClock(it.at)}
        </span>
        <span>
          {formatEventLabel(it.label)}
          {it.count > 1 && ` ×${it.count}`}
        </span>
      </div>
    );
  },
);
