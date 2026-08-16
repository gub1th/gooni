import { FONT } from "../../ui";
import { FOCUS_PALETTES } from "./focusPalette";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { fmtMinutes } from "../../services/focusTime";

// The richer post-session breakdown. Replaces what used to be nothing —
// `endFocusSession` just cleared the session and the view fell straight back
// to `GooniAsleep`. This is deliberately built ONLY from data the session
// itself produced (segments, evidence frames it triggered) rather than any
// invented score: the house rule is deterministic-over-LLM for anything
// user-facing that ranks or summarizes, and there is no model call here at all.

export interface RecapDay {
  date: string;
  minutes: number;
  truncated: boolean;
}

/** One closed focus run, as epoch ms relative to the session's own span. */
export interface RecapTimelineSegment {
  start: number;
  end: number;
  truncated: boolean;
}

export interface SessionRecapData {
  title: string;
  totalMinutes: number;
  /** wall-clock length of the whole sitting, focus + pauses */
  spanMs: number;
  spanStart: number;
  spanEnd: number;
  perDay: RecapDay[];
  timeline: RecapTimelineSegment[];
  eventsByKind: Record<string, number>;
  completionFrame: string | null;
}

const KIND_LABEL: Record<string, string> = {
  phone: "phone",
  vape: "vape",
  distracted: "distracted",
  stand: "stood up",
  left_desk: "left desk",
};

interface Props {
  recap: SessionRecapData;
  onClose: () => void;
}

export function FocusSessionRecap({ recap, onClose }: Props) {
  const theme = useGooniThemeStore((s) => s.theme);
  const pal = FOCUS_PALETTES[theme];

  // Milliseconds throughout, not pre-rounded minutes — a sub-minute span
  // floored up to "1m" would manufacture a phantom "paused 1m" out of a
  // session that never paused at all.
  const focusedMs = recap.totalMinutes * 60_000;
  const pausedMinutes = Math.max(0, (recap.spanMs - focusedMs) / 60_000);
  const focusPct =
    recap.spanMs > 0 ? Math.min(100, Math.round((focusedMs / recap.spanMs) * 100)) : 0;

  const eventEntries = Object.entries(recap.eventsByKind).filter(([, n]) => n > 0);
  const totalEvents = eventEntries.reduce((n, [, v]) => n + v, 0);

  return (
    <div
      style={{
        position: "relative", width: "100%", height: "100%", overflowY: "auto",
        fontFamily: FONT, color: pal.ink,
        display: "flex", flexDirection: "column", alignItems: "center",
        padding: "48px 24px 40px",
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", color: pal.ink3 }}>
        SESSION ENDED
      </div>
      <div style={{ fontSize: 22, fontWeight: 500, marginTop: 6, maxWidth: "26ch", textAlign: "center" }}>
        {recap.title}
      </div>
      <div style={{ fontSize: 15, color: pal.ink2, marginTop: 4 }}>{fmtMinutes(recap.totalMinutes)} focused</div>

      {recap.completionFrame && (
        <img
          src={recap.completionFrame}
          alt=""
          style={{
            marginTop: 22, width: 132, height: 99, objectFit: "cover",
            borderRadius: 12, border: `1px solid ${pal.rule}`, boxShadow: pal.liftSm,
          }}
        />
      )}

      {/* time distribution — focused vs paused across the whole sitting */}
      <div style={{ width: "100%", maxWidth: 420, marginTop: 28 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", color: pal.ink3, marginBottom: 8 }}>
          TIME DISTRIBUTION
        </div>
        <div style={{ display: "flex", height: 10, borderRadius: 999, overflow: "hidden", background: pal.rule }}>
          <div style={{ width: `${focusPct}%`, background: pal.accent }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: pal.ink3, marginTop: 6 }}>
          <span>focused {fmtMinutes(recap.totalMinutes)} ({focusPct}%)</span>
          {Math.round(pausedMinutes) > 0 && <span>paused {fmtMinutes(pausedMinutes)}</span>}
        </div>

        {/* focus-over-time strip — literally the closed runs laid across the
            session's own span, not a fabricated score */}
        {recap.timeline.length > 0 && recap.spanEnd > recap.spanStart && (
          <div style={{ position: "relative", height: 16, marginTop: 12, background: pal.rule, borderRadius: 4 }}>
            {recap.timeline.map((seg, i) => {
              const span = recap.spanEnd - recap.spanStart || 1;
              const left = ((seg.start - recap.spanStart) / span) * 100;
              const width = Math.max(0.6, ((seg.end - seg.start) / span) * 100);
              return (
                <div
                  key={i}
                  title={seg.truncated ? "capped run" : undefined}
                  style={{
                    position: "absolute", top: 0, bottom: 0,
                    left: `${left}%`, width: `${width}%`,
                    background: seg.truncated ? pal.warn : pal.accent,
                    borderRadius: 3,
                  }}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* per-day breakdown — only shown when it says something a single number
          doesn't (a session that crossed midnight) */}
      {recap.perDay.length > 1 && (
        <div style={{ width: "100%", maxWidth: 420, marginTop: 24 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", color: pal.ink3, marginBottom: 8 }}>
            BY DAY
          </div>
          {recap.perDay.map((d) => (
            <div key={d.date} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0", color: pal.ink2 }}>
              <span>{d.date}{d.truncated ? " (capped)" : ""}</span>
              <span>{fmtMinutes(d.minutes)}</span>
            </div>
          ))}
        </div>
      )}

      {/* detection events — what the camera flagged, if anything */}
      <div style={{ width: "100%", maxWidth: 420, marginTop: 24 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", color: pal.ink3, marginBottom: 8 }}>
          DETECTION EVENTS
        </div>
        {totalEvents === 0 ? (
          <div style={{ fontSize: 12.5, color: pal.ink3 }}>nothing flagged</div>
        ) : (
          eventEntries.map(([kind, n]) => (
            <div key={kind} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0", color: pal.ink2 }}>
              <span>{KIND_LABEL[kind] ?? kind}</span>
              <span>{n}</span>
            </div>
          ))
        )}
      </div>

      <button
        onClick={onClose}
        style={{
          marginTop: 32, border: `1px solid ${pal.rule}`, background: "transparent", cursor: "pointer",
          borderRadius: 999, padding: "8px 18px", fontFamily: FONT, fontSize: 12, color: pal.ink2,
        }}
      >
        close
      </button>
    </div>
  );
}
