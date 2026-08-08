/**
 * Kiosk whoop feed-line seam test. The /focus board is unattended 24/7, so the
 * whoop row must stay honest in all three states — fresh, stale, and unknown.
 * The state that matters most is the one the feature exists for: a CONNECTED
 * strap that went silent, which nulls every metric. That must still report its
 * age rather than vanishing.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhoopToday } from "../../services/api";
import { FEED_REFRESH_MS } from "../../services/api";
import { STALE_MS } from "../ambient/whoopFreshness";

const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);

const emptyDashboard = {
  circles: [],
  overflow_topics: [],
  notch: { reminders: [], promises: [] },
  log: [],
  short_term: { overdue: [], today: [], tomorrow: [], this_week: [] },
  long_term: [],
  rollups: [],
  generated_at: new Date(NOW).toISOString(),
};

/** A connected strap whose records have all gone unscored / absent. */
const silentStrap: WhoopToday = {
  date: "2026-07-14",
  recovery_score: null,
  hrv_rmssd_ms: null,
  resting_hr: null,
  strain: null,
  sleep_minutes: null,
  sleep_performance_pct: null,
  sleep_start_at: null,
  sleep_end_at: null,
  updated_at: null,
  source_updated_at: null,
};

function livingStrap(ageMs: number): WhoopToday {
  return {
    ...silentStrap,
    recovery_score: 63,
    strain: 11.2,
    sleep_minutes: 402,
    updated_at: new Date(NOW - ageMs).toISOString(),
    source_updated_at: new Date(NOW - ageMs).toISOString(),
  };
}

const fetchWhoopToday = vi.fn();

vi.mock("../../services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/api")>();
  return {
    ...actual,
    fetchFocusDashboard: vi.fn(async () => emptyDashboard),
    fetchCalendarEvents: vi.fn(async () => []),
    fetchTrackables: vi.fn(async () => []),
    fetchTrackableDays: vi.fn(async () => ({ days: [] })),
    fetchLeetcodeToday: vi.fn(async () => ({ available: false })),
    fetchWhoopToday: (...args: unknown[]) => fetchWhoopToday(...args),
  };
});

const { FocusDashboard } = await import("./FocusDashboard");

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  fetchWhoopToday.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("kiosk whoop feed line", () => {
  it("reports a silent strap's age instead of hiding the row", async () => {
    fetchWhoopToday.mockResolvedValue(silentStrap);
    render(<FocusDashboard />);

    // The row exists at all — a dead feed that renders nothing is the original
    // bug in its worst form.
    await waitFor(() => expect(screen.getByText("whoop")).toBeInTheDocument());
    // Placeholders, matching the ambient tile, plus the honest third state.
    expect(screen.getByText(/rec – · strain – · –/)).toBeInTheDocument();
    expect(screen.getByText(/age unknown/)).toBeInTheDocument();
  });

  it("marks a strap that stopped syncing as stale", async () => {
    fetchWhoopToday.mockResolvedValue(livingStrap(STALE_MS + 3600_000));
    render(<FocusDashboard />);

    await waitFor(() => expect(screen.getByText(/⚠ stale/)).toBeInTheDocument());
    expect(screen.getByText(/updated 37h ago/)).toBeInTheDocument();
  });

  it("keeps the last good reading when a refetch fails", async () => {
    fetchWhoopToday.mockResolvedValueOnce(livingStrap(2 * 3600_000));
    render(<FocusDashboard />);

    await waitFor(() => expect(screen.getByText(/updated 2h ago/)).toBeInTheDocument());

    fetchWhoopToday.mockRejectedValue(new Error("network down"));
    await act(async () => { await vi.advanceTimersByTimeAsync(FEED_REFRESH_MS + 100); });

    expect(screen.getByText(/rec 63 · strain 11.2 · 6.7h/)).toBeInTheDocument();
    expect(screen.getByText("whoop")).toBeInTheDocument();
  });

  it("stays hidden for a strap that was never connected", async () => {
    fetchWhoopToday.mockResolvedValue({ ...silentStrap, date: null });
    render(<FocusDashboard />);

    await waitFor(() => expect(fetchWhoopToday).toHaveBeenCalled());
    expect(screen.queryByText("whoop")).not.toBeInTheDocument();
  });
});
