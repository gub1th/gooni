import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SearchCheck, X } from "lucide-react";
import { FONT, frost, frostInk, z } from "../../ui";
import { useNowTick } from "../../hooks/useNowTick";
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
// Today's calendar events ride in at the top — the ones that have ALREADY
// STARTED, which is what makes this a record rather than a preview. The corner
// button's accent dot is gone (it said "something exists" without saying what),
// and the upcoming event is the notch's UP NEXT, which names it. See
// `loggedEvents` for the split and why all-day events are exempt from it.

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

/**
 * The events the LOG should carry — the ones that have already happened.
 *
 * The captain flagged seeing today's events in `all` as not feeling right, at
 * the same time as the notch's UP NEXT. Both complaints have one cause: a
 * future event was being reported in two places, and the log's copy was the
 * useless one — buried in a stream you had to open and scan.
 *
 * The log is NOT deleted as a calendar surface, because it is the record of the
 * day and an event that happened is part of what happened. What it stops doing
 * is PREVIEWING. The split is by start time:
 *
 *   already started → the log. It is history now, which is the log's job.
 *   still upcoming  → the notch, which names it outright and counts down to it.
 *
 * ALL-DAY events are always kept: `pickUpNext` excludes them on purpose (there
 * is no start to count down to), so the log is the only surface they have and
 * dropping them here would take them off the app entirely.
 *
 * An unparseable start is kept for the same reason — a row we cannot place is
 * still a row, and silently discarding it would hide a real event behind a bad
 * timestamp.
 */
export function loggedEvents(events: CalendarEvent[], now: number): CalendarEvent[] {
  return events.filter((ev) => {
    if (ev.all_day || !ev.start) return true;
    const startsAt = new Date(ev.start).getTime();
    if (Number.isNaN(startsAt)) return true;
    return startsAt <= now;
  });
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

/**
 * The amber `device` row — one treatment for all three sensors.
 *
 * The phone's iOS Shortcuts pings arrive as a `trackable` with source
 * `shortcuts` (each ping is a real +1 on a real Trackable). The browser and the
 * desktop shell arrive as `device`, DERIVED from their raw attention intervals
 * with no Trackable anywhere — high-cardinality names would have minted
 * hundreds of them and flooded the log matrix, so the feed is where the two
 * meet, not the Trackable table.
 *
 * That is a storage distinction, not a reading one: "opened hinge" from the
 * phone and "opened cursor" from the Mac are the same fact about the day and
 * must look the same. One constant, used by both arms, so they cannot drift.
 */
const DEVICE_ROW = { label: "device", color: "rgba(230,190,140,0.6)" };

export function labelFor(it: ActivityItem): { label: string; color: string } {
  switch (it.kind) {
    case "device":
      return DEVICE_ROW;
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
      if (src === "shortcuts") return DEVICE_ROW;
      return { label: "logged", color: frostInk.accent };
    }
    default:
      return { label: "", color: ink(0.42) };
  }
}

/**
 * Fold a freshly-polled page into the rows already on screen.
 *
 * The key dedup is what stops a row appearing twice once paging has walked past
 * it, so it stays — but a key is NOT a promise that the row is finished. A
 * device run anchors at its FIRST open by design (a row saying "opened cursor"
 * belongs at the moment it was opened), so its key and its `at` are stable for
 * the whole run while its text keeps growing: `opened cursor` becomes
 * `opened cursor ×8` as the day's opens chain into it. Dropping the re-fetched
 * copy froze the first version on screen for as long as the sheet stayed
 * mounted — which is all day, since it never remounts.
 *
 * So a known key REPLACES its row rather than being discarded, in place.
 *
 * And ANY change re-sorts, replacements included — `items` is the paging SPINE
 * (`loadOlder` takes its cursor from the last row's `at`), so it has to stay in
 * chronological order after every mutation, not only after an append. A key
 * being stable does not make its `at` stable: `note-{id}` carries `updated_at`
 * and `promise-{id}` carries `resolved_at`, so editing a note or closing a
 * promise genuinely moves a loaded row. Replacing the OLDEST such row in place
 * without re-sorting hands `loadOlder` a near-present cursor, which returns
 * nothing new, latches `hasMore` false, and kills paging for the session.
 * A no-op merge still returns `prev` untouched, and the sort is stable, so
 * equal timestamps keep their order. Pure, so the rule is testable.
 */
export function mergeNewest(prev: ActivityItem[], rows: ActivityItem[], seen: Set<string>): ActivityItem[] {
  if (prev.length === 0) {
    rows.forEach((r) => seen.add(r.key));
    return rows;
  }
  const byKey = new Map(rows.map((r) => [r.key, r]));
  let changed = false;
  const merged = prev.map((it) => {
    const next = byKey.get(it.key);
    if (!next || (next.text === it.text && next.at === it.at)) return it;
    changed = true;
    return next;
  });
  const fresh = rows.filter((r) => !seen.has(r.key));
  if (fresh.length === 0 && !changed) return prev;
  fresh.forEach((r) => seen.add(r.key));
  return [...fresh, ...merged].sort((a, b) => (a.at < b.at ? 1 : -1));
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
  /** today's calendar events — fetched ONCE by the home, shared with the notch */
  events: CalendarEvent[];
}) {
  // A LIVE clock, not `Date.now()` stamped at mount: an event crosses its start
  // time while the sheet sits open, and a frozen `now` would keep it filed as
  // upcoming — the same trap the whoop tile's age had. A minute is plenty for a
  // boundary measured in calendar-event granularity.
  const now = useNowTick(60_000);
  const pastEvents = useMemo(() => loggedEvents(events, now), [events, now]);

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
          if (prev.length === 0) seen.current = new Set();
          return mergeNewest(prev, rows, seen.current);
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
      {/* Clip box — same reason as SurfacePanel's. The sheet parks itself at
          `translateX(101%)` when closed, which put a 360px fixed element
          entirely outside the right edge of the viewport; measured at 1440 it
          sat at x=1104..1501. Clipping it here keeps the slide and keeps the
          geometry inside the window. */}
      <div
        style={{
          position: "fixed",
          top: "var(--gooni-header-h, 0px)",
          right: 0,
          bottom: 0,
          width: "min(360px, 88vw)",
          overflow: "hidden",
          zIndex: z.overlay + 1,
          pointerEvents: open ? "auto" : "none",
        }}
      >
      <aside
        data-log-sheet
        aria-hidden={!open}
        style={{
          position: "absolute",
          // FLUSH with the toolbar, not under it. At `top: 0` the sheet slid up
          // behind the sticky header and its own LOG label collided with the
          // header's controls; it starts where the toolbar ends — the clip box
          // above owns that offset now.
          inset: 0,
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
          {/* a plain tab, inline with the rest — it is one of the sheet's
              views, not a special affordance parked at the far edge */}
          <button
            onClick={() => setTab("timeline")}
            aria-selected={tab === "timeline"}
            role="tab"
            style={{
              border: "none", background: "transparent", padding: 0, cursor: "pointer",
              fontFamily: FONT, fontSize: 11.5,
              color: tab === "timeline" ? ink(0.9) : ink(0.38),
              transition: "color 140ms ease",
            }}
          >
            timeline
          </button>
        </div>

        {tab === "timeline" ? (
          <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "0 2px 20px", display: "flex" }}>
            <DayTimeline />
          </div>
        ) : (
        <div onScroll={onScroll} style={{ flex: 1, overflowY: "auto", overflowX: "hidden", margin: "0 -4px", padding: "0 4px 20px" }}>
          {/* today's calendar, PAST events only — see `loggedEvents`. The
              upcoming one is the notch's, and it says what it is there. */}
          {filter === "all" && pastEvents.map((ev) => (
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
      </div>
      {traceId != null && <TurnTracePanel messageId={traceId} onClose={() => setTraceId(null)} />}
    </>
  );
}
