import { FONT } from "../../ui";
import { FOCUS_PALETTES } from "./focusPalette";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { fmtDuration, fmtMinutes } from "../../services/focusTime";
import {
  type FocusTimelineSegment,
  type SessionCountRow,
  type SessionEvidence,
  type SessionNameRow,
} from "../../services/api";

// The richer post-session breakdown. Replaces what used to be nothing —
// `endFocusSession` just cleared the session and the view fell straight back
// to `GooniAsleep`. This is deliberately built ONLY from data the session
// itself produced (segments, and what the sensors recorded inside its window)
// rather than any invented score: the house rule is deterministic-over-LLM for
// anything user-facing that ranks or summarizes, and there is no model call
// here at all.
//
// The sensor half is session-scoped (`GET /focus/session-activity` over the
// session's exact `[start, stop)`). It used to fold `/focus/cam/evidence` — a
// table nothing writes to yet — which is why it said "nothing flagged" through
// sessions the camera had been firing all the way through.

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
  /** Camera detections that fired INSIDE the session window, by kind. */
  eventsByKind: Record<string, number>;
  /** Kept evidence frames from the same window, newest first. */
  evidence: SessionEvidence[];
  /** Ranked hosts / apps / phone events for the window. */
  browser: SessionNameRow[];
  apps: SessionNameRow[];
  device: SessionCountRow[];
  /** Seconds the ranked heads above are NOT showing, per layer. Kept apart
   *  rather than summed: the browser IS one of the apps, so one number over
   *  both would claim more hidden time than there is. */
  browserOtherSec: number;
  appOtherSec: number;
  /** Union of both interval layers over the window, or `null` when the read
   *  FAILED — distinct from `0`, which means the sensors genuinely saw nothing.
   *  The two get different copy, because they are opposite claims. */
  observedSeconds: number | null;
  /** Caps that bit on the activity read — shown rather than silently applied. */
  warnings: string[];
  completionFrame: string | null;

  // ── the score (2026-08-16) ───────────────────────────────────────────────
  /**
   * Share of OBSERVED session time that was focus, from the sensors.
   *
   * **`null` is a real answer and must render as "not measured".** What this
   * replaced as the headline was `focused_ms / span_ms` — timer state wearing a
   * percentage, which reported 91% for an hour spent at a whiteboard. A score
   * that is high whenever the clock ran is a score nobody can act on.
   * `undefined` means the activity read failed or wasn't scored, which gets
   * different copy again: unknown, not unmeasured.
   */
  focusScore?: number | null;
  /** camera-only — how much of the WATCHED time he was at the desk */
  presencePct?: number | null;
  /** which sensors the score rests on, e.g. ["camera","device"] */
  scoreBasis?: string[];
  /** how much of the session any sensor watched */
  scoreCoverage?: number | null;
  /** the sensor states across the session, plus the pauses between runs */
  sensorTimeline?: FocusTimelineSegment[];
}

/** What each timeline state means, and what colour says it. */
const STATE_LABEL: Record<string, string> = {
  focused: "focused",
  distracted: "distracted",
  away: "away from desk",
  active: "at the machine",
  unobserved: "not observed",
  paused: "paused",
};

function stateColor(state: string, pal: { accent: string; warn: string; rule: string; event: string }): string {
  if (state === "focused") return pal.accent;
  if (state === "active") return pal.event;
  if (state === "distracted" || state === "away") return pal.warn;
  // unobserved / paused — the absence of a signal, never a verdict
  return pal.rule;
}

const KIND_LABEL: Record<string, string> = {
  phone: "phone",
  vape: "vape",
  distracted: "distracted",
  stand: "stood up",
  left_desk: "left desk",
};

function timeLabel(iso: string | null): string {
  const d = iso ? new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** One name/value line. Three sections render the same row, so it is one
 *  component rather than three copies of the same flex rule. */
function Row({
  pal,
  left,
  right,
}: {
  pal: (typeof FOCUS_PALETTES)[keyof typeof FOCUS_PALETTES];
  left: string;
  right: string;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, padding: "3px 0", color: pal.ink2 }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{left}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{right}</span>
    </div>
  );
}

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

  const scored = recap.focusScore !== undefined;
  const sensorTimeline = recap.sensorTimeline ?? [];
  const sensorSpan = sensorTimeline.length
    ? Date.parse(sensorTimeline[sensorTimeline.length - 1].end) -
      Date.parse(sensorTimeline[0].start)
    : 0;

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

      {/* FOCUS SCORE — from the sensors, or plainly absent. The old headline
          was `focused_ms / span_ms`: timer state wearing a percentage, high
          whenever the clock ran. This one is null when nothing watched. */}
      <div style={{ width: "100%", maxWidth: 420, marginTop: 28 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", color: pal.ink3, marginBottom: 8 }}>
          FOCUS SCORE
        </div>
        {!scored ? (
          <div style={{ fontSize: 12.5, color: pal.ink3 }}>
            breakdown unavailable — showing the timer's own record below
          </div>
        ) : recap.focusScore == null ? (
          <div style={{ fontSize: 12.5, color: pal.ink3 }}>
            not measured — no camera or device activity during this session
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 34, fontWeight: 500, letterSpacing: "-0.03em", fontVariantNumeric: "tabular-nums" }}>
                {recap.focusScore}%
              </span>
              <span style={{ fontSize: 11.5, color: pal.ink3 }}>
                from {(recap.scoreBasis ?? []).join(" + ") || "no sensors"}
              </span>
            </div>
            <div style={{ display: "flex", height: 10, borderRadius: 999, overflow: "hidden", background: pal.rule, marginTop: 8 }}>
              <div style={{ width: `${recap.focusScore}%`, background: pal.accent }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: pal.ink3, marginTop: 6 }}>
              <span>
                {recap.presencePct != null ? `${recap.presencePct}% at the desk` : "presence not measured"}
              </span>
              {/* A claim about the SENSORS, not about Daniel — the same rule
                  `coverage` follows one section down. */}
              {recap.scoreCoverage != null && recap.scoreCoverage < 1 && (
                <span>{Math.round(recap.scoreCoverage * 100)}% of it was watched</span>
              )}
            </div>
          </>
        )}

        {/* THE timeline bar: the sensor states laid across the session. */}
        {sensorTimeline.length > 0 && sensorSpan > 0 && (
          <>
            <div style={{ position: "relative", height: 16, marginTop: 14, background: pal.rule, borderRadius: 4, overflow: "hidden" }}>
              {sensorTimeline.map((seg, i) => {
                const left = ((Date.parse(seg.start) - Date.parse(sensorTimeline[0].start)) / sensorSpan) * 100;
                const width = Math.max(0.6, ((Date.parse(seg.end) - Date.parse(seg.start)) / sensorSpan) * 100);
                return (
                  <div
                    key={i}
                    title={`${STATE_LABEL[seg.state] ?? seg.state} · ${fmtDuration(seg.seconds)}`}
                    style={{
                      position: "absolute", top: 0, bottom: 0,
                      left: `${left}%`, width: `${width}%`,
                      background: stateColor(seg.state, pal),
                    }}
                  />
                );
              })}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 10.5, color: pal.ink3, marginTop: 7 }}>
              {[...new Set(sensorTimeline.map((seg) => seg.state))].map((state) => (
                <span key={state} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <i style={{ width: 8, height: 8, borderRadius: 2, background: stateColor(state, pal), display: "inline-block" }} />
                  {STATE_LABEL[state] ?? state}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {/* time distribution — focused vs paused across the whole sitting */}
      <div style={{ width: "100%", maxWidth: 420, marginTop: 24 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", color: pal.ink3, marginBottom: 8 }}>
          TIME DISTRIBUTION
        </div>
        <div style={{ display: "flex", height: 10, borderRadius: 999, overflow: "hidden", background: pal.rule }}>
          <div style={{ width: `${focusPct}%`, background: pal.accent }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: pal.ink3, marginTop: 6 }}>
          {/* Deliberately NOT labelled a focus percentage any more — it is the
              share of the sitting the clock was running, which is a fact about
              the timer. The score above is the one about the work. */}
          <span>focused {fmtMinutes(recap.totalMinutes)} of {fmtDuration(recap.spanMs / 1000)}</span>
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

      {/* what you were on — hosts and apps observed INSIDE the session window,
          straight off the sensors. No percentage, no verdict: the same line
          `focus_attribution` and `activity_context` both refuse to cross. */}
      {(recap.browser.length > 0 || recap.apps.length > 0) && (
        <div style={{ width: "100%", maxWidth: 420, marginTop: 24 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", color: pal.ink3, marginBottom: 8 }}>
            WHAT THE SENSORS SAW
          </div>
          {recap.browser.map((r) => (
            <Row key={`b-${r.name}`} pal={pal} left={r.label} right={fmtDuration(r.seconds)} />
          ))}
          {recap.apps.map((r) => (
            <Row key={`a-${r.name}`} pal={pal} left={r.label} right={fmtDuration(r.seconds)} />
          ))}
          {/* A truncated head read as the whole is how "that's everything"
              becomes a lie — so each layer's tail says how much it is hiding. */}
          {recap.browserOtherSec > 0 && (
            <div style={{ fontSize: 11, color: pal.ink3, marginTop: 4 }}>
              + {fmtDuration(recap.browserOtherSec)} across other sites
            </div>
          )}
          {recap.appOtherSec > 0 && (
            <div style={{ fontSize: 11, color: pal.ink3, marginTop: 2 }}>
              + {fmtDuration(recap.appOtherSec)} across other apps
            </div>
          )}
        </div>
      )}

      {/* phone — pre-aggregated device pings that landed inside the window */}
      {recap.device.length > 0 && (
        <div style={{ width: "100%", maxWidth: 420, marginTop: 24 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", color: pal.ink3, marginBottom: 8 }}>
            PHONE
          </div>
          {recap.device.map((d) => (
            <Row key={d.name} pal={pal} left={d.label} right={String(d.count)} />
          ))}
        </div>
      )}

      {/* detection events — what the camera flagged, if anything */}
      <div style={{ width: "100%", maxWidth: 420, marginTop: 24 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", color: pal.ink3, marginBottom: 8 }}>
          DETECTION EVENTS
        </div>
        {totalEvents === 0 ? (
          // "nothing flagged" is a claim about the CAMERA, and an unreachable
          // server is not evidence for it — so a failed read says so instead.
          <div style={{ fontSize: 12.5, color: pal.ink3 }}>
            {recap.observedSeconds == null ? "couldn't read the sensors" : "nothing flagged"}
          </div>
        ) : (
          eventEntries.map(([kind, n]) => (
            <Row key={kind} pal={pal} left={KIND_LABEL[kind] ?? kind} right={String(n)} />
          ))
        )}
        {recap.evidence.length > 0 && (
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            {recap.evidence.slice(0, 8).map((it) =>
              it.frame ? (
                <img
                  key={it.id}
                  src={it.frame}
                  alt={KIND_LABEL[it.kind ?? ""] ?? it.kind ?? "evidence"}
                  title={`${KIND_LABEL[it.kind ?? ""] ?? it.kind ?? ""} · ${timeLabel(it.at)}`}
                  style={{
                    width: 72, height: 54, objectFit: "cover",
                    borderRadius: 8, border: `1px solid ${pal.rule}`,
                  }}
                />
              ) : null,
            )}
          </div>
        )}
      </div>

      {/* Observed ≠ elapsed. An uninstalled extension and a genuinely quiet
          session are the same rows and opposite claims, so this states what the
          SENSORS covered rather than letting the numbers above imply it. */}
      {recap.observedSeconds != null && recap.spanMs > 0 && (
        <div style={{ fontSize: 11, color: pal.ink3, marginTop: 18, maxWidth: 420, textAlign: "center" }}>
          {recap.observedSeconds > 0
            ? `sensors observed ${fmtDuration(recap.observedSeconds)} of this session`
            : "no device activity recorded during this session (sensors may be off)"}
        </div>
      )}
      {recap.warnings.map((w) => (
        <div key={w} style={{ fontSize: 10.5, color: pal.ink3, marginTop: 6, maxWidth: 420, textAlign: "center" }}>
          {w}
        </div>
      ))}

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
