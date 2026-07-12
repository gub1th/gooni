import { useEffect, useState } from "react";
import {
  fetchCalendarEvents,
  CalendarNotConnectedError,
  type CalendarEvent,
} from "../../services/api";
import { useWidgetOverlayStore } from "../../stores/useWidgetOverlayStore";
import { addDays, fmtTime, eventSortKey } from "./calendarDates";
import type { WidgetCompactProps } from "./registry";

type LoadState = "loading" | "ready" | "disconnected" | "error";

// The compact home-screen face of the calendar widget: today's date + the next
// few events, with a tap-through to the full week panel. Read-only glance —
// all editing lives in the panel.
export function CalendarCompact({ onExpand }: WidgetCompactProps) {
  const rev = useWidgetOverlayStore((s) => s.rev);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  useEffect(() => {
    let cancelled = false;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = addDays(start, 1);
    setState("loading");
    fetchCalendarEvents(start.toISOString(), end.toISOString())
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
  }, [rev]);

  const dateLabel = new Date().toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const sorted = [...events].sort((a, b) => eventSortKey(a) - eventSortKey(b));
  const shown = sorted.slice(0, 3);
  const extra = sorted.length - shown.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 11, color: "rgba(244,245,244,0.45)", letterSpacing: 0.3 }}>
        {dateLabel}
      </div>

      {state === "loading" && <Muted>…</Muted>}
      {state === "error" && <Muted>couldn't load calendar</Muted>}
      {state === "disconnected" && (
        <Muted>not connected · Settings ▸ Integrations</Muted>
      )}
      {state === "ready" && sorted.length === 0 && <Muted>no events today</Muted>}

      {state === "ready" && shown.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {shown.map((ev) => (
            <div key={ev.id} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span
                style={{
                  fontSize: 10.5,
                  color: "rgba(74,222,128,0.85)",
                  fontVariantNumeric: "tabular-nums",
                  minWidth: 46,
                  flexShrink: 0,
                }}
              >
                {ev.all_day ? "all-day" : fmtTime(ev.start)}
              </span>
              <span
                style={{
                  fontSize: 12.5,
                  color: "rgba(244,245,244,0.9)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {ev.summary}
              </span>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={onExpand}
        style={{
          marginTop: 2,
          alignSelf: "flex-start",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          fontSize: 11,
          color: "rgba(244,245,244,0.5)",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "rgba(74,222,128,0.9)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(244,245,244,0.5)")}
      >
        {extra > 0 ? `+${extra} more · open week ▸` : "open week ▸"}
      </button>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 12, color: "rgba(244,245,244,0.4)" }}>{children}</div>
  );
}
