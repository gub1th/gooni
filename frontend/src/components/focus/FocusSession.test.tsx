/**
 * Focus-cam control seam test. One rule, three states: the sidecar senses during
 * LIVE FOCUS ONLY.
 *
 * Nothing should be sensed for a window that will never be written — break
 * segments are dropped by `splitSegmentsByDay` and a paused session accrues
 * nothing, so in both the camera must be idle. And the load-bearing case stays:
 * a closed tab always clears control.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ControlCall = [string, number | null | undefined];
const controls: ControlCall[] = [];

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

vi.mock("../../services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/api")>();
  return {
    ...actual,
    // the sensor line's three reads — irrelevant here, kept quiet
    apiFetch: vi.fn(async () => ({ ok: false })),
    fetchFocusCamToday: vi.fn(async () => ({ sessions: [], events: {} })),
    fetchFocusDashboard: vi.fn(async () => ({ short_term: {}, long_term: [], rollups: [] })),
    updateFocusReminder: vi.fn(async () => ({})),
    setFocusCamControl: vi.fn(async (control: string, id?: number | null) => {
      controls.push([control, id]);
      return { control, target_reminder_id: id ?? null };
    }),
  };
});

const { FocusSession } = await import("./FocusSession");
const { useFocusSessionStore } = await import("../../stores/useFocusSessionStore");

/** What the sidecar was last told to do. */
function latest(): ControlCall | undefined {
  return controls[controls.length - 1];
}

beforeEach(() => {
  controls.length = 0;
  localStorage.clear();
  act(() => useFocusSessionStore.getState().stop());
});

afterEach(cleanup);

describe("focus-cam control follows live focus only", () => {
  it("senses on focus, stops on break, resumes on focus, stops on pause", async () => {
    render(<FocusSession />);

    act(() => useFocusSessionStore.getState().start(7, "leetcode"));
    await waitFor(() => expect(latest()).toEqual(["running", 7]));

    // BREAK accrues nothing toward focus, so the camera must not keep capturing
    act(() => useFocusSessionStore.getState().setMode("break"));
    await waitFor(() => expect(latest()).toEqual(["idle", null]));

    act(() => useFocusSessionStore.getState().setMode("focus"));
    await waitFor(() => expect(latest()).toEqual(["running", 7]));

    act(() => useFocusSessionStore.getState().pause());
    await waitFor(() => expect(latest()).toEqual(["idle", null]));
  });

  it("clears control when the tab goes away", async () => {
    const { unmount } = render(<FocusSession />);
    act(() => useFocusSessionStore.getState().start(9, "gym"));
    await waitFor(() => expect(latest()).toEqual(["running", 9]));

    unmount();

    expect(latest()).toEqual(["idle", null]);
  });
});
