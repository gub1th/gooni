/**
 * Focus-time client seam.
 *
 * **The WRITE moved to the server (2026-08-16)**, and so did the tests that
 * described it. `focus_session_service.stop` produces the `focus`
 * TrackableEntry now — one per local day, never with `replace`, carrying the
 * exact runs and the promise id — because a session can be ended by a click
 * here, a click on `/focus`, Claude over MCP, or the server's own 6h cap firing
 * on a tab that closed hours ago. Those rules are pinned by
 * `tests/test_focus_sessions.py`; duplicating them here would be two tests of
 * one behaviour, and the one in the wrong place would eventually be the one
 * that "passes".
 *
 * What is left on this side, and what these assertions protect:
 *
 *   1. THE LIVE FOLD. `splitSegmentsByDay` still runs in the browser, because
 *      `focused today` and the corner stat have to answer "how much of this
 *      running session has landed on TODAY" without asking the server every
 *      second. It must agree with the server's split — same midnight clip, same
 *      minutes — or the number on screen contradicts the log matrix.
 *   2. THE CAP IS STILL DRAWN. The server ACTS on the 6h cap; the client must
 *      not render a nine-hour clock while it does.
 *   3. STOP IS ONE CALL, AND CLEARS ONLY ON SUCCESS. A failed stop must leave a
 *      session that is still there and still stoppable — the entry is the only
 *      durable artifact, and a clock that vanished with its minutes is the
 *      failure this whole design exists to prevent.
 *   4. SWITCHING IS THE SERVER'S TRANSACTION. Starting task B ends task A
 *      server-side, in one call; a failed start leaves A live rather than
 *      swapping it away.
 *   5. A PRE-SERVER CACHE IS DROPPED. A localStorage session with no `id`
 *      cannot address any lifecycle route, so reviving it would let you pause a
 *      row that does not exist.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  MAX_RUN_MS,
  sealedSegments,
  type FocusSegment,
  type FocusSession,
} from "../stores/useFocusSessionStore";

/** Every session route call, in order — the seam under test. */
const calls: string[] = [];
let failNext: string | null = null;
let nextId = 500;
let serverRow: Record<string, unknown> | null = null;

function row(state: string) {
  return {
    ...(serverRow as Record<string, unknown>),
    state,
    run_started_at: state === "running" ? new Date().toISOString() : null,
    paused_at: state === "paused" ? new Date().toISOString() : null,
  };
}

vi.mock("./api", () => ({
  BASE: "",
  apiFetch: vi.fn(),
  createTrackable: vi.fn(async () => ({ id: 77, name: "focus", kind: "numeric", agg: "sum" })),
  fetchTrackableEntries: vi.fn(async () => []),
  createFocusSession: vi.fn(async (body: { title: string; promise_id?: number | null }) => {
    calls.push("create");
    if (failNext === "create") throw new Error("500");
    serverRow = {
      id: nextId++,
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
    return row("running");
  }),
  stopFocusSession: vi.fn(async (id: number) => {
    calls.push(`stop:${id}`);
    if (failNext === "stop") throw new Error("500");
    return { ...row("stopped"), focused_minutes: 40, activity: null, completion_frame: null };
  }),
  pauseFocusSession: vi.fn(async () => row("paused")),
  resumeFocusSession: vi.fn(async () => row("running")),
  patchFocusSession: vi.fn(async () => row("running")),
  fetchActiveFocusSession: vi.fn(async () => null),
}));

let splitSegmentsByDay: typeof import("./focusTime").splitSegmentsByDay;
let minutesByPromise: typeof import("./focusTime").minutesByPromise;
let isReadOnlyRollup: typeof import("./focusTime").isReadOnlyRollup;
let endFocusSession: typeof import("./focusTime").endFocusSession;
let switchFocusSession: typeof import("./focusTime").switchFocusSession;
let store: typeof import("../stores/useFocusSessionStore").useFocusSessionStore;

beforeEach(async () => {
  calls.length = 0;
  failNext = null;
  serverRow = null;
  localStorage.clear();
  vi.resetModules();
  // The store is imported FIRST so `focusTime` binds to this same fresh
  // instance — after `resetModules` a stale top-level import would be a
  // different store than the one under test.
  store = (await import("../stores/useFocusSessionStore")).useFocusSessionStore;
  const mod = await import("./focusTime");
  splitSegmentsByDay = mod.splitSegmentsByDay;
  minutesByPromise = mod.minutesByPromise;
  isReadOnlyRollup = mod.isReadOnlyRollup;
  endFocusSession = mod.endFocusSession;
  switchFocusSession = mod.switchFocusSession;
});

afterEach(() => vi.clearAllMocks());

/** Local-time helper — the split is a LOCAL calendar-day question, not UTC. */
function at(y: number, m: number, d: number, h: number, min: number): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

function session(over: Partial<FocusSession> = {}): FocusSession {
  return {
    id: 900,
    promiseId: 1,
    title: "leetcode",
    mode: "focus",
    style: "stopwatch",
    targetMs: 25 * 60_000,
    startedAt: at(2026, 8, 10, 9, 0),
    segments: [{ start: at(2026, 8, 10, 9, 0), end: at(2026, 8, 10, 9, 40), mode: "focus" }],
    running: false,
    kept: false,
    ...over,
  };
}

// ── 1. the live fold still agrees with the server's split ────────────────────

test("the live fold splits at LOCAL midnight, one draft per day", () => {
  const segments: FocusSegment[] = [
    { start: at(2026, 8, 10, 23, 40), end: at(2026, 8, 11, 0, 20), mode: "focus" },
  ];

  const drafts = splitSegmentsByDay(segments);

  expect(drafts.map((d) => d.date)).toEqual(["2026-08-10", "2026-08-11"]);
  expect(drafts[0].minutes).toBe(20);
  expect(drafts[1].minutes).toBe(20);
  // Clipped AT the boundary — a window running past midnight would otherwise
  // attribute the next day's browsing to this day.
  expect(new Date(drafts[0].segments[0].end).getTime()).toBe(at(2026, 8, 11, 0, 0));
  expect(new Date(drafts[1].segments[0].start).getTime()).toBe(at(2026, 8, 11, 0, 0));
});

test("a pause is excluded from the fold, so the live number matches the entry", () => {
  const segments: FocusSegment[] = [
    { start: at(2026, 8, 10, 9, 0), end: at(2026, 8, 10, 9, 30), mode: "focus" },
    { start: at(2026, 8, 10, 11, 0), end: at(2026, 8, 10, 11, 30), mode: "focus" },
  ];

  const [day] = splitSegmentsByDay(segments);

  // 60 focused minutes across a 150-minute envelope — the envelope is not the
  // number, on either side of the wire.
  expect(day.minutes).toBe(60);
  expect(day.segments).toHaveLength(2);
});

// ── 2. the cap is still DRAWN client-side (the server ACTS on it) ────────────

test("an unclosed run is drawn capped and flagged, not nine hours long", () => {
  const started = at(2026, 8, 10, 22, 0);
  const live = session({ startedAt: started, segments: [], running: true });

  const sealed = sealedSegments(live, started + 9 * 60 * 60_000);

  expect(sealed).toHaveLength(1);
  expect(sealed[0].end - sealed[0].start).toBe(MAX_RUN_MS);
  // A cap is a FLOOR, and it says so — the same flag the server writes.
  expect(sealed[0].truncated).toBe(true);
  const total = splitSegmentsByDay(sealed).reduce((n, d) => n + d.minutes, 0);
  expect(total).toBe(MAX_RUN_MS / 60_000);
});

// ── 3. stopping ──────────────────────────────────────────────────────────────

test("stopping is ONE server call, and clears the mirror only after it lands", async () => {
  store.getState().hydrate(session());

  const stopped = await endFocusSession();

  expect(calls).toEqual(["stop:900"]);
  expect(stopped?.focused_minutes).toBe(40);
  expect(store.getState().session).toBeNull();
});

test("a failed stop leaves the session there and stoppable", async () => {
  store.getState().hydrate(session());
  failNext = "stop";

  await expect(endFocusSession()).rejects.toThrow();

  // The minutes are the server's now, but the session must not vanish from
  // under the user — a cleared mirror would take the retry with it.
  const held = store.getState().session;
  expect(held).toMatchObject({ id: 900, promiseId: 1, title: "leetcode" });
  expect(held?.segments).toHaveLength(1);

  failNext = null;
  await endFocusSession();
  expect(store.getState().session).toBeNull();
});

test("two concurrent stops post once — a double-click is the ordinary way there", async () => {
  store.getState().hydrate(session());

  await Promise.all([endFocusSession(), endFocusSession()]);

  expect(calls).toEqual(["stop:900"]);
});

test("stopping with nothing running is a no-op, not an error", async () => {
  expect(await endFocusSession()).toBeNull();
  expect(calls).toEqual([]);
});

// ── 4. switching ─────────────────────────────────────────────────────────────

test("switching starts the new session — the SERVER ends the old one", async () => {
  store.getState().hydrate(session());

  await switchFocusSession(2, "ship it");

  // One call, not stop-then-start: `POST /focus/sessions` writes the outgoing
  // session's entries before creating this one, in one transaction, so there
  // is no window where a session is sealed but unwritten.
  expect(calls).toEqual(["create"]);
  expect(store.getState().session).toMatchObject({ promiseId: 2, title: "ship it", running: true });
  expect(store.getState().session?.segments).toEqual([]);
});

test("switching to the task ALREADY running does nothing", async () => {
  store.getState().hydrate(session({ promiseId: 4, running: true }));

  await switchFocusSession(4, "leetcode");

  // Without this the sitting splits into two entries and the clock resets —
  // the row looks like it restarted because it did.
  expect(calls).toEqual([]);
  expect(store.getState().session?.segments).toHaveLength(1);
});

test("a failed start leaves the previous session live", async () => {
  store.getState().hydrate(session({ promiseId: 1, running: true }));
  failNext = "create";

  await expect(switchFocusSession(2, "ship it")).rejects.toThrow();

  expect(store.getState().session).toMatchObject({ id: 900, promiseId: 1, title: "leetcode" });
});

// ── 5. the pre-server cache ──────────────────────────────────────────────────

test("a localStorage session written before the server owned the lifecycle is dropped", async () => {
  // No `id`, so it can address no lifecycle route. Reviving it would draw a
  // clock nothing can pause, and a stop it could never complete.
  localStorage.setItem(
    "gooni_focus_session",
    JSON.stringify({
      promiseId: 5,
      title: "legacy",
      mode: "focus",
      startedAt: at(2026, 8, 10, 9, 0),
      segments: [{ start: at(2026, 8, 10, 9, 0), end: at(2026, 8, 10, 9, 25), mode: "focus" }],
      running: false,
      kept: false,
      writtenDates: [],
    }),
  );

  // the store reads localStorage at MODULE LOAD, so it has to be imported
  // after the legacy blob is in place — that read is the behaviour under test
  vi.resetModules();
  const fresh = (await import("../stores/useFocusSessionStore")).useFocusSessionStore;
  expect(fresh.getState().session).toBeNull();
});

test("a cached session WITH an id survives a reload, break segments discarded", async () => {
  localStorage.setItem(
    "gooni_focus_session",
    JSON.stringify({
      id: 42,
      promiseId: 5,
      title: "still going",
      mode: "focus",
      startedAt: at(2026, 8, 10, 9, 0),
      segments: [
        { start: at(2026, 8, 10, 9, 0), end: at(2026, 8, 10, 9, 25), mode: "focus" },
        // Pass 3 removed break. A blob that still holds one must DISCARD it:
        // the build that recorded it had already promised never to write it.
        { start: at(2026, 8, 10, 9, 25), end: at(2026, 8, 10, 9, 30), mode: "break" },
      ],
      running: false,
      kept: false,
    }),
  );

  vi.resetModules();
  const fresh = (await import("../stores/useFocusSessionStore")).useFocusSessionStore;
  const revived = fresh.getState().session!;
  expect(revived.id).toBe(42);
  expect(revived.segments).toHaveLength(1);
  expect(splitSegmentsByDay(revived.segments)[0].minutes).toBe(25);
  expect(revived.style).toBe("stopwatch");
});

// ── read helpers, unchanged by the move ──────────────────────────────────────

test("per-task totals read the promise id off the ENTRY", () => {
  const totals = minutesByPromise([
    { id: 1, date: "2026-08-10", value_numeric: 25, value_json: { promise_id: 7 } },
    { id: 2, date: "2026-08-10", value_numeric: 15, value_json: { promise_id: 7 } },
    { id: 3, date: "2026-08-10", value_numeric: 30, value_json: { promise_id: 9 } },
    // a hand-written cell with no attribution is skipped, not counted as 0
    { id: 4, date: "2026-08-10", value_numeric: 99, value_json: null },
  ] as never);

  expect(totals).toEqual({ 7: 40, 9: 30 });
});

test("the focus column is read-only in the matrix, other derived columns are not", () => {
  expect(isReadOnlyRollup({ name: "focus", source: "derived" })).toBe(true);
  // whoop/leetcode numeric mirrors share the source and stay editable
  expect(isReadOnlyRollup({ name: "whoop recovery", source: "derived" })).toBe(false);
  expect(isReadOnlyRollup({ name: "focus", source: "manual" })).toBe(false);
});
