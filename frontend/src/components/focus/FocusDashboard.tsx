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
  type FocusReminder,
  type Trackable,
  type TrackableDay,
} from "../../services/api";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { FOCUS_PALETTES, type FocusPalette } from "./focusPalette";
import { FocusStream } from "./FocusStream";
import { fmtPromiseMeta, fmtTime, fmtWeekday } from "./notchMerge";

// The focus kiosk. A browser on a second monitor points here — always on,
// glanceable, no chrome. The CENTRE is the arcs canvas (FocusStream, the
// chronological said-vs-done timeline). The left rail holds what's owed + due +
// scheduled + the 5-day activity grid — the three schedule-ish data types
// VISUALLY SEPARATED (promises are source data, not a calendar). Poll to stay
// live; the display IS the proactivity.

const REFRESH_MS = 25_000;
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
  const theme = useGooniThemeStore((s) => s.theme);
  const pal = FOCUS_PALETTES[theme];

  const [data, setData] = useState<FocusDashboardData | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [activity, setActivity] = useState<ActivityCol[]>([]);
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
      setData(await fetchFocusDashboard());
    } catch {
      /* keep the last good frame */
    }
    try {
      const { startISO, endISO } = todayWindowISO();
      setEvents(await fetchCalendarEvents(startISO, endISO));
    } catch {
      setEvents([]); // 401 / not connected → Gooni items only, never an error
    }
    void loadActivity();
  }, [loadActivity]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  // Full-bleed kiosk — own the page ground (theme-aware) while mounted.
  useEffect(() => {
    const prev = {
      bg: document.body.style.background,
      margin: document.body.style.margin,
      overflow: document.body.style.overflow,
    };
    document.body.style.background = pal.paper;
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.background = prev.bg;
      document.body.style.margin = prev.margin;
      document.body.style.overflow = prev.overflow;
    };
  }, [pal.paper]);

  const reminders = data?.notch.reminders ?? [];
  const promises = data?.notch.promises ?? [];
  const sortedEvents = useMemo(
    () => [...events].sort((a, b) => (a.start || "").localeCompare(b.start || "")),
    [events],
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: pal.paper,
        color: pal.ink,
        fontFamily: FONT,
        fontSize: 12,
        overflow: "hidden",
        display: "flex",
      }}
    >
      {/* ── left rail ─────────────────────────────────────────────────────── */}
      <aside
        style={{
          width: 250,
          flexShrink: 0,
          borderRight: `1px solid ${pal.rule}`,
          padding: "24px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 22,
          overflow: "hidden",
        }}
      >
        {promises.length > 0 && (
          <RailSection label="owed" pal={pal}>
            {promises.map((p) => (
              <RailRow key={`p${p.id}`} label={p.content} right={fmtPromiseMeta(p.owed_to, p.age_days)} pal={pal} dim />
            ))}
          </RailSection>
        )}

        {reminders.length > 0 && (
          <RailSection label="reminders" pal={pal}>
            {reminders.map((r: FocusReminder) => (
              <RailRow key={`r${r.id}`} label={r.content} right={fmtTime(r.due_at)} pal={pal} />
            ))}
          </RailSection>
        )}

        {sortedEvents.length > 0 && (
          <RailSection label="schedule" pal={pal}>
            {sortedEvents.map((e) => (
              <RailRow
                key={`e${e.id}`}
                label={e.summary || "(untitled)"}
                right={e.all_day ? fmtWeekday(e.start) : fmtTime(e.start)}
                pal={pal}
              />
            ))}
          </RailSection>
        )}

        {/* activity grid — kept form, pinned to the bottom */}
        <div style={{ marginTop: "auto" }}>
          <SectionLabel pal={pal}>activity</SectionLabel>
          <ActivityGrid cols={activity} pal={pal} />
        </div>
      </aside>

      {/* ── centre: the arcs canvas ───────────────────────────────────────── */}
      <main style={{ flex: 1, position: "relative", minWidth: 0 }}>
        <FocusStream />
      </main>
    </div>
  );
}

// ── rail bits ────────────────────────────────────────────────────────────────

function SectionLabel({ children, pal }: { children: React.ReactNode; pal: FocusPalette }) {
  return (
    <div style={{ color: pal.ink3, fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
      {children}
    </div>
  );
}

function RailSection({ label, pal, children }: { label: string; pal: FocusPalette; children: React.ReactNode }) {
  return (
    <div>
      <SectionLabel pal={pal}>{label}</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>{children}</div>
    </div>
  );
}

function RailRow({ label, right, pal, dim }: { label: string; right: string; pal: FocusPalette; dim?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 12.5,
          color: dim ? pal.ink2 : pal.ink,
        }}
      >
        {label}
      </span>
      <span style={{ color: pal.ink3, flexShrink: 0, fontVariantNumeric: "tabular-nums", fontSize: 11.5 }}>{right}</span>
    </div>
  );
}

// ── activity grid ────────────────────────────────────────────────────────────

function ActivityGrid({ cols, pal }: { cols: ActivityCol[]; pal: FocusPalette }) {
  if (cols.length === 0) {
    return <div style={{ color: pal.ink3, fontSize: 11 }}>—</div>;
  }
  const dates = cols[0].days.slice(0, ACTIVITY_DAYS).map((d) => d.date);
  const template = `26px ${cols.map(() => "1fr").join(" ")}`;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: template, gap: "4px 8px", color: pal.ink2, fontSize: 11, marginBottom: 8 }}>
        <span />
        {cols.map((c) => (
          <span key={c.t.id}>{c.short}</span>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: template, gap: "9px 8px", fontSize: 11, color: pal.ink }}>
        {dates.map((date, rowIdx) => (
          <Row key={date} date={date} rowIdx={rowIdx} cols={cols} pal={pal} />
        ))}
      </div>
    </div>
  );
}

function Row({ date, rowIdx, cols, pal }: { date: string; rowIdx: number; cols: ActivityCol[]; pal: FocusPalette }) {
  return (
    <>
      <span style={{ color: pal.ink3 }}>{dayAbbr(date)}</span>
      {cols.map((c) => (
        <Cell key={c.t.id} t={c.t} day={c.days[rowIdx]} pal={pal} />
      ))}
    </>
  );
}

function Cell({ t, day, pal }: { t: Trackable; day: TrackableDay | undefined; pal: FocusPalette }) {
  const v = day?.value;
  if (t.kind === "boolean") {
    return v === true ? (
      <span style={{ color: pal.accent, display: "inline-flex", alignItems: "center" }}>
        <Check size={12} strokeWidth={2.4} />
      </span>
    ) : (
      <span style={{ color: pal.ink3 }}>·</span>
    );
  }
  if (typeof v === "number") {
    return <span>{Math.round(v)}</span>;
  }
  return <span style={{ color: pal.ink3 }}>—</span>;
}
