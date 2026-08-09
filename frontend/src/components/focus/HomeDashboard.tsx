import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { CalendarDays, ChevronLeft, ChevronRight, Maximize2, Plus, X } from "lucide-react";
import { FONT } from "../../ui";
import {
  createPromise,
  fetchCalendarEvents,
  fetchFocusStream,
  fetchPromises,
  fetchRecentNotes,
  fetchTrackableDays,
  fetchTrackables,
  logTrackable,
  patchPromise,
  type ApiNote,
  type ApiPromise,
  type CalendarEvent,
  type StreamEvent,
  type Trackable,
  type TrackableDay,
} from "../../services/api";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { useNotesContentStore } from "../../stores/useNotesContentStore";
import { useWidgetOverlayStore } from "../../stores/useWidgetOverlayStore";
import { addDays, dayKeyLocal, eventDayKey } from "../widgets/calendarDates";
import { ItemEditor, type ItemEditorState } from "../widgets/ItemEditor";
import { LogTable } from "../ambient/LogTable";
import { FOCUS_PALETTES } from "./focusPalette";

// ────────────────────────────────────────────────────────────────────────────
// B4 — the "adaptive banner" home dashboard (spec 2026-08-01).
//
// A full-width reactive banner over three columns:
//   LEFT   day timeline   — positional (time = vertical position), gcal + device
//   MID    finna-do       — today-only trackable chips + one-off promises
//   RIGHT  notes          — reverse-chron thought log + capture bar
//
// Reads v2 primitives ONLY (Promise/Trackable/Note) + gcal + device pings — the
// convergence surface. FocusDashboard stays on the /focus kiosk; since the
// convergence it reads the same Promise rows through `focus_service`'s adapter
// (its `reminders` table was dropped in `b8f3d1c07a45`).
//
// The banner is the "screen earns its space" thesis: the ONE element that
// changes with your state. Everything below it is stable.
// ────────────────────────────────────────────────────────────────────────────

const REFRESH_MS = 25_000;
const BOARD_MAX = "min(1440px, 94vw)";

// Banner is the single "lit" element — a dark warm gradient in BOTH themes so it
// reads as focal against warm paper (light) or charcoal (dark).
const BANNER_BG = "linear-gradient(135deg,#2a2a28,#3a3833)";
const BANNER_INK = "#f4f1ea";
const NOW_COLOR = "#2b6cff";

// The daily-glance trackable set — mirror LogDots/FocusDashboard `isStreak`:
// boolean habits + key numbers, minus json feeds (whoop/leetcode), device
// telemetry (shortcuts), walled-off focus-cam, and the freeform "note".
function isDailyChip(t: Trackable): boolean {
  if (t.kind === "json") return false;
  if (t.source === "whoop" || t.source === "leetcode") return false;
  if (t.source === "shortcuts" || t.source === "focus_cam") return false;
  if (t.name === "note") return false;
  return true;
}

function todayWindowISO(): { startISO: string; endISO: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

// Backend v2 datetimes (promise inferred_due/resolved_at, note created_at) are
// serialized NAIVE-UTC with no tz suffix — `new Date(iso)` would read them as
// local wall-clock and land hours off. Append a Z when there's no tz designator
// so JS reads them as UTC then converts to local (same fix as
// focus_service._iso). gcal/device timestamps already carry a tz → untouched.
function parseUtc(iso: string): Date {
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso);
  return new Date(hasTz ? iso : iso + "Z");
}

// Local-day check on a naive-UTC ISO string.
function isTodayLocal(iso: string | null): boolean {
  return isSameDayLocal(iso, new Date());
}

// Does an ISO instant fall on the given local calendar day?
function isSameDayLocal(iso: string | null, day: Date): boolean {
  if (!iso) return false;
  const d = parseUtc(iso);
  return (
    d.getFullYear() === day.getFullYear() &&
    d.getMonth() === day.getMonth() &&
    d.getDate() === day.getDate()
  );
}

// Local HH:MM for an ISO instant — seeds the editor's time field.
function hhmmLocal(iso: string): string {
  const d = parseUtc(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// A vertical drop/click fraction (0=midnight, 1=next midnight) → a 5-min-snapped
// {start, end+30m} HH:MM pair for the editor.
function fracToTimes(frac: number): { startTime: string; endTime: string } {
  let mins = Math.min(1435, Math.max(0, Math.round(frac * 1440)));
  mins = Math.round(mins / 5) * 5;
  const em = Math.min(1439, mins + 30);
  const fmt = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { startTime: fmt(mins), endTime: fmt(em) };
}

// EOD-anchored dues (local 23:59) are the "no real time" marker the extractor
// stamps for "today"/"tomorrow" — they belong in the finna-do LIST, not as a
// positioned timeline block. A drag gives a promise a real time (≠ 23:59).
function isEodAnchored(iso: string): boolean {
  const d = parseUtc(iso);
  return d.getHours() === 23 && d.getMinutes() === 59;
}

// Compact clock like the mockup's "1:37a".
function fmtClock(iso: string | null): string {
  if (!iso) return "";
  const d = parseUtc(iso);
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h < 12 ? "a" : "p";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")}${ap}`;
}

interface Chip {
  t: Trackable;
  today: TrackableDay | null;
}

// The one shared affordance style — add-finna-do, new-note, all-notes all use it
// so the board's "actions" read as one family.
function dashedBtn(pal: (typeof FOCUS_PALETTES)["dark"]): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    width: "100%",
    border: `1px dashed ${pal.rule}`,
    borderRadius: 8,
    background: "transparent",
    color: pal.ink2,
    fontFamily: FONT,
    fontSize: 11.5,
    cursor: "pointer",
    padding: "7px 0",
  };
}

export function HomeDashboard() {
  const theme = useGooniThemeStore((s) => s.theme);
  const pal = FOCUS_PALETTES[theme];

  const [promises, setPromises] = useState<ApiPromise[]>([]);
  const [keptToday, setKeptToday] = useState(0);
  const [brokenToday, setBrokenToday] = useState(0);
  const [chips, setChips] = useState<Chip[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [deviceEvents, setDeviceEvents] = useState<StreamEvent[]>([]);
  const [notes, setNotes] = useState<ApiNote[]>([]);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const chipDefsRef = useRef<Trackable[] | null>(null);

  // ── Data layer ────────────────────────────────────────────────────────────
  const loadChips = useCallback(async () => {
    try {
      if (!chipDefsRef.current) {
        const all = (await fetchTrackables()).filter(isDailyChip);
        all.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "boolean" ? -1 : 1;
          if (a.is_important !== b.is_important) return a.is_important ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        chipDefsRef.current = all;
      }
      const defs = chipDefsRef.current;
      const withToday = await Promise.all(
        defs.map(async (t) => {
          try {
            const { days } = await fetchTrackableDays(t.id, 1);
            return { t, today: days[0] ?? null };
          } catch {
            return { t, today: null };
          }
        }),
      );
      setChips(withToday);
    } catch {
      /* keep last */
    }
  }, []);

  const load = useCallback(async () => {
    const { startISO, endISO } = todayWindowISO();
    // Promises: active slate + today's resolved for the said-vs-done count.
    fetchPromises({ state: "active", limit: 100 })
      .then(setPromises)
      .catch(() => {});
    fetchPromises({ state: "kept", limit: 50 })
      .then((rows) => setKeptToday(rows.filter((r) => isTodayLocal(r.resolved_at)).length))
      .catch(() => {});
    fetchPromises({ state: "broken", limit: 50 })
      .then((rows) => setBrokenToday(rows.filter((r) => isTodayLocal(r.resolved_at)).length))
      .catch(() => {});
    // gcal — 401 (not connected) is not an error here.
    fetchCalendarEvents(startISO, endISO)
      .then(setEvents)
      .catch(() => setEvents([]));
    // Device pings (Shortcuts) — clustered event cards, today only.
    fetchFocusStream(1)
      .then((s) =>
        setDeviceEvents(
          s.items.filter((i): i is StreamEvent => i.type === "event"),
        ),
      )
      .catch(() => {});
    fetchRecentNotes(30).then(setNotes).catch(() => {});
    loadChips();
  }, [loadChips]);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  // Own the page background while mounted (matches FocusDashboard) so there's
  // no flash of the app's void behind the paper board.
  useEffect(() => {
    const prev = document.body.style.background;
    document.body.style.background = pal.paper;
    return () => {
      document.body.style.background = prev;
    };
  }, [pal.paper]);

  // ── Derived: scheduled (on the timeline) vs finna-do list ────────────────────
  // A once-promise with a real time TODAY (dragged onto the axis) renders as a
  // timeline block. Everything else one-shot + active + due-today-or-overdue (or
  // dateless) stays in the finna-do list.
  const scheduled = useMemo(
    () =>
      promises.filter(
        (p) =>
          p.cadence === "once" &&
          p.state === "active" &&
          p.inferred_due != null &&
          isTodayLocal(p.inferred_due) &&
          !isEodAnchored(p.inferred_due),
      ),
    [promises],
  );

  const finnaDo = useMemo(() => {
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    return promises.filter((p) => {
      if (p.cadence !== "once" || p.state !== "active") return false;
      const due = p.inferred_due;
      if (due != null && isTodayLocal(due) && !isEodAnchored(due)) return false; // scheduled
      if (due == null) return true; // dateless todo
      if (isTodayLocal(due)) return true; // due today (EOD-anchored)
      if (parseUtc(due) < startToday) return true; // overdue, still open
      return false; // future → longer-term (deferred this pass)
    });
  }, [promises]);

  // Notes are a today+yesterday log, not an archive — anything older belongs in
  // the notes browser, not the ambient glance.
  const visibleNotes = useMemo(() => {
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - 1);
    return notes.filter((n) => n.created_at && parseUtc(n.created_at) >= cutoff);
  }, [notes]);

  const toggleBoolChip = useCallback(
    async (chip: Chip) => {
      const cur = chip.today?.value === true;
      try {
        await logTrackable(chip.t.id, { value_boolean: !cur, replace: true });
      } catch {
        /* ignore */
      }
      loadChips();
    },
    [loadChips],
  );

  const commitNumChip = useCallback(
    async (chip: Chip, value: number | null) => {
      try {
        await logTrackable(
          chip.t.id,
          value == null ? { replace: true } : { value_numeric: value, replace: true },
        );
      } catch {
        /* ignore */
      }
      loadChips();
    },
    [loadChips],
  );

  const addTodo = useCallback(
    async (text: string) => {
      try {
        await createPromise(text);
        load();
      } catch {
        /* ignore */
      }
    },
    [load],
  );

  const checkTodo = useCallback(
    async (id: number) => {
      try {
        await patchPromise(id, { state: "kept" });
        load();
      } catch {
        /* ignore */
      }
    },
    [load],
  );

  // ── Notes: open the full add-note editor / browser ──────────────────────────
  const navigate = useNavigate({ from: "/" });
  const createNoteInStore = useNotesContentStore((s) => s.createNote);
  const openNotes = useCallback(
    (compose: boolean) => {
      if (compose) createNoteInStore("general"); // seeds a draft + activeNoteId → editor
      else useNotesContentStore.setState({ activeNoteId: null }); // → discovery/browser
      navigate({
        search: {
          note: undefined,
          conv: undefined,
          audit: undefined,
          segment: undefined,
          view: "notes",
        },
        replace: true,
      });
    },
    [navigate, createNoteInStore],
  );

  // ── Layout ──────────────────────────────────────────────────────────────────
  const panelStyle: React.CSSProperties = {
    background: pal.card,
    borderRadius: 12,
    boxShadow: pal.liftSm,
    padding: 14,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  };
  const colHead: React.CSSProperties = {
    fontSize: 11,
    letterSpacing: 0.3,
    color: pal.ink3,
    margin: "0 0 10px",
    flex: "0 0 auto",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  };

  return (
    <div
      style={{
        // ABSOLUTE, not fixed: fills the AppShell Outlet wrapper (already inset
        // by the persistent nav's reserved lane) instead of the whole viewport —
        // so the IconRail can't overlap the left column. (A fixed root ignores
        // the ancestor's padding and covers under the rail.)
        position: "absolute",
        inset: 0,
        background: pal.paper,
        color: pal.ink,
        fontFamily: FONT,
        padding: 20,
        overflow: "hidden",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          maxWidth: BOARD_MAX,
          height: "100%",
          margin: "0 auto",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <Banner
          pal={pal}
          events={events}
          scheduled={scheduled}
          keptToday={keptToday}
          brokenToday={brokenToday}
          finnaOpen={finnaDo.length}
        />

        <div
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 14,
          }}
        >
          {/* COL 1 — day timeline (positional, paged, interactive) */}
          <div style={panelStyle}>
            <TimelineAxis
              promises={promises}
              deviceEvents={deviceEvents}
              onChanged={load}
              pal={pal}
            />
          </div>

          {/* COL 2 — trackables + finna-do, two sections in one column */}
          <div style={panelStyle}>
            <FinnaDoBody
              chips={chips}
              todos={finnaDo}
              pal={pal}
              onToggleBool={toggleBoolChip}
              onCommitNum={commitNumChip}
              onAddTodo={addTodo}
              onCheckTodo={checkTodo}
              onExpandMatrix={() => setMatrixOpen(true)}
            />
          </div>

          {/* COL 3 — notes (complete) */}
          <div style={panelStyle}>
            <div style={colHead}>
              <span>notes</span>
            </div>
            <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
              {visibleNotes.length === 0 ? (
                <div style={{ color: pal.ink3, fontSize: 11, paddingTop: 4 }}>
                  nothing captured today
                </div>
              ) : (
                visibleNotes.map((n) => <NoteRow key={n.id} note={n} pal={pal} />)
              )}
            </div>
            <div
              style={{
                flex: "0 0 auto",
                marginTop: 10,
                borderTop: `1px solid ${pal.rule}`,
                paddingTop: 8,
                display: "flex",
                gap: 8,
              }}
            >
              <button style={dashedBtn(pal)} onClick={() => openNotes(true)}>
                <Plus size={13} /> new note
              </button>
              <button style={dashedBtn(pal)} onClick={() => openNotes(false)}>
                all notes
              </button>
            </div>
          </div>
        </div>
      </div>
      {matrixOpen && <LogTableModal onClose={() => setMatrixOpen(false)} />}
    </div>
  );
}

// Frosted modal wrapping the full trackables matrix — reuses the self-contained
// <LogTable/> (dates × trackables, historical editing). Mirrors FocusDashboard's
// expand pattern.
function LogTableModal({ onClose }: { onClose: () => void }) {
  // Portal to <body> so it escapes the dashboard's (absolute) stacking context
  // and its z beats the app-wide IconRail — otherwise the rail sits on top of
  // the modal. z 4000 matches ItemEditor's overlay tier.
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 4000,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: FONT,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          width: "min(1120px, 94vw)",
          height: "min(80vh, 640px)",
          borderRadius: 20,
          overflow: "hidden",
          background: "color-mix(in srgb, rgb(var(--gooni-surf, 11 15 13)) 62%, transparent)",
          backdropFilter: "blur(22px)",
          WebkitBackdropFilter: "blur(22px)",
          border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.10)",
          boxShadow: "0 20px 70px rgba(0,0,0,0.55)",
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute",
            top: 12,
            right: 14,
            zIndex: 3,
            width: 26,
            height: 26,
            borderRadius: 8,
            cursor: "pointer",
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.12)",
            background: "rgb(var(--gooni-surf, 11 15 13) / 0.5)",
            color: "rgb(var(--gooni-ink, 244 245 244) / 0.5)",
          }}
        >
          <X size={14} strokeWidth={1.9} />
        </button>
        <LogTable />
      </div>
    </div>,
    document.body,
  );
}

// ── Day timeline (positional: time = vertical position) ─────────────────────────
// Local minutes-since-midnight for an ISO instant. parseUtc handles naive-UTC
// (promise dues) AND tz-aware (gcal/device) inputs.
function minsLocal(iso: string): number {
  const d = parseUtc(iso);
  return d.getHours() * 60 + d.getMinutes();
}

const TL_CHOSEN = "#7b88a6"; // committed/chosen block (gcal) — solid, not grey

const TL_MARKS: Array<[string, string]> = [
  ["0%", "12a"],
  ["25%", "6a"],
  ["50%", "12p"],
  ["75%", "6p"],
  ["100%", "12a"],
];

function TimelineAxis({
  promises,
  deviceEvents,
  onChanged,
  pal,
}: {
  promises: ApiPromise[];
  deviceEvents: StreamEvent[];
  onChanged: () => void;
  pal: (typeof FOCUS_PALETTES)["dark"];
}) {
  const openWidget = useWidgetOverlayStore((s) => s.open);
  const [day, setDay] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [events, setEvents] = useState<CalendarEvent[]>([]);
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

  // Fetch gcal for the viewed day (its own window — the parent's `events` is
  // today-only, for the banner). Device pings stay today-only (ambient; we
  // don't chase the stream window into the past).
  useEffect(() => {
    let cancelled = false;
    const end = addDays(day, 1);
    fetchCalendarEvents(day.toISOString(), end.toISOString())
      .then((e) => {
        if (!cancelled) setEvents(e);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [day, reloadKey]);

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
    setReloadKey((k) => k + 1); // refetch gcal (covers event kind)
    onChanged(); // reload parent promises/banner (covers promise kind)
  };

  // Click an empty slot → open the editor directly, defaulted to "event"; the
  // modal's own toggle flips it to a promise. (No intermediate picker.)
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

  // Drag a finna-do row onto the axis → give the promise a real time on the
  // VIEWED day (not necessarily today).
  const dropSchedule = async (promiseId: number, frac: number) => {
    const mins = Math.round((Math.min(1435, Math.max(0, Math.round(frac * 1440))) / 5)) * 5;
    const when = new Date(day.getTime() + mins * 60000);
    try {
      await patchPromise(promiseId, { due: when.toISOString() });
      onChanged();
    } catch {
      /* ignore */
    }
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* day-nav header + full-calendar jump */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          margin: "0 0 10px",
          flex: "0 0 auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <TLBtn label="Previous day" onClick={() => setDay((d) => addDays(d, -1))} pal={pal}>
            <ChevronLeft size={14} />
          </TLBtn>
          <span
            style={{
              fontSize: 11,
              color: pal.ink3,
              minWidth: 78,
              textAlign: "center",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {dateLabel}
          </span>
          <TLBtn label="Next day" onClick={() => setDay((d) => addDays(d, 1))} pal={pal}>
            <ChevronRight size={14} />
          </TLBtn>
          {!isToday && (
            <button
              onClick={() => {
                const d = new Date();
                d.setHours(0, 0, 0, 0);
                setDay(d);
              }}
              style={{
                marginLeft: 4,
                border: "none",
                background: "transparent",
                color: pal.accent,
                fontSize: 10.5,
                fontFamily: FONT,
                cursor: "pointer",
                padding: 0,
              }}
            >
              today
            </button>
          )}
        </div>
        <TLBtn label="View full calendar" onClick={() => openWidget("calendar")} pal={pal}>
          <CalendarDays size={14} />
        </TLBtn>
      </div>

      {allDay.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8, flex: "0 0 auto" }}>
          {allDay.map((e) => (
            <span
              key={e.id}
              onClick={() => openEditEvent(e)}
              style={{
                fontSize: 9,
                padding: "2px 6px",
                borderRadius: 4,
                background: TL_CHOSEN,
                color: "#fff",
                whiteSpace: "nowrap",
                cursor: "pointer",
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
          const rect = e.currentTarget.getBoundingClientRect();
          dropSchedule(Number(raw), (e.clientY - rect.top) / rect.height);
        }}
        onClick={(e) => {
          if (e.target !== e.currentTarget) return; // only bare track
          const rect = e.currentTarget.getBoundingClientRect();
          openCreate((e.clientY - rect.top) / rect.height);
        }}
        title="click to add · drag a finna-do here to schedule"
        style={{
          position: "relative",
          flex: 1,
          marginLeft: 26,
          borderLeft: `1.5px solid ${pal.rule}`,
          minHeight: 240,
        }}
      >
        {TL_MARKS.map(([top, lbl]) => (
          <div
            key={lbl}
            style={{
              position: "absolute",
              left: -24,
              top,
              transform: "translateY(-50%)",
              fontSize: 8,
              color: pal.ink3,
              pointerEvents: "none",
            }}
          >
            {lbl}
          </div>
        ))}

        {/* now-line — only when viewing today */}
        {isToday && (
          <div
            style={{
              position: "absolute",
              left: -5,
              right: -4,
              top: `${nowFrac}%`,
              borderTop: `2px solid ${NOW_COLOR}`,
              zIndex: 5,
              pointerEvents: "none",
            }}
          >
            <span
              style={{
                position: "absolute",
                left: -3,
                top: -4,
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: NOW_COLOR,
              }}
            />
          </div>
        )}

        {/* chosen (gcal) timed blocks — solid, height = duration, click to edit */}
        {timed.map((e) => {
          const startM = minsLocal(e.start as string);
          const endM = e.end ? minsLocal(e.end) : startM + 30;
          const top = (startM / 1440) * 100;
          const height = ((Math.max(endM, startM + 15) - startM) / 1440) * 100;
          return (
            <div
              key={e.id}
              title={e.summary}
              onClick={(ev) => {
                ev.stopPropagation();
                openEditEvent(e);
              }}
              style={{
                position: "absolute",
                left: 6,
                right: 4,
                top: `${top}%`,
                height: `${height}%`,
                minHeight: 12,
                background: TL_CHOSEN,
                color: "#fff",
                borderRadius: 4,
                padding: "2px 5px",
                fontSize: 8.5,
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
                cursor: "pointer",
              }}
            >
              {e.summary}
            </div>
          );
        })}

        {/* scheduled promises — accent blocks, point-in-time, click to edit */}
        {scheduled.map((p) => {
          const top = (minsLocal(p.inferred_due as string) / 1440) * 100;
          const text = p.summary || p.utterance;
          return (
            <div
              key={`p-${p.id}`}
              title={text}
              onClick={(ev) => {
                ev.stopPropagation();
                openEditPromise(p);
              }}
              style={{
                position: "absolute",
                left: 6,
                right: 4,
                top: `${top}%`,
                minHeight: 14,
                background: pal.accent,
                color: "#fff",
                borderRadius: 4,
                padding: "2px 5px",
                fontSize: 8.5,
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
                cursor: "pointer",
              }}
            >
              {text}
            </div>
          );
        })}

        {/* passive device pings — muted point markers, today only */}
        {isToday &&
          deviceEvents.map((ev, i) => {
            const top = (minsLocal(ev.at) / 1440) * 100;
            return (
              <div
                key={`${ev.label}-${i}`}
                title={`${ev.label} ×${ev.count}`}
                style={{
                  position: "absolute",
                  left: 4,
                  top: `${top}%`,
                  transform: "translateY(-50%)",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  pointerEvents: "none",
                }}
              >
                <span style={{ width: 5, height: 5, borderRadius: "50%", background: pal.ink3 }} />
                <span style={{ fontSize: 8, color: pal.ink3, whiteSpace: "nowrap" }}>
                  {ev.label}
                  {ev.count > 1 ? ` ×${ev.count}` : ""}
                </span>
              </div>
            );
          })}
      </div>

      {editor && (
        <ItemEditor
          editor={editor}
          onChange={setEditor}
          onClose={() => setEditor(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}

// Small square icon button for the timeline header (day nav + full-cal jump).
function TLBtn({
  label,
  onClick,
  pal,
  children,
}: {
  label: string;
  onClick: () => void;
  pal: (typeof FOCUS_PALETTES)["dark"];
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 24,
        height: 24,
        borderRadius: 6,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        color: pal.ink3,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = pal.ink)}
      onMouseLeave={(e) => (e.currentTarget.style.color = pal.ink3)}
    >
      {children}
    </button>
  );
}


// A column-section header: label + optional expand (⤢) affordance. Used to
// split the middle column into "trackables" and "finna do".
function SectionHead({
  label,
  pal,
  onExpand,
  style,
}: {
  label: string;
  pal: (typeof FOCUS_PALETTES)["dark"];
  onExpand?: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: 11,
        letterSpacing: 0.3,
        color: pal.ink3,
        margin: "0 0 8px",
        flex: "0 0 auto",
        ...style,
      }}
    >
      <span>{label}</span>
      {onExpand && (
        <button
          aria-label={`Expand ${label}`}
          title="expand"
          onClick={onExpand}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            borderRadius: 6,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            color: pal.ink3,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = pal.ink)}
          onMouseLeave={(e) => (e.currentTarget.style.color = pal.ink3)}
        >
          <Maximize2 size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

// ── Finna-do: today-only trackable chips + one-off todos ────────────────────────
function FinnaDoBody({
  chips,
  todos,
  pal,
  onToggleBool,
  onCommitNum,
  onAddTodo,
  onCheckTodo,
  onExpandMatrix,
}: {
  chips: Chip[];
  todos: ApiPromise[];
  pal: (typeof FOCUS_PALETTES)["dark"];
  onToggleBool: (c: Chip) => void;
  onCommitNum: (c: Chip, v: number | null) => void;
  onAddTodo: (text: string) => void;
  onCheckTodo: (id: number) => void;
  onExpandMatrix: () => void;
}) {
  const [editId, setEditId] = useState<number | null>(null);
  const [numDraft, setNumDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [todoDraft, setTodoDraft] = useState("");

  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <SectionHead label="trackables" pal={pal} onExpand={onExpandMatrix} />
      {/* trackable chips — single wrapping row, today only */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, flex: "0 0 auto" }}>
        {chips.map((c) => {
          const t = c.t;
          if (t.kind === "boolean") {
            const on = c.today?.value === true;
            return (
              <button
                key={t.id}
                onClick={() => onToggleBool(c)}
                style={{
                  border: `1px solid ${on ? pal.accent : pal.rule}`,
                  background: on ? pal.accent : "transparent",
                  color: on ? "#fff" : pal.ink2,
                  borderRadius: 999,
                  padding: "3px 10px",
                  fontSize: 10.5,
                  fontFamily: FONT,
                  cursor: "pointer",
                }}
              >
                {t.name}
              </button>
            );
          }
          // numeric chip
          const v = c.today?.value;
          const num = typeof v === "number" ? v : null;
          if (editId === t.id) {
            return (
              <input
                key={t.id}
                autoFocus
                value={numDraft}
                inputMode="decimal"
                onChange={(e) => setNumDraft(e.target.value)}
                onBlur={() => {
                  const s = numDraft.trim();
                  onCommitNum(c, s === "" ? null : Number.isNaN(parseFloat(s)) ? num : parseFloat(s));
                  setEditId(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditId(null);
                }}
                style={{
                  width: 66,
                  border: `1px solid ${pal.accent}`,
                  borderRadius: 999,
                  padding: "3px 8px",
                  fontSize: 10.5,
                  fontFamily: FONT,
                  outline: "none",
                  background: pal.paper,
                  color: pal.ink,
                }}
              />
            );
          }
          return (
            <button
              key={t.id}
              onClick={() => {
                setEditId(t.id);
                setNumDraft(num != null ? String(Math.round(num)) : "");
              }}
              style={{
                border: `1px solid ${num != null ? pal.accent : pal.rule}`,
                background: "transparent",
                color: num != null ? pal.ink : pal.ink2,
                borderRadius: 999,
                padding: "3px 10px",
                fontSize: 10.5,
                fontFamily: FONT,
                cursor: "pointer",
              }}
            >
              {t.name}
              {num != null ? ` ${Math.round(num)}${t.unit ? t.unit[0] : ""}` : ""}
            </button>
          );
        })}
        {chips.length === 0 && (
          <span style={{ color: pal.ink3, fontSize: 10.5 }}>no trackables</span>
        )}
      </div>

      <SectionHead label="finna do" pal={pal} style={{ marginTop: 16 }} />
      {/* one-off todos — draggable onto the timeline to schedule */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          minHeight: 0,
          paddingTop: 2,
        }}
      >
        {todos.map((p) => {
          const overdue =
            p.inferred_due != null && !isTodayLocal(p.inferred_due) && parseUtc(p.inferred_due) < startToday;
          return (
            <div
              key={p.id}
              draggable
              onDragStart={(e) => e.dataTransfer.setData("text/promise", String(p.id))}
              title="drag onto the timeline to schedule"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 0",
                borderBottom: `1px solid ${pal.rule}`,
                cursor: "grab",
              }}
            >
              <button
                onClick={() => onCheckTodo(p.id)}
                title="mark kept"
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  border: `1.5px solid ${pal.ink3}`,
                  background: "transparent",
                  cursor: "pointer",
                  flex: "0 0 auto",
                  padding: 0,
                }}
              />
              <span
                style={{
                  flex: 1,
                  fontSize: 11.5,
                  color: overdue ? pal.warn : pal.ink,
                  lineHeight: 1.3,
                }}
              >
                {p.summary || p.utterance}
              </span>
            </div>
          );
        })}
        {todos.length === 0 && (
          <div style={{ color: pal.ink3, fontSize: 11, paddingTop: 2 }}>
            no finna-dos yet
          </div>
        )}
      </div>

      {/* add a one-off */}
      <div style={{ flex: "0 0 auto", marginTop: 8 }}>
        {adding ? (
          <input
            autoFocus
            value={todoDraft}
            onChange={(e) => setTodoDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && todoDraft.trim()) {
                onAddTodo(todoDraft.trim());
                setTodoDraft("");
                setAdding(false);
              }
              if (e.key === "Escape") {
                setTodoDraft("");
                setAdding(false);
              }
            }}
            onBlur={() => {
              if (todoDraft.trim()) onAddTodo(todoDraft.trim());
              setTodoDraft("");
              setAdding(false);
            }}
            placeholder="what needs doing…"
            style={{
              width: "100%",
              border: "none",
              outline: "none",
              background: "transparent",
              color: pal.ink,
              fontFamily: FONT,
              fontSize: 11.5,
            }}
          />
        ) : (
          <button onClick={() => setAdding(true)} style={dashedBtn(pal)}>
            <Plus size={13} /> add finna-do
          </button>
        )}
      </div>
    </div>
  );
}

// ── Note row ──────────────────────────────────────────────────────────────────
function NoteRow({ note, pal }: { note: ApiNote; pal: (typeof FOCUS_PALETTES)["dark"] }) {
  const tag = note.tags?.[0];
  const text = note.title || note.excerpt || "(untitled)";
  return (
    <div style={{ padding: "6px 0", borderBottom: `1px solid ${pal.rule}` }}>
      <div style={{ fontSize: 9, color: pal.ink3, fontVariantNumeric: "tabular-nums" }}>
        {fmtClock(note.created_at)}
      </div>
      <div style={{ fontSize: 11.5, color: pal.ink2, lineHeight: 1.35, marginTop: 1 }}>
        {text}
        {tag ? <span style={{ color: pal.accent, fontSize: 9 }}> · {tag}</span> : null}
      </div>
    </div>
  );
}

// ── Adaptive banner ──────────────────────────────────────────────────────────
// One reactive slot, priority-ranked. Evaluate top-down, render the first that
// applies; each source is null-safe so it can never render empty:
//   1. live focus session       (deferred — focus-cam; slot reserved)
//   2. next commitment          (nearest upcoming gcal event / scheduled promise)
//   3. today's said-vs-done     (kept / resolved + open)
//   4. proactive insight        (deferred — scheduled pass; slot reserved)
//   fallback → the resting date line.
function fmtRel(mins: number): string {
  if (mins < 1) return "now";
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

function Banner({
  events,
  scheduled,
  keptToday,
  brokenToday,
  finnaOpen,
}: {
  pal: (typeof FOCUS_PALETTES)["dark"];
  events: CalendarEvent[];
  scheduled: ApiPromise[];
  keptToday: number;
  brokenToday: number;
  finnaOpen: number;
}) {
  const now = Date.now();

  // Priority 2 — next commitment (things with a real clock time, still ahead).
  const ups: Array<{ at: number; title: string }> = [];
  events.forEach((e) => {
    if (!e.all_day && e.start) {
      const t = new Date(e.start).getTime();
      if (t > now) ups.push({ at: t, title: e.summary });
    }
  });
  scheduled.forEach((p) => {
    if (p.inferred_due) {
      const t = parseUtc(p.inferred_due).getTime();
      if (t > now) ups.push({ at: t, title: p.summary || p.utterance });
    }
  });
  ups.sort((a, b) => a.at - b.at);
  const next = ups[0];

  let kicker: string;
  let task: string;
  let right: React.ReactNode = null;

  if (next) {
    kicker = "up next";
    task = next.title;
    const mins = Math.round((next.at - now) / 60000);
    right = (
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 24, fontWeight: 200, fontVariantNumeric: "tabular-nums" }}>
          {fmtClock(new Date(next.at).toISOString())}
        </div>
        <div style={{ fontSize: 9, opacity: 0.7 }}>{fmtRel(mins)}</div>
      </div>
    );
  } else if (keptToday + brokenToday + finnaOpen > 0) {
    const resolved = keptToday + brokenToday;
    kicker = "today · said vs done";
    task = resolved > 0 ? `${keptToday} of ${resolved} kept` : `${finnaOpen} open`;
    if (resolved > 0 && finnaOpen > 0) {
      right = <div style={{ fontSize: 11, opacity: 0.7 }}>{finnaOpen} open</div>;
    }
  } else {
    kicker = "gooni";
    task = new Date().toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }

  return (
    <div
      style={{
        borderRadius: 12,
        padding: "16px 20px",
        background: BANNER_BG,
        color: BANNER_INK,
        display: "flex",
        alignItems: "center",
        gap: 18,
        minHeight: 64,
        flex: "0 0 auto",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", opacity: 0.6 }}>
          {kicker}
        </div>
        <div
          style={{
            fontSize: 18,
            fontWeight: 600,
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {task}
        </div>
      </div>
      {right}
    </div>
  );
}
