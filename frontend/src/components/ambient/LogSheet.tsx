import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, SearchCheck, X } from "lucide-react";
import { FONT, frost, frostInk, z } from "../../ui";
import { ink } from "./ambientInk";
import { TurnTracePanel } from "./TurnTracePanel";
import { DayTimeline } from "./DayTimeline";
import {
  fetchActivity,
  type ActivityItem,
  type CalendarEvent,
} from "../../services/api";

// The log — a right-side frosted sheet behind the corner button.
//
// This is a RE-PRESENTATION of the home's old activity-rail stream, not a new
// pipeline: same `fetchActivity` fetcher, same `before` cursor paging, same
// poll. What changed is where it lives (a summoned edge sheet instead of a
// block under the wave) and that it filters — all · chat · notes.
//
// Today's calendar events ride in at the top. That is the ENTIRE remaining
// calendar surface: the corner button wears an accent dot when the day has an
// event, so the calendar is a reason to open the log rather than a panel of its
// own.

const POLL_MS = 20_000;
const PAGE = 40;
const OLDER_PAGE = 30;
/** Rows a filter needs to show before the scroller can carry the paging. */
const MIN_VISIBLE = 12;
/** Pages the sheet will pull on its own per filter selection, at most. */
const MAX_AUTO_PAGES = 4;

const FILTERS = ["all", "chat", "notes"] as const;
export type LogFilter = (typeof FILTERS)[number];

// The sheet has two modes: the activity stream (filtered) and the day TIMELINE.
// The timeline used to be a permanent column on the B4 dashboard; it lives here
// now because it is something you summon and read, not a third of the home.
type Tab = LogFilter | "timeline";

const SOURCE_BADGE: Record<string, string> = { whatsapp: "wa", telegram: "tg", imessage: "im" };

function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

/** `3:00p` for a timed event; all-day events say so. */
export function eventTime(ev: CalendarEvent): string {
  if (ev.all_day || !ev.start) return "all day";
  const d = new Date(ev.start);
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h < 12 ? "a" : "p";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

function labelFor(it: ActivityItem): { label: string; color: string } {
  switch (it.kind) {
    case "message":
      return it.role === "assistant"
        ? { label: "gooni", color: frostInk.accent }
        : { label: SOURCE_BADGE[it.source ?? ""] ?? "you", color: ink(0.42) };
    case "note":
      return { label: it.verb === "edited" ? "note ·edit" : "note", color: "rgba(150,180,255,0.6)" };
    case "promise":
      return {
        label: `promise ${it.verb ?? ""}`.trim(),
        color: it.state === "kept" ? frostInk.accent
          : it.state === "broken" ? "rgba(248,150,150,0.75)"
          : ink(0.42),
      };
    case "trackable": {
      const src = it.source ?? "manual";
      if (src === "whoop" || src === "leetcode" || src === "derived")
        return { label: "synced", color: "rgba(150,180,255,0.5)" };
      if (src === "shortcuts")
        return { label: "device", color: "rgba(230,190,140,0.6)" };
      return { label: "logged", color: frostInk.accent };
    }
    default:
      return { label: "", color: ink(0.42) };
  }
}

/** `chat` keeps BOTH sides of a turn — a half-transcript isn't a log. */
function passes(it: ActivityItem, filter: LogFilter): boolean {
  if (filter === "all") return true;
  if (filter === "chat") return it.kind === "message";
  return it.kind === "note";
}

export function LogSheet({
  open,
  onClose,
  events,
}: {
  open: boolean;
  onClose: () => void;
  /** today's calendar events — fetched by the corner (it needs the count anyway) */
  events: CalendarEvent[];
}) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [tab, setTab] = useState<Tab>("all");
  const filter: LogFilter = tab === "timeline" ? "all" : tab;
  const [traceId, setTraceId] = useState<number | null>(null);
  const loadingOlder = useRef(false);
  const seen = useRef<Set<string>>(new Set());

  // Poll only while the sheet is open — a closed sheet is not a reason to keep
  // hitting the activity endpoint every 20s.
  useEffect(() => {
    if (!open || tab === "timeline") return;
    let cancelled = false;
    async function loadNewest() {
      try {
        const rows = await fetchActivity({ limit: PAGE });
        if (cancelled) return;
        setItems((prev) => {
          if (prev.length === 0) {
            seen.current = new Set(rows.map((r) => r.key));
            return rows;
          }
          const fresh = rows.filter((r) => !seen.current.has(r.key));
          if (fresh.length === 0) return prev;
          fresh.forEach((r) => seen.current.add(r.key));
          return [...fresh, ...prev].sort((a, b) => (a.at < b.at ? 1 : -1));
        });
      } catch {
        /* transient — keep last good */
      }
    }
    void loadNewest();
    const iv = window.setInterval(loadNewest, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [open, tab]);

  /** Resolves true only when a request actually went out. */
  const loadOlder = useCallback(async (): Promise<boolean> => {
    if (loadingOlder.current || !hasMore || items.length === 0) return false;
    loadingOlder.current = true;
    try {
      const before = items[items.length - 1].at;
      const older = await fetchActivity({ before, limit: OLDER_PAGE });
      const fresh = older.filter((r) => !seen.current.has(r.key));
      if (fresh.length === 0) {
        setHasMore(false);
        return true;
      }
      fresh.forEach((r) => seen.current.add(r.key));
      setItems((prev) => [...prev, ...fresh]);
    } catch {
      /* transient */
    } finally {
      loadingOlder.current = false;
    }
    return true;
  }, [hasMore, items]);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 220) void loadOlder();
  }

  const visible = items.filter((it) => passes(it, filter));

  // Scroll can only page what the scroller can reach. A filter matching few of
  // the loaded rows never overflows the container, so `onScroll` never fires and
  // older matches are unreachable — a chat-heavy first page reads as "nothing
  // yet" under `notes` forever. So page on the POST-filter count too, BOUNDED:
  // a sparse filter must not walk the whole activity stream back to the
  // beginning of time on one open. The cap is a HARD stop for this filter
  // selection (with too few rows to scroll, `onScroll` can't hand off) and
  // resets when the filter changes or the sheet is reopened — so only pages that
  // actually issued a request may spend it.
  const autoPages = useRef(0);
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;

  useEffect(() => {
    autoPages.current = 0;
  }, [filter, open]);

  useEffect(() => {
    if (!open || !hasMore) return;
    if (visible.length >= MIN_VISIBLE) return;
    if (autoPages.current >= MAX_AUTO_PAGES) return;
    // Driven by `items.length`, not by `loadOlder`'s identity: a page that
    // matches nothing leaves `visible` untouched, so the filtered count alone
    // would stall before the cap is reached.
    void loadOlderRef.current().then((issued) => {
      if (issued) autoPages.current += 1;
    });
  }, [open, hasMore, items.length, visible.length]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  return (
    <>
      <aside
        data-log-sheet
        aria-hidden={!open}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(360px, 88vw)",
          zIndex: z.overlay + 1,
          fontFamily: FONT,
          display: "flex",
          flexDirection: "column",
          padding: "20px 18px 8px",
          borderLeft: `1px solid ${ink(0.1)}`,
          ...frost.sheet,
          transform: open ? "translateX(0)" : "translateX(101%)",
          transition: "transform 260ms cubic-bezier(.4,0,.2,1)",
          pointerEvents: open ? "auto" : "none",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.13em", color: ink(0.38) }}>LOG</span>
          <button
            onClick={onClose}
            aria-label="Close the log"
            style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", color: ink(0.38), display: "grid", placeItems: "center" }}
          >
            <X size={14} strokeWidth={1.9} />
          </button>
        </div>

        <div role="tablist" style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setTab(f)}
              aria-selected={tab === f}
              role="tab"
              style={{
                border: "none", background: "transparent", padding: 0, cursor: "pointer",
                fontFamily: FONT, fontSize: 11.5,
                color: tab === f ? ink(0.9) : ink(0.38),
                transition: "color 140ms ease",
              }}
            >
              {f}
            </button>
          ))}
          {/* the calendar glyph moved OFF the corner trigger and onto this tab */}
          <button
            onClick={() => setTab("timeline")}
            aria-selected={tab === "timeline"}
            aria-label="Day timeline"
            role="tab"
            style={{
              marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5,
              border: "none", background: "transparent", padding: 0, cursor: "pointer",
              fontFamily: FONT, fontSize: 11.5,
              color: tab === "timeline" ? ink(0.9) : ink(0.38),
              transition: "color 140ms ease",
            }}
          >
            <CalendarDays size={12} strokeWidth={1.9} />
            timeline
          </button>
        </div>

        {tab === "timeline" ? (
          <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "0 2px 20px", display: "flex" }}>
            <DayTimeline />
          </div>
        ) : (
        <div onScroll={onScroll} style={{ flex: 1, overflowY: "auto", overflowX: "hidden", margin: "0 -4px", padding: "0 4px 20px" }}>
          {/* today's calendar — the dot's referent */}
          {filter === "all" && events.map((ev) => (
            <div key={ev.id} style={{ padding: "7px 0", borderBottom: `1px solid ${ink(0.05)}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, letterSpacing: "0.11em", textTransform: "uppercase", color: frostInk.accent }}>
                <span>calendar</span>
                <span>{eventTime(ev)}</span>
              </div>
              <div style={{ fontSize: 12.5, lineHeight: 1.4, color: ink(0.76), marginTop: 2 }}>{ev.summary || "(untitled)"}</div>
            </div>
          ))}

          {visible.map((it) => {
            const meta = labelFor(it);
            const canAudit = it.kind === "message" && it.role === "assistant" && !!it.has_trace;
            return (
              <div key={it.key} style={{ position: "relative", padding: "7px 0", borderBottom: `1px solid ${ink(0.05)}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, letterSpacing: "0.11em", textTransform: "uppercase", color: meta.color }}>
                  <span>{meta.label}</span>
                  <span style={{ color: ink(0.3) }}>{ago(it.at)}</span>
                </div>
                <div style={{ fontSize: 12.5, lineHeight: 1.4, color: ink(0.76), marginTop: 2, paddingRight: canAudit ? 18 : 0 }}>
                  {it.text || "…"}
                </div>
                {canAudit && (
                  <button
                    aria-label="Audit this turn"
                    title="Inspect the trace for this turn"
                    onClick={() => it.message_id && setTraceId(it.message_id)}
                    style={{
                      position: "absolute", bottom: 6, right: 0, width: 18, height: 18, padding: 0,
                      border: "none", background: "transparent", cursor: "pointer", color: frostInk.accent,
                      display: "grid", placeItems: "center",
                    }}
                  >
                    <SearchCheck size={11} />
                  </button>
                )}
              </div>
            );
          })}

          {visible.length === 0 && (
            <div style={{ fontSize: 12, color: ink(0.3), textAlign: "center", paddingTop: 18 }}>nothing yet</div>
          )}
          {!hasMore && visible.length > 0 && (
            <div style={{ fontSize: 10.5, color: ink(0.22), textAlign: "center", paddingTop: 10 }}>— beginning —</div>
          )}
        </div>
        )}
      </aside>
      {traceId != null && <TurnTracePanel messageId={traceId} onClose={() => setTraceId(null)} />}
    </>
  );
}
