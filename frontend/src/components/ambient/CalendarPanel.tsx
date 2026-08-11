import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import {
  fetchCalendarEvents,
  CalendarNotConnectedError,
  type CalendarEvent,
} from "../../services/api";
import { FONT } from "../../ui";
import {
  startOfWeek,
  addDays,
  dayKeyLocal,
  eventDayKey,
  eventSortKey,
  fmtTime,
  fmtDayLabel,
  fmtRange,
} from "./calendarDates";
import { ItemEditor, type ItemEditorState } from "./ItemEditor";

type LoadState = "loading" | "ready" | "disconnected" | "error";

const GREEN = "rgba(74,222,128,0.9)";

// Full calendar surface: a Monday-anchored week grid you can page ←/→, backed
// by the live Google Calendar. Create by clicking a day (or +), edit/delete by
// clicking an event — all through the shared ItemEditor. Every write refetches.
// (The agenda view was dropped earlier — the week grid is the whole surface.)
//
// RESTORED 2026-08-11 from before the widget purge, rehomed out of
// `components/widgets/` into the ambient surfaces it now lives among. It is
// summoned as a full overlay from the rail (`?calendar=1`) rather than hosted
// by the deleted widget registry — a week grid needs real width, which is also
// why it is not a tab in the 360px log sheet beside the day timeline.
export function CalendarPanel({ onClose }: { onClose: () => void }) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [editor, setEditor] = useState<ItemEditorState | null>(null);

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const todayKey = dayKeyLocal(today);

  const weekStart = useMemo(
    () => addDays(startOfWeek(today), weekOffset * 7),
    [today, weekOffset],
  );
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const startISO = weekStart.toISOString();
  const endISO = addDays(weekStart, 7).toISOString();

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    fetchCalendarEvents(startISO, endISO)
      .then((evs) => {
        if (cancelled) return;
        setEvents(evs);
        setState("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        setState(e instanceof CalendarNotConnectedError ? "disconnected" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, [startISO, endISO, reloadKey]);

  // A write only has to refresh THIS surface now. It used to also `bump()` a
  // shared revision so the deleted home compact would refetch; nothing else
  // reads the calendar live any more.
  const refetch = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  const byDay = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {};
    for (const ev of events) {
      const k = eventDayKey(ev);
      if (!k) continue;
      (map[k] ??= []).push(ev);
    }
    for (const k of Object.keys(map)) map[k].sort((a, b) => eventSortKey(a) - eventSortKey(b));
    return map;
  }, [events]);

  function openCreate(dayKey: string) {
    setEditor({
      kind: "event",
      mode: "create",
      summary: "",
      dayKey,
      startTime: "09:00",
      endTime: "10:00",
      allDay: false,
    });
  }
  function openEdit(ev: CalendarEvent) {
    const key = eventDayKey(ev);
    setEditor({
      kind: "event",
      mode: "edit",
      id: ev.id,
      summary: ev.summary === "(untitled)" ? "" : ev.summary,
      dayKey: key || todayKey,
      startTime: ev.all_day || !ev.start ? "09:00" : hhmm(ev.start),
      endTime: ev.all_day || !ev.end ? "10:00" : hhmm(ev.end),
      allDay: ev.all_day,
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", fontFamily: FONT }}>
      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "14px 16px",
          borderBottom: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.08)",
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.2 }}>Calendar</span>

        <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 4 }}>
          <NavBtn label="Previous week" onClick={() => setWeekOffset((w) => w - 1)}>
            <ChevronLeft size={16} />
          </NavBtn>
          <span
            style={{
              fontSize: 12.5,
              color: "rgb(var(--gooni-ink, 244 245 244) / 0.75)",
              minWidth: 116,
              textAlign: "center",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {fmtRange(weekStart, addDays(weekStart, 6))}
          </span>
          <NavBtn label="Next week" onClick={() => setWeekOffset((w) => w + 1)}>
            <ChevronRight size={16} />
          </NavBtn>
          {weekOffset !== 0 && (
            <button onClick={() => setWeekOffset(0)} style={todayBtnStyle}>
              Today
            </button>
          )}
        </div>

        <div style={{ flex: 1 }} />
        <NavBtn label="Close" onClick={onClose}>
          <X size={17} />
        </NavBtn>
      </div>

      {/* body */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {state === "loading" && <Center>loading…</Center>}
        {state === "error" && <Center>couldn't reach Google Calendar</Center>}
        {state === "disconnected" && (
          <Center>
            Calendar not connected.
            <br />
            <span style={{ color: "rgb(var(--gooni-ink, 244 245 244) / 0.5)", fontSize: 13 }}>
              Connect Google Calendar in Settings ▸ Integrations.
            </span>
          </Center>
        )}

        {state === "ready" && (
          <div style={{ display: "flex", height: "100%" }}>
            {weekDays.map((day) => {
              const key = dayKeyLocal(day);
              const dayEvents = byDay[key] ?? [];
              const isToday = key === todayKey;
              return (
                <div
                  key={key}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    borderRight: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.06)",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <div
                    style={{
                      padding: "8px 6px",
                      textAlign: "center",
                      borderBottom: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.06)",
                    }}
                  >
                    <div style={{ fontSize: 10.5, color: "rgb(var(--gooni-ink, 244 245 244) / 0.45)", textTransform: "uppercase", letterSpacing: 0.4 }}>
                      {fmtDayLabel(day)}
                    </div>
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 600,
                        marginTop: 2,
                        width: 26,
                        height: 26,
                        lineHeight: "26px",
                        borderRadius: "50%",
                        margin: "2px auto 0",
                        color: isToday ? "rgb(var(--gooni-surf, 11 15 13))" : "rgb(var(--gooni-ink, 244 245 244) / 0.85)",
                        background: isToday ? GREEN : "transparent",
                      }}
                    >
                      {day.getDate()}
                    </div>
                  </div>
                  <div
                    onClick={(e) => {
                      if (e.target === e.currentTarget) openCreate(key);
                    }}
                    style={{
                      flex: 1,
                      minHeight: 0,
                      overflowY: "auto",
                      padding: "6px 5px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      cursor: "pointer",
                    }}
                  >
                    {dayEvents.map((ev) => (
                      <EventChip key={ev.id} ev={ev} onClick={() => openEdit(ev)} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* floating add — creates on the first visible day */}
        {state === "ready" && (
          <button
            aria-label="New event"
            onClick={() => openCreate(dayKeyLocal(weekDays[0]))}
            style={fabStyle}
          >
            <Plus size={20} />
          </button>
        )}
      </div>

      {editor && (
        <ItemEditor
          editor={editor}
          onChange={setEditor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            refetch();
          }}
        />
      )}
    </div>
  );
}

// ── bits ────────────────────────────────────────────────────────────────

function EventChip({ ev, onClick }: { ev: CalendarEvent; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={ev.summary}
      style={{
        textAlign: "left",
        border: "none",
        cursor: "pointer",
        borderRadius: 6,
        padding: "4px 6px",
        background: "rgba(74,222,128,0.13)",
        borderLeft: "2px solid rgba(74,222,128,0.7)",
        color: "rgb(var(--gooni-ink, 244 245 244) / 0.92)",
        fontFamily: FONT,
        display: "flex",
        flexDirection: "column",
        gap: 1,
      }}
    >
      {!ev.all_day && (
        <span style={{ fontSize: 9.5, color: "rgba(74,222,128,0.85)", fontVariantNumeric: "tabular-nums" }}>
          {fmtTime(ev.start)}
        </span>
      )}
      <span style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {ev.summary}
      </span>
    </button>
  );
}

function NavBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        borderRadius: 8,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        color: "rgb(var(--gooni-ink, 244 245 244) / 0.7)",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {children}
    </button>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: 4,
        color: "rgb(var(--gooni-ink, 244 245 244) / 0.7)",
        fontSize: 14,
        padding: 24,
      }}
    >
      {children}
    </div>
  );
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const todayBtnStyle: React.CSSProperties = {
  marginLeft: 4,
  border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.2)",
  background: "transparent",
  color: "rgb(var(--gooni-ink, 244 245 244) / 0.7)",
  borderRadius: 999,
  padding: "3px 10px",
  fontSize: 11.5,
  cursor: "pointer",
  fontFamily: FONT,
};

const fabStyle: React.CSSProperties = {
  position: "absolute",
  right: 18,
  bottom: 18,
  width: 44,
  height: 44,
  borderRadius: "50%",
  border: "none",
  cursor: "pointer",
  background: GREEN,
  color: "rgb(var(--gooni-surf, 11 15 13))",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
