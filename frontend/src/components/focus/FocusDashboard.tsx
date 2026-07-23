import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { FONT } from "../../ui";
import {
  fetchCalendarEvents,
  fetchFocusDashboard,
  fetchTrackableDays,
  fetchTrackables,
  type CalendarEvent,
  type FocusDashboard as FocusDashboardData,
  type Trackable,
  type TrackableDay,
} from "../../services/api";
import { TopicCircles } from "./TopicCircles";
import { buildNotchItems, fmtTime, type NotchItem } from "./notchMerge";

// The kiosk. A browser on a second monitor points here — always on, glanceable,
// no chrome, no interaction. Poll every REFRESH_MS to stay live; the display IS
// the proactivity (a screen that shows what's due + what's gone stale produces
// the effect of an always-running agent with none of the machinery).
//
// TODO(displacement): the plan wants a "Purchases pushed Focus Cam out of the
// top 5" notification with hysteresis (a displacer must beat the incumbent by a
// margin, or the set re-evaluates once daily) — fired on recompute (i.e. when
// Daniel logs). dashboard.overflow_topics carries the below-the-cut topics for
// exactly this. Deferred: get the core glanceable display solid first.

const REFRESH_MS = 25_000;

// Palette lifted from the mockup so the kiosk reads as one dark, low-contrast
// surface. The right log especially is deliberately subtle — "there when you
// want it, invisible when you don't."
const C = {
  bg: "#0b0b0c",
  label: "#6e6e6a", // section labels + day names
  value: "#c9c9c5", // activity values
  dim: "#8a8a86", // notch secondary / log text
  ink: "#e8e8e6", // notch primary
  notchBg: "#1a1a1c",
  hair: "#242426",
  logTime: "#4e4e4a",
  logText: "#8d8d89",
  logLabel: "#5c5c58",
  check: "#5dcaa5",
} as const;

// ── Left sidebar: 5 days of existing trackables ──────────────────────────────
// Reuses the SAME trackable endpoints the ambient log surface uses — no new
// backend. The plan names exercise / protein / calories / physical therapy;
// we render whichever of these actually exist, in this order.
const ACTIVITY_DAYS = 5;
const ACTIVITY_PREF: { match: string[]; short: string }[] = [
  { match: ["protein"], short: "pro" },
  { match: ["calories"], short: "cal" },
  { match: ["exercise"], short: "ex" },
  { match: ["physical therapy", "physical_therapy", "pt", "physio"], short: "pt" },
];

interface ActivityCol {
  t: Trackable;
  short: string;
  days: TrackableDay[]; // newest-first, gap-filled; days[0] = today
}

const WEEK_ABBR = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function dayAbbr(dateStr: string): string {
  // TrackableDay.date is "YYYY-MM-DD" — parse at local noon so the weekday is
  // stable regardless of timezone.
  const d = new Date(`${dateStr}T12:00:00`);
  return Number.isNaN(d.getTime()) ? "" : WEEK_ABBR[d.getDay()];
}

function todayWindowISO(): { startISO: string; endISO: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

export function FocusDashboard() {
  const [data, setData] = useState<FocusDashboardData | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [activity, setActivity] = useState<ActivityCol[]>([]);
  // Which trackables to fetch — resolved once, then reused across polls.
  const activityDefsRef = useRef<{ t: Trackable; short: string }[] | null>(null);

  const loadActivity = useCallback(async () => {
    try {
      if (!activityDefsRef.current) {
        const all = await fetchTrackables();
        const byName = new Map(all.map((t) => [t.name.toLowerCase(), t]));
        const defs: { t: Trackable; short: string }[] = [];
        for (const pref of ACTIVITY_PREF) {
          const hit = pref.match.map((m) => byName.get(m)).find(Boolean);
          if (hit) defs.push({ t: hit, short: pref.short });
        }
        activityDefsRef.current = defs;
      }
      const defs = activityDefsRef.current;
      const cols = await Promise.all(
        defs.map(async ({ t, short }) => ({
          t,
          short,
          days: (await fetchTrackableDays(t.id, ACTIVITY_DAYS)).days,
        })),
      );
      setActivity(cols);
    } catch {
      /* sidebar stays quiet on error */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await fetchFocusDashboard();
      setData(d);
    } catch {
      /* keep the last good frame on a transient error */
    }
    // Calendar is merged client-side; 401 (not connected) or any error just
    // means the notch shows Gooni items only — never an error state.
    try {
      const { startISO, endISO } = todayWindowISO();
      setEvents(await fetchCalendarEvents(startISO, endISO));
    } catch {
      setEvents([]);
    }
    void loadActivity();
  }, [loadActivity]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  // Full-bleed black kiosk — kill the page margin + any scrollbars while mounted.
  useEffect(() => {
    const prevBodyBg = document.body.style.background;
    const prevMargin = document.body.style.margin;
    const prevOverflow = document.body.style.overflow;
    document.body.style.background = C.bg;
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.background = prevBodyBg;
      document.body.style.margin = prevMargin;
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const notchItems: NotchItem[] = useMemo(
    () =>
      data
        ? buildNotchItems(events, data.notch.reminders, data.notch.promises)
        : [],
    [data, events],
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: C.bg,
        color: C.value,
        fontFamily: FONT,
        fontSize: 12,
        overflow: "hidden",
        display: "flex",
      }}
    >
      {/* ── left: 5-day activity + goals ──────────────────────────────── */}
      <aside
        style={{
          width: 232,
          flexShrink: 0,
          borderRight: `0.5px solid ${C.hair}`,
          padding: "22px 20px",
          position: "relative",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ color: C.label, fontSize: 11, marginBottom: 16 }}>activity</div>
        <ActivityGrid cols={activity} />

        {/* Goals — bottom of the column. Content TBD (Daniel to define); render
            a labelled empty slot per the plan, nothing invented. */}
        <div
          style={{
            marginTop: "auto",
            borderTop: `0.5px solid ${C.hair}`,
            paddingTop: 12,
            color: C.label,
            fontSize: 11,
          }}
        >
          goals
        </div>
      </aside>

      {/* ── centre: the topic circles ─────────────────────────────────── */}
      <main style={{ flex: 1, position: "relative", minWidth: 0 }}>
        {data && <TopicCircles circles={data.circles} />}
      </main>

      {/* ── right: subtle batch-label log ─────────────────────────────── */}
      <aside
        style={{
          width: 210,
          flexShrink: 0,
          borderLeft: `0.5px solid ${C.hair}`,
          padding: "22px 18px",
          overflow: "hidden",
        }}
      >
        <div style={{ color: C.logLabel, fontSize: 11, marginBottom: 14 }}>log</div>
        <div style={{ color: C.logText, fontSize: 11.5, lineHeight: 1.5 }}>
          {(data?.log ?? []).map((row) => (
            <div key={row.batch_id} style={{ display: "flex", gap: 9, padding: "4px 0" }}>
              <span style={{ color: C.logTime, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                {fmtTime(row.ended_at)}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {row.label}
              </span>
            </div>
          ))}
        </div>
      </aside>

      {/* ── notch: what's due, hanging from the top edge ──────────────── */}
      <Notch items={notchItems} />
    </div>
  );
}

// ── notch ────────────────────────────────────────────────────────────────────
// A narrow iPhone-X-style notch (rounded bottom corners only) — NOT a full-width
// bar. Merged calendar + dated reminders (time-ordered), then promises by age.
function Notch({ items }: { items: NotchItem[] }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: "50%",
        transform: "translateX(-50%)",
        minWidth: 268,
        maxWidth: 360,
        background: C.notchBg,
        borderRadius: "0 0 20px 20px",
        padding: "10px 18px 13px",
        boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
      }}
    >
      {items.length === 0 ? (
        <div style={{ color: C.dim, textAlign: "center", padding: "2px 0" }}>nothing due</div>
      ) : (
        items.map((it) => (
          <div
            key={it.key}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 16,
              padding: "2px 0",
              color: it.dim ? C.dim : C.ink,
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {it.label}
            </span>
            <span style={{ color: it.dim ? C.dim : C.label, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
              {it.right}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

// ── activity grid ────────────────────────────────────────────────────────────
function ActivityGrid({ cols }: { cols: ActivityCol[] }) {
  if (cols.length === 0) {
    return <div style={{ color: C.label, fontSize: 11 }}>—</div>;
  }

  // Row spine = the newest column's day axis (all cols share the same gap-filled
  // window, newest-first). Keep newest at the top, matching the mockup.
  const dates = cols[0].days.slice(0, ACTIVITY_DAYS).map((d) => d.date);
  // grid: [day] [col1] [col2] … — day label narrow, values flex.
  const template = `26px ${cols.map(() => "1fr").join(" ")}`;

  return (
    <div>
      {/* header */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: template,
          gap: "4px 8px",
          color: C.dim,
          fontSize: 11,
          marginBottom: 8,
        }}
      >
        <span />
        {cols.map((c) => (
          <span key={c.t.id}>{c.short}</span>
        ))}
      </div>

      {/* rows, newest-first */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: template,
          gap: "9px 8px",
          fontSize: 11,
          color: C.value,
        }}
      >
        {dates.map((date, rowIdx) => (
          <Row key={date} date={date} rowIdx={rowIdx} cols={cols} />
        ))}
      </div>
    </div>
  );
}

function Row({ date, rowIdx, cols }: { date: string; rowIdx: number; cols: ActivityCol[] }) {
  return (
    <>
      <span style={{ color: C.label }}>{dayAbbr(date)}</span>
      {cols.map((c) => {
        const day = c.days[rowIdx];
        return <Cell key={c.t.id} t={c.t} day={day} />;
      })}
    </>
  );
}

function Cell({ t, day }: { t: Trackable; day: TrackableDay | undefined }) {
  const v = day?.value;
  if (t.kind === "boolean") {
    return v === true ? (
      <span style={{ color: C.check, display: "inline-flex", alignItems: "center" }}>
        <Check size={12} strokeWidth={2.4} />
      </span>
    ) : (
      <span style={{ color: C.label }}>·</span>
    );
  }
  // numeric / other
  if (typeof v === "number") {
    return <span>{Math.round(v)}</span>;
  }
  return <span style={{ color: C.label }}>—</span>;
}
