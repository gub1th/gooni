/**
 * Focus-cam control seam test. One rule: the sidecar senses while focus is
 * actually accruing, and not otherwise.
 *
 * Nothing should be sensed for a window that will never be written. That used
 * to be three states (live / break / paused); pass 3 removed break, so it is
 * two — but the derivation is still SINGLE (`isAccruingFocus`), which is what
 * these assertions really protect. And the load-bearing case stays: a closed
 * tab always clears control.
 *
 * The rule outlived its original host. It used to live on the focus PAGE; since
 * focus became a state rather than a place (pass 2) it belongs to
 * `useFocusCamControl`, mounted once in AppShell — no view may own it, because
 * the overlay unmounts on every collapse while the session keeps running. The
 * assertions are unchanged; only the host they are driven through moved.
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

const { useFocusCamControl } = await import("./useFocusCamControl");
const { useFocusSessionStore } = await import("../../stores/useFocusSessionStore");

/** Stands in for AppShell — the one place the hook is really mounted. */
function ControlHost() {
  useFocusCamControl();
  return null;
}

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
  it("senses while running, stops on pause, resumes on resume", async () => {
    render(<ControlHost />);

    act(() => useFocusSessionStore.getState().start(7, "leetcode"));
    await waitFor(() => expect(latest()).toEqual(["running", 7]));

    // a paused session accrues nothing, so the camera must not keep capturing
    act(() => useFocusSessionStore.getState().pause());
    await waitFor(() => expect(latest()).toEqual(["idle", null]));

    act(() => useFocusSessionStore.getState().resume());
    await waitFor(() => expect(latest()).toEqual(["running", 7]));
  });

  it("switching stopwatch↔timer does not disturb sensing", async () => {
    render(<ControlHost />);

    act(() => useFocusSessionStore.getState().start(3, "write it up"));
    await waitFor(() => expect(latest()).toEqual(["running", 3]));
    const before = controls.length;

    // The two styles are the same accruing time watched two ways, so flipping
    // between them must not stop and restart the sidecar.
    act(() => useFocusSessionStore.getState().setStyle("timer"));
    act(() => useFocusSessionStore.getState().setStyle("stopwatch"));

    expect(latest()).toEqual(["running", 3]);
    expect(controls.length).toBe(before);
  });

  it("clears control when the tab goes away", async () => {
    const { unmount } = render(<ControlHost />);
    act(() => useFocusSessionStore.getState().start(9, "gym"));
    await waitFor(() => expect(latest()).toEqual(["running", 9]));

    unmount();

    expect(latest()).toEqual(["idle", null]);
  });
});
