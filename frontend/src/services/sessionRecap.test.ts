import { describe, it, expect } from "vitest";
import { recapFromSession } from "./sessionRecap";
import type { ServerFocusSession, SessionActivity } from "./api";

function makeSession(overrides: Partial<ServerFocusSession> = {}): ServerFocusSession {
  return {
    id: 42,
    promise_id: 7,
    title: "prep interview",
    title_is_manual: false,
    state: "stopped",
    started_at: "2026-08-20T14:00:00+00:00",
    ended_at: "2026-08-20T15:00:00+00:00",
    run_started_at: null,
    paused_at: null,
    total_paused_ms: 0,
    focused_ms: 3_600_000,
    focused_minutes: 60,
    segments: [{ start: "2026-08-20T14:00:00+00:00", end: "2026-08-20T15:00:00+00:00", truncated: false }],
    truncated: false,
    style: "stopwatch",
    target_ms: null,
    kept: true,
    ...overrides,
  };
}

function makeActivity(overrides: Partial<SessionActivity> = {}): SessionActivity {
  return {
    since: "2026-08-20T14:00:00+00:00",
    until: "2026-08-20T15:00:00+00:00",
    window_seconds: 3600,
    camera_events: [],
    camera_evidence: [],
    browser: { top: [], other_sec: 0 },
    app: { top: [], other_sec: 0 },
    device: { top: [], other_count: 0 },
    observed_seconds: 0,
    coverage: 0,
    warnings: [],
    ...overrides,
  };
}

describe("recapFromSession", () => {
  it("maps the plain fields straight off the server session", () => {
    const recap = recapFromSession(makeSession());
    expect(recap.id).toBe(42);
    expect(recap.title).toBe("prep interview");
    expect(recap.totalMinutes).toBe(60);
    expect(recap.spanStart).toBe(Date.parse("2026-08-20T14:00:00+00:00"));
    expect(recap.spanEnd).toBe(Date.parse("2026-08-20T15:00:00+00:00"));
    expect(recap.timeline).toEqual([
      { start: Date.parse("2026-08-20T14:00:00+00:00"), end: Date.parse("2026-08-20T15:00:00+00:00"), truncated: false },
    ]);
  });

  // The one field with genuinely no server source for a past session — see
  // the header comment in sessionRecap.ts. A missing `completion_frame` must
  // map to `null`, which `FocusSessionRecap` already renders as "no banner",
  // never to a crash or a placeholder.
  it("maps an absent completion_frame to null, not undefined or a crash", () => {
    const recap = recapFromSession(makeSession({ completion_frame: undefined }));
    expect(recap.completionFrame).toBeNull();
  });

  it("keeps a present completion_frame (the fresh-stop case)", () => {
    const recap = recapFromSession(makeSession({ completion_frame: "data:image/jpeg;base64,AAAA" }));
    expect(recap.completionFrame).toBe("data:image/jpeg;base64,AAAA");
  });

  // `null` (read succeeded, sensors saw nothing) and `undefined`→`null` via no
  // `activity` object at all (the read never happened / failed) are OPPOSITE
  // claims and the mapper must not collapse them into the same value.
  describe("observedSeconds: null (no read) vs 0 (read, nothing observed)", () => {
    it("is null when there is no `activity` object on the session at all", () => {
      const recap = recapFromSession(makeSession({ activity: undefined }));
      expect(recap.observedSeconds).toBeNull();
    });

    it("is 0 — not null — when the activity read succeeded and observed nothing", () => {
      const recap = recapFromSession(makeSession({ activity: makeActivity({ observed_seconds: 0 }) }));
      expect(recap.observedSeconds).toBe(0);
    });

    it("carries the real positive value when the sensors saw something", () => {
      const recap = recapFromSession(makeSession({ activity: makeActivity({ observed_seconds: 900 }) }));
      expect(recap.observedSeconds).toBe(900);
    });
  });

  // Same null-vs-zero-vs-absent shape for the score: `undefined` (never
  // scored — no activity object), `null` (scored, nothing observed — a real
  // "not measured" answer), and a real number are three different claims.
  describe("focusScore: undefined (unscored) vs null (scored, unmeasured) vs a number", () => {
    it("is undefined when there is no activity object", () => {
      const recap = recapFromSession(makeSession({ activity: undefined }));
      expect(recap.focusScore).toBeUndefined();
    });

    it("is null when the activity read scored the session but nothing was observed", () => {
      const recap = recapFromSession(makeSession({ activity: makeActivity({ focus_score: null }) }));
      expect(recap.focusScore).toBeNull();
    });

    it("carries the real score when one was computed", () => {
      const recap = recapFromSession(makeSession({ activity: makeActivity({ focus_score: 82 }) }));
      expect(recap.focusScore).toBe(82);
    });
  });

  it("empty-defaults every sensor-derived collection when there is no activity object", () => {
    const recap = recapFromSession(makeSession({ activity: undefined }));
    expect(recap.evidence).toEqual([]);
    expect(recap.browser).toEqual([]);
    expect(recap.apps).toEqual([]);
    expect(recap.device).toEqual([]);
    expect(recap.browserOtherSec).toBe(0);
    expect(recap.appOtherSec).toBe(0);
    expect(recap.warnings).toEqual([]);
    expect(recap.eventsByKind).toEqual({});
    expect(recap.sensorTimeline).toBeUndefined();
  });

  it("folds camera_events into eventsByKind by kind", () => {
    const recap = recapFromSession(
      makeSession({
        activity: makeActivity({ camera_events: [{ kind: "phone", count: 3 }, { kind: "away", count: 1 }] }),
      }),
    );
    expect(recap.eventsByKind).toEqual({ phone: 3, away: 1 });
  });

  it("folds a session's focus segments into per-local-day minutes", () => {
    // A run entirely within one local day → one perDay entry near 60m.
    const recap = recapFromSession(makeSession());
    expect(recap.perDay).toHaveLength(1);
    expect(recap.perDay[0].minutes).toBeCloseTo(60, 1);
  });

  it("splits a segment crossing local midnight into two perDay entries", () => {
    // 30 minutes either side of a local midnight (test runner's local zone).
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    const start = new Date(midnight.getTime() - 30 * 60_000).toISOString();
    const end = new Date(midnight.getTime() + 30 * 60_000).toISOString();
    const recap = recapFromSession(
      makeSession({
        started_at: start,
        ended_at: end,
        focused_minutes: 60,
        segments: [{ start, end, truncated: false }],
      }),
    );
    expect(recap.perDay).toHaveLength(2);
    for (const d of recap.perDay) expect(d.minutes).toBeCloseTo(30, 1);
  });

  it("falls back to now for spanEnd on a session with no ended_at", () => {
    const before = Date.now();
    const recap = recapFromSession(makeSession({ ended_at: null, state: "running" }));
    expect(recap.spanEnd).toBeGreaterThanOrEqual(before);
  });
});
