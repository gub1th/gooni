/**
 * Session-scoped activity seam test. ONE rule: everything on the focus surface
 * describes THIS SESSION.
 *
 * The bug it pins: the footer, the camera indicator and the evidence gallery
 * each read a DIFFERENT endpoint at a DIFFERENT scope — `/focus/cam/today` and
 * `/focus/dashboard` rollups both answer for the local DAY, `/focus/cam/evidence`
 * for the last few days — so a twenty-minute session reported "17 signals today"
 * and "whatsapp open · 16", numbers about the day sitting under a clock about
 * the session. They now share ONE poll of `/focus/session-activity`, bounded by
 * the session's own start, and three components cannot drift into three answers.
 *
 * Also asserted: a FAILED read is not a quiet session. A dropped refresh keeps
 * the last good numbers (no flicker between real values and dashes), and a
 * failed FIRST load renders "—" rather than "quiet" or a zero — the same rule
 * the extension popup follows when it refuses to fall back to `0s`.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionActivity } from "../../services/api";

const calls: { since: string | null; until: string | null }[] = [];
let nextResult: (() => Promise<SessionActivity>) | null = null;

vi.mock("../../services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/api")>();
  return {
    ...actual,
    FEED_REFRESH_MS: 25_000,
    fetchSessionActivity: vi.fn(async (since: Date | string, until?: Date | string | null) => {
      calls.push({
        since: since instanceof Date ? since.toISOString() : String(since),
        until: until ? (until instanceof Date ? until.toISOString() : String(until)) : null,
      });
      if (!nextResult) throw new Error("no stub set");
      return nextResult();
    }),
  };
});

const { useSessionActivity } = await import("./useSessionActivity");
const { sensorsFrom } = await import("./FocusExpanded");

function payload(over: Partial<SessionActivity> = {}): SessionActivity {
  return {
    since: "2026-08-16T17:00:00",
    until: "2026-08-16T17:20:00",
    window_seconds: 1200,
    camera_events: [],
    camera_evidence: [],
    browser: { top: [], other_sec: 0 },
    app: { top: [], other_sec: 0 },
    device: { top: [], other_count: 0 },
    observed_seconds: 0,
    coverage: 0,
    warnings: [],
    ...over,
  };
}

let seen: ReturnType<typeof useSessionActivity> | null = null;

function Host({ active, sinceMs }: { active: boolean; sinceMs: number | null }) {
  seen = useSessionActivity(active, sinceMs);
  return null;
}

beforeEach(() => {
  calls.length = 0;
  seen = null;
  nextResult = async () => payload();
});

afterEach(() => cleanup());

describe("useSessionActivity", () => {
  it("asks for the SESSION's window, not a day", async () => {
    const start = Date.UTC(2026, 7, 16, 17, 0, 0);
    render(<Host active sinceMs={start} />);
    await waitFor(() => expect(calls.length).toBe(1));
    // The whole point: the read is bounded by the session's own start. A
    // day-scoped endpoint has no `since` at all, which is how "17 signals
    // today" ended up under a twenty-minute clock.
    expect(calls[0].since).toBe(new Date(start).toISOString());
    // No `until` while the session is LIVE — the window runs to now, and
    // pinning an end would freeze the footer at the first poll.
    expect(calls[0].until).toBeNull();
  });

  it("issues no request without a session — there is no window to ask about", async () => {
    render(<Host active sinceMs={null} />);
    await act(async () => {});
    expect(calls.length).toBe(0);
    expect(seen?.data).toBeNull();
    expect(seen?.loading).toBe(false);
  });

  it("keeps the last good payload across a dropped refresh", async () => {
    const start = Date.now() - 60_000;
    nextResult = async () => payload({ observed_seconds: 600 });
    const { rerender } = render(<Host active sinceMs={start} />);
    await waitFor(() => expect(seen?.data?.observed_seconds).toBe(600));

    // A refresh fails. The numbers on screen must NOT flip to dashes — the
    // session is still running and the last reading is still the last reading.
    nextResult = async () => {
      throw new Error("network");
    };
    rerender(<Host active sinceMs={start} />);
    await act(async () => {});
    await waitFor(() => expect(seen?.data?.observed_seconds).toBe(600));
    expect(seen?.failed).toBe(false);
  });

  it("reports a failed FIRST load rather than an empty session", async () => {
    nextResult = async () => {
      throw new Error("network");
    };
    render(<Host active sinceMs={Date.now() - 60_000} />);
    await waitFor(() => expect(seen?.failed).toBe(true));
    expect(seen?.data).toBeNull();
  });
});

describe("sensorsFrom", () => {
  it("renders SESSION counts, not day counts", () => {
    const s = sensorsFrom(
      payload({
        camera_events: [
          { kind: "phone", count: 2 },
          { kind: "stand", count: 1 },
        ],
        browser: {
          top: [
            { name: "hellointerview.com", label: "hellointerview", seconds: 840, intervals: 3 },
          ],
          other_sec: 0,
        },
        device: { top: [{ name: "whatsapp open", label: "opened whatsapp", count: 1 }], other_count: 0 },
      }),
    );
    // "this session", never "today" — the label is half the fix, because the
    // number is meaningless without the scope it describes.
    expect(s.camera).toBe("3 this session");
    expect(s.cameraOn).toBe(true);
    expect(s.browser).toBe("hellointerview 14m");
    expect(s.phone).toBe("opened whatsapp · 1");
  });

  it("says quiet when the sensors saw nothing, and — when nothing was read", () => {
    const quiet = sensorsFrom(payload());
    expect(quiet.camera).toBe("quiet");
    expect(quiet.browser).toBe("quiet");
    expect(quiet.cameraOn).toBe(false);

    // A failed / not-yet-settled read is NOT a quiet session — an unreachable
    // server is not evidence of a calm twenty minutes.
    const unknown = sensorsFrom(null);
    expect(unknown.camera).toBeNull();
    expect(unknown.browser).toBeNull();
    expect(unknown.phone).toBeNull();
  });
});
