import { beforeEach, describe, expect, it, vi } from "vitest";

// The reconcile race that produced two sessions for one sitting:
//
//   1. stop → POST .../stop lands, session cleared, the notch goes back to search
//   2. a poll issued BEFORE that stop resolves, still reporting the session ACTIVE
//   3. its answer is adopted → the session reappears, running
//   4. the stop looks like it did nothing, so the next click starts a SECOND
//      session on top of the one that already ended
//
// Observed in prod as ids 9 (99 minutes) and 10 (1.4 seconds), same task, four
// seconds apart. `syncing` could never have caught it: it only guards a call
// this store is making, and the poll here was already in flight.

let activeResolvers: Array<(v: unknown) => void> = [];
let activeAnswer: unknown = null;
/** When true, `fetchActiveFocusSession` hangs until the test releases it. */
let holdActive = false;

vi.mock("../services/api", () => ({
  fetchActiveFocusSession: vi.fn(() => {
    if (!holdActive) return Promise.resolve(activeAnswer);
    return new Promise((resolve) => {
      activeResolvers.push(resolve as (v: unknown) => void);
    });
  }),
  createFocusSession: vi.fn(async () => serverRunning(1)),
  pauseFocusSession: vi.fn(async () => serverRunning(1)),
  resumeFocusSession: vi.fn(async () => serverRunning(1)),
  patchFocusSession: vi.fn(async () => serverRunning(1)),
}));

function serverRunning(id: number) {
  return {
    id,
    promise_id: 45,
    title: "CliffWalker RL with no assistance",
    state: "running",
    started_at: new Date(Date.now() - 60_000).toISOString(),
    run_started_at: new Date(Date.now() - 60_000).toISOString(),
    ended_at: null,
    paused_at: null,
    total_paused_ms: 0,
    segments: [],
    truncated: false,
    style: "stopwatch",
    target_ms: 0,
    kept: false,
  };
}

const { useFocusSessionStore, syncFocusSession, fromServer } = await import("./useFocusSessionStore");

function seedLiveSession() {
  useFocusSessionStore.getState().hydrate(fromServer(serverRunning(9) as never));
}

describe("syncFocusSession does not undo a mutation that happened mid-flight", () => {
  beforeEach(() => {
    activeResolvers = [];
    activeAnswer = null;
    holdActive = false;
    localStorage.clear();
    useFocusSessionStore.setState({ session: null, syncing: false, mutationSeq: 0 });
  });

  it("a poll in flight when the session is cleared cannot bring it back", async () => {
    seedLiveSession();
    expect(useFocusSessionStore.getState().session).not.toBeNull();

    // A poll leaves, carrying the pre-stop world.
    holdActive = true;
    const inFlight = syncFocusSession();

    // The stop lands and clears the mirror. (`endFocusSession` calls exactly
    // this, once the server has confirmed.)
    useFocusSessionStore.getState().clear();
    expect(useFocusSessionStore.getState().session).toBeNull();

    // Now the stale answer arrives, still saying the session is running.
    activeResolvers.forEach((r) => r(serverRunning(9)));
    await inFlight;

    expect(
      useFocusSessionStore.getState().session,
      "a stopped session must not come back — that is what made the stop look dead",
    ).toBeNull();
  });

  it("a poll in flight when a NEW session starts does not replace it with the old one", async () => {
    seedLiveSession();
    holdActive = true;
    const inFlight = syncFocusSession();

    // A switch: different task, different row.
    useFocusSessionStore.getState().hydrate(fromServer(serverRunning(11) as never));
    useFocusSessionStore.setState((st) => ({ mutationSeq: st.mutationSeq + 1 }));

    activeResolvers.forEach((r) => r(serverRunning(9)));
    await inFlight;

    expect(useFocusSessionStore.getState().session?.id).toBe(11);
  });

  it("an ordinary poll with nothing in flight is still adopted", async () => {
    // The guard must not turn the reconcile off — a session Claude started, or
    // one stopped on another screen, reaches this tab only by being asked about.
    expect(useFocusSessionStore.getState().session).toBeNull();
    activeAnswer = serverRunning(12);
    await syncFocusSession();
    expect(useFocusSessionStore.getState().session?.id).toBe(12);

    activeAnswer = null;
    await syncFocusSession();
    expect(useFocusSessionStore.getState().session).toBeNull();
  });
});
