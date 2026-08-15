/**
 * Proactive-line seam tests.
 *
 * The whole design rests on the line saying nothing most of the time, so the
 * assertions here are mostly about SILENCE being real silence:
 *
 *   • `null` renders no text at all — no placeholder, no "nothing to report",
 *     no zero. A slot that always says something is a slot you stop reading
 *     (the grindstone line and the log button's dot both died of it).
 *   • an unreachable backend is not evidence that there IS something to say, so
 *     a failed fetch is silence too rather than an error state.
 *   • dismiss is OPTIMISTIC and STAYS dismissed: the poll already in flight
 *     when it fires is still carrying the old row, and without a client-side
 *     memory the line blinks back for one cycle.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchProactiveObservation = vi.fn();
const dismissProactiveObservation = vi.fn();

vi.mock("../../services/api", () => ({
  PROACTIVE_POLL_MS: 60_000,
  fetchProactiveObservation: (...a: unknown[]) => fetchProactiveObservation(...a),
  dismissProactiveObservation: (...a: unknown[]) => dismissProactiveObservation(...a),
}));

import { ProactiveLine } from "./ProactiveLine";

function obs(id: number, content: string) {
  return {
    id,
    content,
    channel: "ambient" as const,
    created_at: "2026-08-15T20:00:00",
    expires_at: "2026-08-15T20:30:00",
    dismissed: false,
    age_seconds: 12,
  };
}

const POLL_MS = 60_000;

// One microtask flush — the component loads on mount and the assertions are
// about what it renders once that settles.
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Advance to the NEXT poll and let its fetch resolve. Real timers here would
// mean either a 60-second test or a poll that never fires.
async function nextPoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS);
  });
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchProactiveObservation.mockReset();
  dismissProactiveObservation.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("proactive line", () => {
  it("renders the observation when there is one", async () => {
    fetchProactiveObservation.mockResolvedValue(obs(1, "25m on youtube, sir. the review is due in 3h."));
    render(<ProactiveLine />);
    await settle();
    expect(screen.getByText(/25m on youtube/)).toBeInTheDocument();
  });

  it("says NOTHING when there is nothing — no placeholder, no zero", async () => {
    fetchProactiveObservation.mockResolvedValue(null);
    const { container } = render(<ProactiveLine />);
    await settle();
    expect(container.textContent).toBe("");
    expect(container.querySelector("button")).toBeNull();
  });

  it("stays silent when the fetch FAILS — an unreachable backend is not news", async () => {
    fetchProactiveObservation.mockRejectedValue(new Error("offline"));
    const { container } = render(<ProactiveLine />);
    await settle();
    expect(container.textContent).toBe("");
  });

  it("dismisses optimistically and does not blink back on the next poll", async () => {
    const line = obs(7, "calories are at the limit and it is 14:00.");
    fetchProactiveObservation.mockResolvedValue(line);
    render(<ProactiveLine />);
    await settle();

    fireEvent.click(screen.getByLabelText("dismiss observation"));
    expect(screen.queryByText(/calories are at the limit/)).toBeNull();
    expect(dismissProactiveObservation).toHaveBeenCalledWith(7);

    // The next poll still answers with the old row (the dismiss POST and the
    // poll race). Without the client-side memory the line blinks back.
    await nextPoll();
    expect(screen.queryByText(/calories are at the limit/)).toBeNull();
  });

  it("a FAILED dismiss still clears the line — a suggestion is not state", async () => {
    dismissProactiveObservation.mockRejectedValue(new Error("500"));
    fetchProactiveObservation.mockResolvedValue(obs(9, "nothing observed for 45m — stepped away?"));
    render(<ProactiveLine />);
    await settle();

    fireEvent.click(screen.getByLabelText("dismiss observation"));
    await settle();
    // Re-materialising something Daniel just waved away is the worse failure.
    expect(screen.queryByText(/stepped away/)).toBeNull();
  });

  it("a NEW observation still lands after an earlier one was dismissed", async () => {
    fetchProactiveObservation.mockResolvedValue(obs(1, "first remark"));
    render(<ProactiveLine />);
    await settle();
    fireEvent.click(screen.getByLabelText("dismiss observation"));

    // The guard is per-ID, not a "stop showing me things" latch: the next
    // observation must still land in the same mounted component.
    fetchProactiveObservation.mockResolvedValue(obs(2, "second remark"));
    await nextPoll();
    expect(screen.getByText("second remark")).toBeInTheDocument();
  });
});
