import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { FONT, frostInk } from "../../ui";
import { ink } from "./ambientInk";
import { addDays, dayKeyLocal, eventDayKey } from "./calendarDates";
import { ItemEditor, type ItemEditorState } from "./ItemEditor";
import { parseServerDate } from "../../utils/date";
import {
  fetchCalendarEvents,
  fetchFocusStream,
  fetchPromises,
  patchPromise,
  type ApiPromise,
  type CalendarEvent,
  type StreamEvent,
} from "../../services/api";

// The day timeline — time as VERTICAL POSITION, restored 2026-08-11 close to
// the form it had on the deleted B4 dashboard, but rehoused as a TAB inside the
// log sheet rather than a column on a board of its own. That is the whole
// change of shape: the timeline is something you summon and read, not a
// permanent third of the home.
//
// It stays click-to-add: clicking bare track opens `ItemEditor` defaulted to an
// event, and the modal's own toggle flips it to a promise. Dragging a promise
// onto the axis still gives it a real time.
//
// Palette: this now paints inside a frosted sheet, so it reads the ambient ink
// tokens rather than the focus board's local palette. The two block colours
// stay literal — they are identity, not theme.

const NOW_COLOR = "#2b6cff";
const TL_CHOSEN = "#7b88a6"; // committed/chosen block (gcal) — solid, not grey

const TL_MARKS: Array<[string, string]> = [
  ["0%", "12a"],
  ["25%", "6a"],
  ["50%", "12p"],
  ["75%", "6p"],
  ["100%", "12a"],
];

/**
 * Naive-UTC (promise dues) AND tz-aware (gcal/device) inputs both land here.
 * `utils/date.parseServerDate` is the shared owner of the append-Z-only-when-no-
 * offset rule but returns `Date | null`; every call site below needs a Date, so
 * this narrows once with an Invalid-Date fallback rather than null-checking in
 * eight places.
 */
function parseUtc(iso: string): Date {
  return parseServerDate(iso) ?? new Date(NaN);
}

/** Local minutes-since-midnight. */
function minsLocal(iso: string): number {
  const d = parseUtc(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function isSameDayLocal(iso: string | null, day: Date): boolean {
  if (!iso) return false;
  const d = parseUtc(iso);
  return (
    d.getFullYear() === day.getFullYear() &&
    d.getMonth() === day.getMonth() &&
    d.getDate() === day.getDate()
  );
}

function hhmmLocal(iso: string): string {
  const d = parseUtc(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A vertical fraction (0=midnight, 1=next midnight) → a 5-min-snapped pair. */
function fracToTimes(frac: number): { startTime: string; endTime: string } {
  let mins = Math.min(1435, Math.max(0, Math.round(frac * 1440)));
  mins = Math.round(mins / 5) * 5;
  const em = Math.min(1439, mins + 30);
  const fmt = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { startTime: fmt(mins), endTime: fmt(em) };
}

/**
 * EOD-anchored dues (local 23:59) are the "no real time" marker — they belong
 * in the TODAY list, not as a positioned block. Every `+ add` on the home
 * creates one, so without this filter the axis would stack the whole list at
 * the bottom of the day.
 */
function isEodAnchored(iso: string): boolean {
  const d = parseUtc(iso);
  return d.getHours() === 23 && d.getMinutes() === 59;
}

function TLBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        width: 22, height: 22, padding: 0, borderRadius: 5, cursor: "pointer",
        border: "none", background: "transparent", color: ink(0.42),
        display: "grid", placeItems: "center",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = ink(0.9))}
      onMouseLeave={(e) => (e.currentTarget.style.color = ink(0.42))}
    >
      {children}
    </button>
  );
}

export function DayTimeline() {
  const [day, setDay] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [promises, setPromises] = useState<ApiPromise[]>([]);
  const [deviceEvents, setDeviceEvents] = useState<StreamEvent[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [editor, setEditor] = useState<ItemEditorState | null>(null);

  const now = new Date();
  const isToday =
    day.getFullYear() === now.getFullYear() &&
    day.getMonth() === now.getMonth() &&
    day.getDate() === now.getDate();
  const nowFrac = ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;
  const dayKey = dayKeyLocal(day);
  const dateLabel = isToday
    ? "today"
    : day.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

  useEffect(() => {
    let cancelled = false;
    const end = addDays(day, 1);
    fetchCalendarEvents(day.toISOString(), end.toISOString())
      .then((e) => { if (!cancelled) setEvents(e); })
      .catch(() => { if (!cancelled) setEvents([]); });
    return () => { cancelled = true; };
  }, [day, reloadKey]);

  const loadPromises = useCallback(async () => {
    try {
      setPromises(await fetchPromises());
    } catch {
      /* ambient */
    }
  }, []);

  useEffect(() => { void loadPromises(); }, [loadPromises, reloadKey]);

  // Device pings stay TODAY-only — ambient telemetry, not something to chase
  // back through history.
  useEffect(() => {
    let cancelled = false;
    fetchFocusStream(1)
      .then((s) => {
        if (cancelled) return;
        setDeviceEvents(s.items.filter((i): i is StreamEvent => i.type === "event"));
      })
      .catch(() => { if (!cancelled) setDeviceEvents([]); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  const scheduled = useMemo(
    () =>
      promises.filter(
        (p) =>
          p.cadence === "once" &&
          p.state === "active" &&
          p.inferred_due != null &&
          isSameDayLocal(p.inferred_due, day) &&
          !isEodAnchored(p.inferred_due),
      ),
    [promises, day],
  );

  const timed = events.filter((e) => !e.all_day && e.start);
  const allDay = events.filter((e) => e.all_day);

  const saved = () => {
    setEditor(null);
    setReloadKey((k) => k + 1);
  };

  // Click empty track → the editor, defaulted to "event"; its own toggle flips
  // it to a promise. No intermediate picker.
  const openCreate = (frac: number) => {
    const { startTime, endTime } = fracToTimes(frac);
    setEditor({ kind: "event", mode: "create", summary: "", dayKey, startTime, endTime, allDay: false });
  };
  const openEditEvent = (e: CalendarEvent) =>
    setEditor({
      kind: "event",
      mode: "edit",
      id: e.id,
      summary: e.summary === "(untitled)" ? "" : e.summary,
      dayKey: eventDayKey(e) || dayKey,
      startTime: e.all_day || !e.start ? "09:00" : hhmmLocal(e.start),
      endTime: e.all_day || !e.end ? "10:00" : hhmmLocal(e.end),
      allDay: e.all_day,
    });
  const openEditPromise = (p: ApiPromise) =>
    setEditor({
      kind: "promise",
      mode: "edit",
      id: String(p.id),
      summary: p.summary || p.utterance,
      dayKey,
      startTime: p.inferred_due ? hhmmLocal(p.inferred_due) : "09:00",
      endTime: "10:00",
      allDay: false,
    });

  const dropSchedule = async (promiseId: number, frac: number) => {
    const mins = Math.round(Math.min(1435, Math.max(0, Math.round(frac * 1440))) / 5) * 5;
    const when = new Date(day.getTime() + mins * 60000);
    try {
      await patchPromise(promiseId, { due: when.toISOString() });
      setReloadKey((k) => k + 1);
    } catch {
      /* ignore */
    }
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, fontFamily: FONT }}>
      <div
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          margin: "0 0 10px", flex: "0 0 auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <TLBtn label="Previous day" onClick={() => setDay((d) => addDays(d, -1))}>
            <ChevronLeft size={14} />
          </TLBtn>
          <span style={{ fontSize: 11, color: ink(0.42), minWidth: 78, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
            {dateLabel}
          </span>
          <TLBtn label="Next day" onClick={() => setDay((d) => addDays(d, 1))}>
            <ChevronRight size={14} />
          </TLBtn>
          {!isToday && (
            <button
              onClick={() => { const d = new Date(); d.setHours(0, 0, 0, 0); setDay(d); }}
              style={{
                marginLeft: 4, border: "none", background: "transparent",
                color: frostInk.accent, fontSize: 10.5, fontFamily: FONT, cursor: "pointer", padding: 0,
              }}
            >
              today
            </button>
          )}
        </div>
        {/* the calendar glyph now lives HERE, inside the timeline tab — the
            corner log trigger wears its own log icon */}
        <CalendarDays size={13} color={ink(0.3)} aria-hidden />
      </div>

      {allDay.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8, flex: "0 0 auto" }}>
          {allDay.map((e) => (
            <span
              key={e.id}
              onClick={() => openEditEvent(e)}
              style={{
                fontSize: 9, padding: "2px 6px", borderRadius: 4,
                background: TL_CHOSEN, color: "#fff", whiteSpace: "nowrap", cursor: "pointer",
              }}
            >
              {e.summary}
            </span>
          ))}
        </div>
      )}

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const raw = e.dataTransfer.getData("text/promise");
          if (!raw) return;
          const r = e.currentTarget.getBoundingClientRect();
          void dropSchedule(Number(raw), (e.clientY - r.top) / r.height);
        }}
        onClick={(e) => {
          if (e.target !== e.currentTarget) return; // only bare track
          const r = e.currentTarget.getBoundingClientRect();
          openCreate((e.clientY - r.top) / r.height);
        }}
        title="click to add · drag a task here to schedule"
        style={{
          position: "relative", flex: 1, marginLeft: 26,
          borderLeft: `1.5px solid ${ink(0.12)}`, minHeight: 320, cursor: "copy",
        }}
      >
        {TL_MARKS.map(([top, lbl]) => (
          <div
            key={lbl}
            style={{
              position: "absolute", left: -24, top, transform: "translateY(-50%)",
              fontSize: 8, color: ink(0.34), pointerEvents: "none",
            }}
          >
            {lbl}
          </div>
        ))}

        {isToday && (
          <div
            style={{
              position: "absolute", left: -5, right: -4, top: `${nowFrac}%`,
              borderTop: `2px solid ${NOW_COLOR}`, zIndex: 5, pointerEvents: "none",
            }}
          >
            <span style={{ position: "absolute", left: -3, top: -4, width: 6, height: 6, borderRadius: "50%", background: NOW_COLOR }} />
          </div>
        )}

        {timed.map((e) => {
          const startM = minsLocal(e.start as string);
          const endM = e.end ? minsLocal(e.end) : startM + 30;
          const top = (startM / 1440) * 100;
          const height = ((Math.max(endM, startM + 15) - startM) / 1440) * 100;
          return (
            <div
              key={e.id}
              title={e.summary}
              onClick={(ev) => { ev.stopPropagation(); openEditEvent(e); }}
              style={{
                position: "absolute", left: 6, right: 4, top: `${top}%`, height: `${height}%`,
                minHeight: 12, background: TL_CHOSEN, color: "#fff", borderRadius: 4,
                padding: "2px 5px", fontSize: 8.5, overflow: "hidden",
                whiteSpace: "nowrap", textOverflow: "ellipsis", cursor: "pointer",
              }}
            >
              {e.summary}
            </div>
          );
        })}

        {scheduled.map((p) => {
          const top = (minsLocal(p.inferred_due as string) / 1440) * 100;
          const text = p.summary || p.utterance;
          return (
            <div
              key={`p-${p.id}`}
              title={text}
              onClick={(ev) => { ev.stopPropagation(); openEditPromise(p); }}
              style={{
                position: "absolute", left: 6, right: 4, top: `${top}%`, minHeight: 14,
                background: frostInk.accent, color: "#fff", borderRadius: 4,
                padding: "2px 5px", fontSize: 8.5, overflow: "hidden",
                whiteSpace: "nowrap", textOverflow: "ellipsis", cursor: "pointer",
              }}
            >
              {text}
            </div>
          );
        })}

        {isToday &&
          deviceEvents.map((ev, i) => (
            <div
              key={`${ev.label}-${i}`}
              title={`${ev.label} ×${ev.count}`}
              style={{
                position: "absolute", left: 4, top: `${(minsLocal(ev.at) / 1440) * 100}%`,
                transform: "translateY(-50%)", display: "flex", alignItems: "center", gap: 4,
                pointerEvents: "none",
              }}
            >
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: ink(0.34) }} />
              <span style={{ fontSize: 8, color: ink(0.34), whiteSpace: "nowrap" }}>
                {ev.label}{ev.count > 1 ? ` ×${ev.count}` : ""}
              </span>
            </div>
          ))}
      </div>

      {editor && (
        <ItemEditor editor={editor} onChange={setEditor} onClose={() => setEditor(null)} onSaved={saved} />
      )}
    </div>
  );
}
