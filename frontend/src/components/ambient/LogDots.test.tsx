/**
 * Log-surface seam tests. Two flows:
 *
 *   • the whoop tile's data age must describe a payload that is actually
 *     current, so a strap that resumed syncing clears the stale warning WITHOUT
 *     the panel being closed and reopened — and a transient refetch failure must
 *     not throw away a good reading;
 *   • the `focus` rollup is VISIBLE in the log but must never be written from
 *     it. Every matrix verb carries `replace: true`, which deletes the whole
 *     (trackable, day) — taking each session row's promise id and window with
 *     it. Ordinary columns stay editable.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Trackable, TrackableDay, WhoopToday } from "../../services/api";
import { FEED_REFRESH_MS } from "../../services/api";
import { STALE_MS } from "./whoopFreshness";

const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);

function trackable(over: Partial<Trackable> & { id: number; name: string }): Trackable {
  return {
    kind: "numeric",
    unit: null,
    cadence: null,
    target: null,
    is_important: false,
    agg: "sum",
    schema_hint: null,
    source: "manual",
    parent_promise_id: null,
    ...over,
  };
}

function day(date: string, value: number): TrackableDay {
  return { date, value, label: null, entry_count: 1 };
}

function whoopAged(ageMs: number): WhoopToday {
  return {
    date: "2026-07-14",
    recovery_score: 41,
    hrv_rmssd_ms: 55,
    resting_hr: 52,
    strain: 8.4,
    sleep_minutes: 402,
    sleep_performance_pct: 78,
    sleep_start_at: "2026-07-14T06:20:00",
    sleep_end_at: "2026-07-14T13:02:00",
    updated_at: new Date(NOW - ageMs).toISOString(),
    source_updated_at: new Date(NOW - ageMs).toISOString(),
  };
}

const fetchWhoopToday = vi.fn();
const fetchTrackables = vi.fn();
const fetchTrackableDays = vi.fn();
const logTrackable = vi.fn();

vi.mock("../../services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/api")>();
  return {
    ...actual,
    fetchTrackables: (...args: unknown[]) => fetchTrackables(...args),
    fetchTrackableDays: (...args: unknown[]) => fetchTrackableDays(...args),
    logTrackable: (...args: unknown[]) => logTrackable(...args),
    fetchDailyNotes: vi.fn(async () => []),
    fetchLeetcodeToday: vi.fn(async () => ({ available: false })),
    fetchWhoopToday: (...args: unknown[]) => fetchWhoopToday(...args),
  };
});

const { LogDots } = await import("./LogDots");

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  fetchWhoopToday.mockReset();
  fetchTrackables.mockReset().mockResolvedValue([]);
  fetchTrackableDays.mockReset().mockResolvedValue({ days: [] });
  logTrackable.mockReset().mockResolvedValue({ cleared: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("whoop feed tile freshness", () => {
  it("drops the stale warning once the feed starts serving fresh data again", async () => {
    // 37h old at mount → past the 36h threshold.
    fetchWhoopToday.mockResolvedValueOnce(whoopAged(STALE_MS + 3600_000));
    render(<LogDots onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/⚠ stale/)).toBeInTheDocument());

    // The strap resumes syncing. Without a refetch the tile would keep crying
    // stale about a live feed — a live feed made to look dead.
    fetchWhoopToday.mockResolvedValue(whoopAged(12 * 60_000));
    await act(async () => { await vi.advanceTimersByTimeAsync(FEED_REFRESH_MS + 100); });

    await waitFor(() => expect(screen.queryByText(/⚠ stale/)).not.toBeInTheDocument());
    expect(screen.getByText(/updated 12m ago/)).toBeInTheDocument();
  });

  it("keeps a good reading when a refetch fails", async () => {
    fetchWhoopToday.mockResolvedValueOnce(whoopAged(2 * 3600_000));
    render(<LogDots onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/updated 2h ago/)).toBeInTheDocument());

    fetchWhoopToday.mockRejectedValue(new Error("network down"));
    await act(async () => { await vi.advanceTimersByTimeAsync(FEED_REFRESH_MS + 100); });

    // Still the real numbers, not the connect button.
    expect(screen.getByText("41")).toBeInTheDocument();
    expect(screen.getByText("8.4")).toBeInTheDocument();
    expect(screen.queryByText("connect")).not.toBeInTheDocument();
  });

  it("stops polling after unmount", async () => {
    fetchWhoopToday.mockResolvedValue(whoopAged(2 * 3600_000));
    const { unmount } = render(<LogDots onClose={() => {}} />);
    await waitFor(() => expect(fetchWhoopToday).toHaveBeenCalled());

    unmount();
    const afterUnmount = fetchWhoopToday.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * FEED_REFRESH_MS); });

    expect(fetchWhoopToday.mock.calls.length).toBe(afterUnmount);
  });
});

describe("the focus rollup in the log", () => {
  const FOCUS = trackable({ id: 77, name: "focus", unit: "minutes", source: "derived" });
  const CALORIES = trackable({ id: 5, name: "calories", source: "manual" });

  beforeEach(() => {
    fetchWhoopToday.mockResolvedValue(whoopAged(60_000));
    fetchTrackables.mockResolvedValue([FOCUS, CALORIES]);
    fetchTrackableDays.mockImplementation(async (id: number) => ({
      days: [day("2026-07-14", id === FOCUS.id ? 50 : 1800)],
    }));
  });

  it("shows the rollup's value but refuses to open an editor or write it", async () => {
    render(<LogDots onClose={() => {}} />);

    // visible — 'focused today' is the one rollup that crosses into the log
    await waitFor(() => expect(screen.getByText("focus")).toBeInTheDocument());
    const cell = await screen.findByText("50");

    fireEvent.click(cell);

    // no editor, and above all no write: a replace on this column would delete
    // the day's session rows outright
    expect(screen.queryByDisplayValue("50")).not.toBeInTheDocument();
    expect(logTrackable).not.toHaveBeenCalled();
  });

  it("leaves ordinary columns editable", async () => {
    render(<LogDots onClose={() => {}} />);

    const cell = await screen.findByText("1800");
    fireEvent.click(cell);

    const field = await screen.findByDisplayValue("1800");
    fireEvent.change(field, { target: { value: "2100" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(logTrackable).toHaveBeenCalledWith(
      CALORIES.id,
      expect.objectContaining({ value_numeric: 2100, replace: true }),
    ));
  });
});
