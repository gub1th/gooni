import { useState, type ReactNode } from "react";
import { FONT } from "../../ui";
import { FOCUS_PALETTES } from "./focusPalette";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { fmtDuration, fmtMinutes } from "../../services/focusTime";
import { scoreTier, focusFractionSeries } from "../../services/focusScore";
import { kindLabel } from "./focusDetectionKinds";
import {
  FocusScoreRing,
  FocusTimelineBar,
  RecapBarChart,
  FocusOverTimeChart,
  scoreColor,
} from "./RecapCharts";
import {
  type FocusTimelineSegment,
  type SessionCountRow,
  type SessionEvidence,
  type SessionNameRow,
} from "../../services/api";

// The post-session analytics dashboard. Replaces what used to be nothing —
// `endFocusSession` just cleared the session and the view fell straight back
// to `GooniAsleep`.
//
// The SCORE (2026-08-16, #526) is server-computed now — `focus_session_
// activity` classifies every second of the session from camera presence,
// camera events and device intervals, not `focused_ms / span_ms` (timer state
// wearing a percentage, which reported 91% for an hour at a whiteboard). This
// component renders it; it does not invent one. `focusScore.ts` keeps only the
// two pure helpers that ARE still ours to compute: `scoreTier` (bucketing a
// number into a ring colour — the number is real, the bucket is just paint)
// and `focusFractionSeries` (the binning fold behind the "focus over time"
// chart, reused for both the real sensor timeline and the client-only
// fallback below).
//
// Everything else here is still built from data the session itself produced
// (its own closed runs) and what the sensors recorded inside its exact
// window (`GET /focus/session-activity` over the session's `[start, stop)`).

export interface RecapDay {
  date: string;
  minutes: number;
  truncated: boolean;
}

/** One closed focus run, as epoch ms relative to the session's own span. Used
 *  only as the FALLBACK timeline/chart source for a session with no real
 *  sensor timeline (an older entry, or a session nothing observed). */
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

/** What each real sensor state means, and what colour says it — green/present
 *  states read as progress, amber/red states read as a lapse, and an absence
 *  of signal (`unobserved`/`paused`) is drawn as the track itself: it is not
 *  a verdict either way. */
const STATE_LABEL: Record<string, string> = {
  focused: "focused",
  distracted: "distracted",
  away: "away from desk",
  active: "at the machine",
  unobserved: "not observed",
  paused: "paused",
};

function stateColor(
  state: string,
  pal: { accent: string; warn: string; rule: string; event: string },
): string {
  if (state === "focused") return pal.accent;
  if (state === "active") return pal.event;
  if (state === "distracted" || state === "away") return pal.warn;
  return pal.rule;
}

function timeLabel(iso: string | null): string {
  const d = iso ? new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** A section shell — the label + card every panel below shares, so the grid
 *  reads as one dashboard rather than a pile of differently-dressed boxes. */
function Panel({
  pal,
  title,
  children,
  span = 1,
}: {
  pal: (typeof FOCUS_PALETTES)[keyof typeof FOCUS_PALETTES];
  title: string;
  children: ReactNode;
  span?: 1 | 2;
}) {
  return (
    <div
      style={{
        gridColumn: span === 2 ? "span 2" : undefined,
        background: pal.card, border: `1px solid ${pal.rule}`, borderRadius: 14,
        padding: "18px 20px", boxShadow: pal.liftSm,
      }}
    >
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", color: pal.ink3, marginBottom: 12 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

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
  const [enlarged, setEnlarged] = useState<SessionEvidence | null>(null);

  const focusedMs = recap.totalMinutes * 60_000;
  const pausedMinutes = Math.max(0, (recap.spanMs - focusedMs) / 60_000);

  const eventEntries = Object.entries(recap.eventsByKind).filter(([, n]) => n > 0);
  const totalEvents = eventEntries.reduce((n, [, v]) => n + v, 0);

  // `undefined` (no scored read) and `null` (scored, nothing observed) are
  // different answers — see the field doc above.
  const scored = recap.focusScore !== undefined;
  const sensorTimeline = recap.sensorTimeline ?? [];
  const sensorSpan = sensorTimeline.length
    ? Date.parse(sensorTimeline[sensorTimeline.length - 1].end) - Date.parse(sensorTimeline[0].start)
    : 0;
  const hasSensorTimeline = sensorTimeline.length > 0 && sensorSpan > 0;
  const tier = scoreTier(recap.focusScore ?? 0);

  // Focus-over-time chart: prefer the REAL sensor states (weight the
  // `focused` spans, everything else reads 0), falling back to the client's
  // own closed runs when there is no sensor timeline for this session.
  const series = hasSensorTimeline
    ? focusFractionSeries(
        Date.parse(sensorTimeline[0].start),
        Date.parse(sensorTimeline[sensorTimeline.length - 1].end),
        sensorTimeline
          .filter((s) => s.state === "focused")
          .map((s) => ({ start: Date.parse(s.start), end: Date.parse(s.end) })),
      )
    : focusFractionSeries(recap.spanStart, recap.spanEnd, recap.timeline);

  const markers = recap.evidence
    .map((it) => {
      const d = it.at ? new Date(it.at.endsWith("Z") || it.at.includes("+") ? it.at : `${it.at}Z`) : null;
      return d && !Number.isNaN(d.getTime()) && it.kind ? { at: d.getTime(), kind: it.kind } : null;
    })
    .filter((m): m is { at: number; kind: string } => m != null);

  const siteBars = recap.browser.map((r) => ({ key: r.name, label: r.label, value: r.seconds }));
  const appBars = recap.apps.map((r) => ({ key: r.name, label: r.label, value: r.seconds }));
  const deviceBars = recap.device.map((r) => ({ key: r.name, label: r.label, value: r.count }));
  const eventBars = eventEntries.map(([kind, n]) => ({ key: kind, label: kindLabel(kind), value: n }));

  return (
    <div
      style={{
        position: "relative", width: "100%", height: "100%", overflowY: "auto",
        fontFamily: FONT, color: pal.ink, background: pal.paper,
        padding: "36px 28px 56px",
      }}
    >
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        {/* header — title, duration, close, and the completion selfie as a
            banner rather than a small thumbnail buried in the flow */}
        <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
          {recap.completionFrame && (
            <img
              src={recap.completionFrame}
              alt=""
              style={{
                width: 96, height: 96, objectFit: "cover", borderRadius: 14,
                border: `1px solid ${pal.rule}`, boxShadow: pal.liftSm, flexShrink: 0,
              }}
            />
          )}
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", color: pal.ink3 }}>
              SESSION ENDED
            </div>
            <div style={{ fontSize: 24, fontWeight: 500, marginTop: 4 }}>{recap.title}</div>
            <div style={{ fontSize: 14, color: pal.ink2, marginTop: 2 }}>
              {/* Deliberately NOT a focus percentage — that's the share of the
                  sitting the clock was running, a fact about the timer. The
                  score panel below is the one about the work. */}
              {fmtMinutes(recap.totalMinutes)} focused of {fmtDuration(Math.max(0, recap.spanMs) / 1000)}
              {Math.round(pausedMinutes) > 0 ? ` · ${fmtMinutes(pausedMinutes)} paused` : ""}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              border: `1px solid ${pal.rule}`, background: "transparent", cursor: "pointer",
              borderRadius: 999, padding: "8px 18px", fontFamily: FONT, fontSize: 12, color: pal.ink2,
              alignSelf: "flex-start",
            }}
          >
            close
          </button>
        </div>

        {/* dashboard grid */}
        <div
          style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 16, marginTop: 28,
          }}
        >
          {/* FOCUS SCORE — from the sensors, or plainly absent. The old
              headline was `focused_ms / span_ms`: timer state wearing a
              percentage, high whenever the clock simply ran. This one is
              null when nothing watched, and undefined when nothing scored
              the read at all — two different kinds of "no number". */}
          <Panel pal={pal} title="FOCUS SCORE">
            <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
              <FocusScoreRing score={scored ? (recap.focusScore ?? null) : null} tier={tier} pal={pal} />
              <div style={{ flex: 1, minWidth: 0 }}>
                {!scored ? (
                  <div style={{ fontSize: 12.5, color: pal.ink3 }}>
                    breakdown unavailable — the timer&apos;s own record is below
                  </div>
                ) : recap.focusScore == null ? (
                  <div style={{ fontSize: 12.5, color: pal.ink3 }}>
                    not measured — no camera or device activity during this session
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 12.5, color: pal.ink2 }}>
                      from {(recap.scoreBasis ?? []).join(" + ") || "no sensors"}
                    </div>
                    <div style={{ fontSize: 11.5, color: pal.ink3, marginTop: 4 }}>
                      {recap.presencePct != null ? `${recap.presencePct}% at the desk` : "presence not measured"}
                    </div>
                    {/* A claim about the SENSORS, not about Daniel. */}
                    {recap.scoreCoverage != null && recap.scoreCoverage < 1 && (
                      <div style={{ fontSize: 11, color: pal.ink3, marginTop: 2 }}>
                        {Math.round(recap.scoreCoverage * 100)}% of it was watched
                      </div>
                    )}
                  </>
                )}
                {totalEvents > 0 && (
                  <div style={{ fontSize: 11.5, color: scoreColor(tier, pal), marginTop: 6 }}>
                    {totalEvents} distraction{totalEvents === 1 ? "" : "s"} flagged
                  </div>
                )}
              </div>
            </div>
          </Panel>

          {/* focus over time */}
          <Panel pal={pal} title="FOCUS OVER TIME">
            {series.length > 0 ? (
              <FocusOverTimeChart series={series} pal={pal} />
            ) : (
              <div style={{ fontSize: 12, color: pal.ink3 }}>not enough span to chart</div>
            )}
          </Panel>

          {/* timeline — the REAL sensor states when they exist (focused /
              distracted / away / active / unobserved / paused, straight off
              `focus_session_activity`); falls back to the client's own closed
              runs + evidence ticks for a session with no sensor timeline. */}
          <Panel pal={pal} title="TIMELINE" span={2}>
            {hasSensorTimeline ? (
              <div>
                <div style={{ position: "relative", height: 22, background: pal.rule, borderRadius: 6, overflow: "hidden" }}>
                  {sensorTimeline.map((seg, i) => {
                    const left = ((Date.parse(seg.start) - Date.parse(sensorTimeline[0].start)) / sensorSpan) * 100;
                    const width = Math.max(0.5, ((Date.parse(seg.end) - Date.parse(seg.start)) / sensorSpan) * 100);
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
                <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 8, fontSize: 10.5, color: pal.ink3 }}>
                  {[...new Set(sensorTimeline.map((seg) => seg.state))].map((state) => (
                    <span key={state} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <i style={{ width: 8, height: 8, borderRadius: 2, background: stateColor(state, pal), display: "inline-block" }} />
                      {STATE_LABEL[state] ?? state}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <FocusTimelineBar
                spanStart={recap.spanStart}
                spanEnd={recap.spanEnd}
                focusSegments={recap.timeline}
                markers={markers}
                pal={pal}
              />
            )}
          </Panel>

          {/* per-day breakdown — only shown when it says something a single
              number doesn't (a session that crossed midnight) */}
          {recap.perDay.length > 1 && (
            <Panel pal={pal} title="BY DAY">
              {recap.perDay.map((d) => (
                <Row key={d.date} pal={pal} left={`${d.date}${d.truncated ? " (capped)" : ""}`} right={fmtMinutes(d.minutes)} />
              ))}
            </Panel>
          )}

          {/* site distribution */}
          {siteBars.length > 0 && (
            <Panel pal={pal} title="SITES">
              <RecapBarChart rows={siteBars} pal={pal} formatValue={fmtDuration} />
              {recap.browserOtherSec > 0 && (
                <div style={{ fontSize: 11, color: pal.ink3, marginTop: 8 }}>
                  + {fmtDuration(recap.browserOtherSec)} across other sites
                </div>
              )}
            </Panel>
          )}

          {/* app distribution */}
          {appBars.length > 0 && (
            <Panel pal={pal} title="APPS">
              <RecapBarChart rows={appBars} pal={pal} formatValue={fmtDuration} />
              {recap.appOtherSec > 0 && (
                <div style={{ fontSize: 11, color: pal.ink3, marginTop: 8 }}>
                  + {fmtDuration(recap.appOtherSec)} across other apps
                </div>
              )}
            </Panel>
          )}

          {/* phone */}
          {deviceBars.length > 0 && (
            <Panel pal={pal} title="PHONE">
              <RecapBarChart rows={deviceBars} pal={pal} color={pal.event} />
            </Panel>
          )}

          {/* detection events */}
          <Panel pal={pal} title="DETECTION EVENTS">
            {totalEvents === 0 ? (
              // "nothing flagged" is a claim about the CAMERA, and an unreachable
              // server is not evidence for it — so a failed read says so instead.
              <div style={{ fontSize: 12.5, color: pal.ink3 }}>
                {recap.observedSeconds == null ? "couldn't read the sensors" : "nothing flagged"}
              </div>
            ) : (
              <RecapBarChart rows={eventBars} pal={pal} color={scoreColor(tier, pal)} />
            )}
          </Panel>

          {/* evidence gallery */}
          {recap.evidence.length > 0 && (
            <Panel pal={pal} title="EVIDENCE" span={2}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 10 }}>
                {recap.evidence.map((it) =>
                  it.frame ? (
                    <button
                      key={it.id}
                      onClick={() => setEnlarged(it)}
                      style={{
                        all: "unset", cursor: "pointer", position: "relative",
                        borderRadius: 8, overflow: "hidden", border: `1px solid ${pal.rule}`,
                        transition: "transform 120ms ease",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.04)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
                    >
                      <img
                        src={it.frame}
                        alt={kindLabel(it.kind)}
                        style={{ display: "block", width: "100%", aspectRatio: "4 / 3", objectFit: "cover" }}
                      />
                      <div
                        style={{
                          position: "absolute", left: 0, right: 0, bottom: 0, padding: "3px 6px",
                          fontSize: 9.5, color: "#fff",
                          background: "linear-gradient(transparent, rgba(0,0,0,.65))",
                          display: "flex", justifyContent: "space-between", gap: 4,
                        }}
                      >
                        <span>{kindLabel(it.kind)}</span>
                        <span>{timeLabel(it.at)}</span>
                      </div>
                    </button>
                  ) : null,
                )}
              </div>
            </Panel>
          )}
        </div>

        {/* Observed ≠ elapsed. An uninstalled extension and a genuinely quiet
            session are the same rows and opposite claims, so this states what
            the SENSORS covered rather than letting the numbers above imply it. */}
        {recap.observedSeconds != null && recap.spanMs > 0 && (
          <div style={{ fontSize: 11, color: pal.ink3, marginTop: 20, textAlign: "center" }}>
            {recap.observedSeconds > 0
              ? `sensors observed ${fmtDuration(recap.observedSeconds)} of this session`
              : "no device activity recorded during this session (sensors may be off)"}
          </div>
        )}
        {recap.warnings.map((w) => (
          <div key={w} style={{ fontSize: 10.5, color: pal.ink3, marginTop: 6, textAlign: "center" }}>
            {w}
          </div>
        ))}
      </div>

      {enlarged && (
        <div
          role="dialog"
          aria-label="evidence frame"
          onClick={() => setEnlarged(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,.72)", display: "grid", placeItems: "center",
            cursor: "zoom-out",
          }}
        >
          {enlarged.frame && (
            <img
              src={enlarged.frame}
              alt={kindLabel(enlarged.kind)}
              style={{ maxWidth: "82vw", maxHeight: "82vh", borderRadius: 12 }}
            />
          )}
          <div style={{ position: "absolute", bottom: "9vh", color: "#fff", fontSize: 13, fontFamily: FONT }}>
            {kindLabel(enlarged.kind)} · {timeLabel(enlarged.at)}
          </div>
        </div>
      )}
    </div>
  );
}
