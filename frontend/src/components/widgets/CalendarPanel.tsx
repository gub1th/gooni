import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Trash2, X } from "lucide-react";
import {
  fetchCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  CalendarNotConnectedError,
  type CalendarEvent,
} from "../../services/api";
import { useWidgetOverlayStore } from "../../stores/useWidgetOverlayStore";
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
  localToIso,
} from "./calendarDates";
import type { WidgetPanelProps } from "./registry";

type LoadState = "loading" | "ready" | "disconnected" | "error";

const GREEN = "rgba(74,222,128,0.9)";

interface EditorState {
  mode: "create" | "edit";
  id?: string;
  summary: string;
  dayKey: string;
  startTime: string;
  endTime: string;
  allDay: boolean; // editing an all-day event → time fields locked
}

// Full calendar surface: a Monday-anchored week grid you can page ←/→, plus a
// flat agenda list, backed by the live Google Calendar. Create by clicking a
// day (or +), edit/delete by clicking an event. Every write refetches and
// bumps the shared rev so the home compact stays in sync.
export function CalendarPanel({ onClose, initialView }: WidgetPanelProps) {
  const bump = useWidgetOverlayStore((s) => s.bump);
  const [view, setView] = useState(initialView);
  const [weekOffset, setWeekOffset] = useState(0);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [editor, setEditor] = useState<EditorState | null>(null);

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

  // Fetch window: the visible week, or today→+14d for the agenda.
  const { startISO, endISO } = useMemo(() => {
    if (view === "week") {
      return { startISO: weekStart.toISOString(), endISO: addDays(weekStart, 7).toISOString() };
    }
    return { startISO: today.toISOString(), endISO: addDays(today, 14).toISOString() };
  }, [view, weekStart, today]);

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

  const refetch = useCallback(() => {
    setReloadKey((k) => k + 1);
    bump();
  }, [bump]);

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
    setEditor({ mode: "create", summary: "", dayKey, startTime: "09:00", endTime: "10:00", allDay: false });
  }
  function openEdit(ev: CalendarEvent) {
    const key = eventDayKey(ev);
    setEditor({
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

        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: "week", label: "Week" },
            { value: "agenda", label: "Agenda" },
          ]}
        />

        {view === "week" && (
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
        )}

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

        {state === "ready" && view === "week" && (
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

        {state === "ready" && view === "agenda" && (
          <AgendaList today={today} byDay={byDay} onEventClick={openEdit} onAdd={openCreate} />
        )}

        {/* floating add — creates on today (week: current day sits in view) */}
        {state === "ready" && (
          <button
            aria-label="New event"
            onClick={() => openCreate(view === "week" ? dayKeyLocal(weekDays[0]) : todayKey)}
            style={fabStyle}
          >
            <Plus size={20} />
          </button>
        )}
      </div>

      {editor && (
        <EventEditor
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

// ── event editor (create / edit / delete) ────────────────────────────────

function EventEditor({
  editor,
  onChange,
  onClose,
  onSaved,
}: {
  editor: EditorState;
  onChange: (e: EditorState) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const summary = editor.summary.trim();
    if (!summary) {
      setErr("Give the event a name");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      if (editor.mode === "create") {
        await createCalendarEvent({
          summary,
          start_iso: localToIso(editor.dayKey, editor.startTime),
          end_iso: localToIso(editor.dayKey, editor.endTime),
        });
      } else if (editor.id) {
        await updateCalendarEvent(editor.id, {
          summary,
          // All-day events keep their span — only rename them here.
          ...(editor.allDay
            ? {}
            : {
                start_iso: localToIso(editor.dayKey, editor.startTime),
                end_iso: localToIso(editor.dayKey, editor.endTime),
              }),
        });
      }
      onSaved();
    } catch {
      setErr("Save failed — try again");
      setSaving(false);
    }
  }

  async function del() {
    if (!editor.id) return;
    setSaving(true);
    setErr(null);
    try {
      await deleteCalendarEvent(editor.id);
      onSaved();
    } catch {
      setErr("Delete failed — try again");
      setSaving(false);
    }
  }

  return (
    <div onClick={onClose} style={editorScrim}>
      <div onClick={(e) => e.stopPropagation()} style={editorCard}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>
          {editor.mode === "create" ? "New event" : "Edit event"}
        </div>

        <input
          autoFocus
          value={editor.summary}
          onChange={(e) => onChange({ ...editor, summary: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder="What's happening?"
          style={editorInput}
        />

        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <label style={fieldLabel}>
            Date
            <input
              type="date"
              value={editor.dayKey}
              disabled={editor.allDay}
              onChange={(e) => onChange({ ...editor, dayKey: e.target.value })}
              style={editorSmall}
            />
          </label>
          {!editor.allDay && (
            <>
              <label style={fieldLabel}>
                Start
                <input
                  type="time"
                  value={editor.startTime}
                  onChange={(e) => onChange({ ...editor, startTime: e.target.value })}
                  style={editorSmall}
                />
              </label>
              <label style={fieldLabel}>
                End
                <input
                  type="time"
                  value={editor.endTime}
                  onChange={(e) => onChange({ ...editor, endTime: e.target.value })}
                  style={editorSmall}
                />
              </label>
            </>
          )}
        </div>

        {editor.allDay && (
          <div style={{ fontSize: 11, color: "rgb(var(--gooni-ink, 244 245 244) / 0.45)", marginTop: 8 }}>
            All-day event — rename only.
          </div>
        )}

        {err && (
          <div style={{ fontSize: 12, color: "#FF6B6B", marginTop: 10 }}>{err}</div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16 }}>
          {editor.mode === "edit" && (
            <button aria-label="Delete event" onClick={del} disabled={saving} style={deleteBtn}>
              <Trash2 size={15} />
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={onClose} disabled={saving} style={ghostBtn}>
            Cancel
          </button>
          <button onClick={save} disabled={saving} style={primaryBtn}>
            {saving ? "…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── agenda ────────────────────────────────────────────────────────────────

function AgendaList({
  today,
  byDay,
  onEventClick,
  onAdd,
}: {
  today: Date;
  byDay: Record<string, CalendarEvent[]>;
  onEventClick: (ev: CalendarEvent) => void;
  onAdd: (dayKey: string) => void;
}) {
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i)).filter(
    (d) => (byDay[dayKeyLocal(d)] ?? []).length > 0,
  );
  if (days.length === 0) return <Center>nothing scheduled in the next two weeks</Center>;
  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "12px 18px 24px" }}>
      {days.map((d) => {
        const key = dayKeyLocal(d);
        return (
          <div key={key} style={{ marginBottom: 18 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                fontWeight: 600,
                color: "rgb(var(--gooni-ink, 244 245 244) / 0.6)",
                marginBottom: 8,
              }}
            >
              {d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}
              <button aria-label="Add on this day" onClick={() => onAdd(key)} style={agendaAddBtn}>
                <Plus size={13} />
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {(byDay[key] ?? []).map((ev) => (
                <button key={ev.id} onClick={() => onEventClick(ev)} style={agendaRow}>
                  <span style={{ color: GREEN, fontSize: 12, minWidth: 66, textAlign: "left" }}>
                    {ev.all_day ? "all-day" : fmtTime(ev.start)}
                  </span>
                  <span style={{ fontSize: 13.5 }}>{ev.summary}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
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

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div style={{ display: "flex", gap: 2, background: "rgb(var(--gooni-ink, 244 245 244) / 0.07)", borderRadius: 8, padding: 2 }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            style={{
              border: "none",
              cursor: "pointer",
              fontFamily: FONT,
              fontSize: 12,
              fontWeight: active ? 600 : 500,
              padding: "4px 12px",
              borderRadius: 6,
              color: active ? "rgb(var(--gooni-surf, 11 15 13))" : "rgb(var(--gooni-ink, 244 245 244) / 0.7)",
              background: active ? GREEN : "transparent",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
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
  boxShadow: "0 8px 24px rgba(74,222,128,0.3)",
};

const editorScrim: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 5,
};

const editorCard: React.CSSProperties = {
  width: 360,
  maxWidth: "calc(100% - 40px)",
  background: "#121715",
  border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.14)",
  borderRadius: 14,
  padding: "18px 18px 16px",
  boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
  fontFamily: FONT,
};

const editorInput: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "rgb(var(--gooni-ink, 244 245 244) / 0.06)",
  border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.14)",
  borderRadius: 8,
  padding: "9px 11px",
  color: "rgb(var(--gooni-ink, 244 245 244))",
  fontFamily: FONT,
  fontSize: 14,
  outline: "none",
};

const editorSmall: React.CSSProperties = {
  ...editorInput,
  fontSize: 12.5,
  padding: "7px 9px",
  colorScheme: "dark",
};

const fieldLabel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 10.5,
  color: "rgb(var(--gooni-ink, 244 245 244) / 0.5)",
  textTransform: "uppercase",
  letterSpacing: 0.4,
  flex: 1,
};

const primaryBtn: React.CSSProperties = {
  border: "none",
  cursor: "pointer",
  background: GREEN,
  color: "rgb(var(--gooni-surf, 11 15 13))",
  fontWeight: 600,
  borderRadius: 8,
  padding: "7px 16px",
  fontSize: 13,
  fontFamily: FONT,
};

const ghostBtn: React.CSSProperties = {
  border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.18)",
  cursor: "pointer",
  background: "transparent",
  color: "rgb(var(--gooni-ink, 244 245 244) / 0.75)",
  borderRadius: 8,
  padding: "7px 14px",
  fontSize: 13,
  fontFamily: FONT,
};

const deleteBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  borderRadius: 8,
  border: "1px solid rgba(255,107,107,0.3)",
  background: "transparent",
  color: "#FF6B6B",
  cursor: "pointer",
};

const agendaRow: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 10,
  textAlign: "left",
  border: "none",
  background: "rgb(var(--gooni-ink, 244 245 244) / 0.04)",
  borderRadius: 8,
  padding: "8px 12px",
  cursor: "pointer",
  color: "rgb(var(--gooni-ink, 244 245 244) / 0.9)",
  fontFamily: FONT,
};

const agendaAddBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  borderRadius: 6,
  border: "none",
  background: "rgb(var(--gooni-ink, 244 245 244) / 0.08)",
  color: "rgb(var(--gooni-ink, 244 245 244) / 0.6)",
  cursor: "pointer",
};
