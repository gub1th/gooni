/**
 * Focus-cam control seam test. One rule: the sidecar senses while focus is
 * actually accruing, and not otherwise.
 *
 * Nothing should be sensed for a window that will never be written. That used
 * to be three states (live / break / paused); pass 3 removed break, so it is
 * two — but the derivation is still SINGLE (`isAccruingFocus`), which is what
 * these assertions really protect.
 *
 * The rule outlived its original host. It used to live on the focus PAGE; since
 * focus became a state rather than a place (pass 2) it belongs to
 * `useFocusCamControl`, mounted once in AppShell — no view may own it, because
 * the overlay unmounts on every collapse while the session keeps running.
 *
 * **The unmount case REVERSED in 2026-08-16**, and it is the assertion worth
 * reading twice. It used to be "a closed tab always clears control", which was
 * right when a closed tab was the end of the session as far as anything could
 * tell. The session is a row now: closing a tab leaves a session that is
 * genuinely still running, so posting `idle` on the way out would blind the
 * sidecar for the rest of it. Release is the SERVER's job now (every lifecycle
 * transition reconciles control, and `active()` retires a capped session), and
 * this hook is belt-and-braces over that.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ControlCall = [string, number | null | undefined];
const controls: ControlCall[] = [];

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

// A tiny in-memory stand-in for the session routes. It ECHOES the row rather
// than returning a fresh skeleton, which matters: the store adopts the server's
// answer wholesale, so a stub that dropped `promise_id` on pause would make the
// hook look broken when only the stub was.
let nextSessionId = 100;
let row: Record<string, unknown> | null = null;

function serialize(state: string) {
  return {
    ...(row as Record<string, unknown>),
    state,
    run_started_at: state === "running" ? new Date().toISOString() : null,
    paused_at: state === "paused" ? new Date().toISOString() : null,
  };
}

vi.mock("../../services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/api")>();
  return {
    ...actual,
    // the sensor line's reads — irrelevant here, kept quiet
    apiFetch: vi.fn(async () => ({ ok: false })),
    fetchSessionActivity: vi.fn(async () => {
      throw new Error("not under test");
    }),
    fetchFocusDashboard: vi.fn(async () => ({ short_term: {}, long_term: [], rollups: [] })),
    updateFocusReminder: vi.fn(async () => ({})),
    setFocusCamControl: vi.fn(async (control: string, id?: number | null) => {
      controls.push([control, id]);
      return { control, target_reminder_id: id ?? null };
    }),
    // The lifecycle is the server's now, so the store's mutators are calls.
    createFocusSession: vi.fn(async (body: { title: string; promise_id?: number | null }) => {
      row = {
        id: nextSessionId++,
        promise_id: body.promise_id ?? null,
        title: body.title,
        started_at: new Date().toISOString(),
        ended_at: null,
        total_paused_ms: 0,
        focused_ms: 0,
        focused_minutes: 0,
        segments: [],
        truncated: false,
        style: "stopwatch",
        target_ms: null,
        kept: false,
      };
      return serialize("running");
    }),
    pauseFocusSession: vi.fn(async () => serialize("paused")),
    resumeFocusSession: vi.fn(async () => serialize("running")),
    patchFocusSession: vi.fn(async () => serialize("running")),
    fetchActiveFocusSession: vi.fn(async () => null),
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
  row = null;
  localStorage.clear();
  act(() => useFocusSessionStore.getState().clear());
});

afterEach(cleanup);

describe("focus-cam control follows live focus only", () => {
  it("senses while running, stops on pause, resumes on resume", async () => {
    render(<ControlHost />);

    // The store is optimistic, so the target is live before the POST resolves —
    // which is the behaviour that keeps the sidecar from lagging a click.
    await act(async () => {
      await useFocusSessionStore.getState().start(7, "leetcode");
    });
    await waitFor(() => expect(latest()).toEqual(["running", 7]));

    // a paused session accrues nothing, so the camera must not keep capturing
    await act(async () => {
      await useFocusSessionStore.getState().pause();
    });
    await waitFor(() => expect(latest()).toEqual(["idle", null]));

    await act(async () => {
      await useFocusSessionStore.getState().resume();
    });
    await waitFor(() => expect(latest()).toEqual(["running", 7]));
  });

  it("switching stopwatch↔timer does not disturb sensing", async () => {
    render(<ControlHost />);

    await act(async () => {
      await useFocusSessionStore.getState().start(3, "write it up");
    });
    await waitFor(() => expect(latest()).toEqual(["running", 3]));
    const before = controls.length;

    // The two styles are the same accruing time watched two ways, so flipping
    // between them must not stop and restart the sidecar.
    await act(async () => {
      await useFocusSessionStore.getState().setStyle("timer");
      await useFocusSessionStore.getState().setStyle("stopwatch");
    });

    expect(latest()).toEqual(["running", 3]);
    expect(controls.length).toBe(before);
  });

  it("does NOT clear control when the tab goes away — the session is still running", async () => {
    const { unmount } = render(<ControlHost />);
    await act(async () => {
      await useFocusSessionStore.getState().start(9, "gym");
    });
    await waitFor(() => expect(latest()).toEqual(["running", 9]));
    const before = controls.length;

    unmount();

    // Closing one window on a two-monitor setup must not blind the sidecar for
    // the rest of a session the server still holds as running.
    expect(latest()).toEqual(["running", 9]);
    expect(controls.length).toBe(before);
  });

  it("a promise-less session (one Claude started) still senses", async () => {
    render(<ControlHost />);
    await act(async () => {
      await useFocusSessionStore.getState().start(null, "system design prep");
    });
    // Nothing to attribute to, but there is still something to watch.
    await waitFor(() => expect(latest()).toEqual(["running", null]));
  });
});
