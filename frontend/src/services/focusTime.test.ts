/**
 * Focus-entry write seam. Three rules from the data model, each of which is
 * cheap to hold now and expensive to discover later:
 *
 *   1. NEVER pass `replace` — it collapses the (trackable, day) to the last
 *      session, so a day of four pomodoros would report the last one.
 *   2. A session spanning midnight writes TWO entries, one per LOCAL calendar
 *      date, or the daily fold lies about both days.
 *   3. Attribution rides on the ENTRY (`value_json.promise_id`), never on the
 *      definition — `Trackable.parent_promise_id` binds to exactly one Promise,
 *      so a trackable per task would grow the log matrix a column per task.
 *
 * The definition itself is asserted too: `agg=sum` is what makes the day fold
 * to focused-minutes, and `parent_promise_id` must stay absent.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  MAX_RUN_MS,
  sealedSegments,
  type FocusSegment,
  type FocusSession,
} from "../stores/useFocusSessionStore";

const created: Record<string, unknown>[] = [];
const logged: { id: number; body: Record<string, unknown> }[] = [];
/** Dates the fake backend refuses — how a partial write is reproduced. */
const failDates = new Set<string>();

vi.mock("./api", () => ({
  BASE: "",
  apiFetch: vi.fn(),
  createTrackable: vi.fn(async (body: Record<string, unknown>) => {
    created.push(body);
    return { id: 77, name: "focus", kind: "numeric", agg: "sum" };
  }),
  logTrackable: vi.fn(async (id: number, body: Record<string, unknown>) => {
    if (failDates.has(String(body.date))) throw new Error("500");
    logged.push({ id, body });
    return { cleared: false };
  }),
  fetchTrackableEntries: vi.fn(async () => []),
}));

let splitSegmentsByDay: typeof import("./focusTime").splitSegmentsByDay;
let writeFocusSession: typeof import("./focusTime").writeFocusSession;
let minutesByPromise: typeof import("./focusTime").minutesByPromise;
let switchFocusSession: typeof import("./focusTime").switchFocusSession;
let store: typeof import("../stores/useFocusSessionStore").useFocusSessionStore;

beforeEach(async () => {
  created.length = 0;
  logged.length = 0;
  failDates.clear();
  localStorage.clear();
  vi.resetModules();
  // The store is imported FIRST so `focusTime` binds to this same fresh
  // instance — after `resetModules` a stale top-level import would be a
  // different store than the one under test.
  store = (await import("../stores/useFocusSessionStore")).useFocusSessionStore;
  const mod = await import("./focusTime");
  splitSegmentsByDay = mod.splitSegmentsByDay;
  writeFocusSession = mod.writeFocusSession;
  minutesByPromise = mod.minutesByPromise;
  switchFocusSession = mod.switchFocusSession;
});

afterEach(() => vi.clearAllMocks());

/** Local-time helper — the split is a LOCAL calendar-day question, not UTC. */
function at(y: number, m: number, d: number, h: number, min: number): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

test("one session inside a day writes exactly one entry, no replace", async () => {
  const segments: FocusSegment[] = [
    { start: at(2026, 8, 10, 9, 0), end: at(2026, 8, 10, 9, 25), mode: "focus" },
  ];

  await writeFocusSession(segments, 42, "leetcode");

  expect(logged).toHaveLength(1);
  const body = logged[0].body;
  expect(body.date).toBe("2026-08-10");
  expect(body.value_numeric).toBe(25);
  expect(body.source).toBe("focus");
  // trap 1 — a truthy OR an explicit false would both be wrong here: the field
  // must simply not be in the payload.
  expect(body).not.toHaveProperty("replace");
  // attribution rides on the entry
  expect(body.value_json).toMatchObject({ promise_id: 42, title: "leetcode" });
  // a genuine session carries no truncation flag at all
  expect(body.value_json).not.toHaveProperty("truncated");
});

test("a session nobody closed is capped, and the entry says the total is a floor", async () => {
  // started last night, the tab was left open, stopped nine hours later
  const started = at(2026, 8, 10, 22, 0);
  const session: FocusSession = {
    promiseId: 3,
    title: "read the paper",
    mode: "focus",
    startedAt: started,
    segments: [],
    running: true,
    kept: false,
    writtenDates: [],
  };

  const segments = sealedSegments(session, started + 9 * 60 * 60_000);
  await writeFocusSession(segments, 3, "read the paper");

  // nine hours of sleep must not read as focus against the promise
  const total = logged.reduce((n, l) => n + (l.body.value_numeric as number), 0);
  expect(total).toBe(MAX_RUN_MS / 60_000);
  // and the cap is DISTINGUISHABLE from a real six-hour sitting
  expect(logged.every((l) => (l.body.value_json as { truncated?: boolean }).truncated === true)).toBe(true);
  // the cap still splits at midnight like any other run
  expect(logged.map((l) => l.body.date)).toEqual(["2026-08-10", "2026-08-11"]);
});

test("the definition is one shared sum-agg trackable with no parent promise", async () => {
  await writeFocusSession(
    [{ start: at(2026, 8, 10, 9, 0), end: at(2026, 8, 10, 9, 10), mode: "focus" }],
    1,
    "a",
  );

  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ name: "focus", kind: "numeric", unit: "minutes", agg: "sum", source: "derived" });
  // the whole reason attribution is on the entry
  expect(created[0]).not.toHaveProperty("parent_promise_id");
});

test("a session spanning midnight writes one entry per local day", async () => {
  const segments: FocusSegment[] = [
    { start: at(2026, 8, 10, 23, 40), end: at(2026, 8, 11, 0, 20), mode: "focus" },
  ];

  const drafts = splitSegmentsByDay(segments);

  expect(drafts.map((d) => d.date)).toEqual(["2026-08-10", "2026-08-11"]);
  expect(drafts[0].minutes).toBe(20);
  expect(drafts[1].minutes).toBe(20);

  await writeFocusSession(segments, 7, "ship it");
  expect(logged.map((l) => l.body.date)).toEqual(["2026-08-10", "2026-08-11"]);
  // both halves stay attributed to the same promise
  expect(logged.every((l) => (l.body.value_json as { promise_id: number }).promise_id === 7)).toBe(true);
});

test("a retry after a PARTIAL write sends only the day that never landed", async () => {
  // one session across midnight → two entries; the second one fails
  const segments: FocusSegment[] = [
    { start: at(2026, 8, 10, 23, 40), end: at(2026, 8, 11, 0, 20), mode: "focus" },
  ];
  const written: string[] = [];
  failDates.add("2026-08-11");

  await expect(
    writeFocusSession(segments, 7, "ship it", { onWritten: (d) => written.push(d) }),
  ).rejects.toThrow();

  expect(logged.map((l) => l.body.date)).toEqual(["2026-08-10"]);
  expect(written).toEqual(["2026-08-10"]);

  // the session survived the failure, so ending it again re-seals the SAME
  // segments — the day that landed must not be added twice
  failDates.clear();
  await writeFocusSession(segments, 7, "ship it", {
    writtenDates: written,
    onWritten: (d) => written.push(d),
  });

  expect(logged.map((l) => l.body.date)).toEqual(["2026-08-10", "2026-08-11"]);
  expect(written).toEqual(["2026-08-10", "2026-08-11"]);
  // and the day's real total is 20 minutes, not 40
  const aug10 = logged.filter((l) => l.body.date === "2026-08-10");
  expect(aug10).toHaveLength(1);
  expect(aug10[0].body.value_numeric).toBe(20);
});

test("a retry with nothing outstanding writes nothing at all", async () => {
  const segments: FocusSegment[] = [
    { start: at(2026, 8, 10, 9, 0), end: at(2026, 8, 10, 9, 25), mode: "focus" },
  ];

  const drafts = await writeFocusSession(segments, 4, "leetcode", {
    writtenDates: ["2026-08-10"],
  });

  expect(drafts).toEqual([]);
  expect(logged).toHaveLength(0);
});

test("break time is elapsed time but it is not focus, so it is never written", async () => {
  const drafts = splitSegmentsByDay([
    { start: at(2026, 8, 10, 9, 0), end: at(2026, 8, 10, 9, 25), mode: "focus" },
    { start: at(2026, 8, 10, 9, 25), end: at(2026, 8, 10, 9, 30), mode: "break" },
  ]);

  expect(drafts).toHaveLength(1);
  expect(drafts[0].minutes).toBe(25);
});

/** A paused session with 40 recorded minutes on one task. */
function fortyMinutesOn(promiseId: number, title: string): FocusSession {
  return {
    promiseId,
    title,
    mode: "focus",
    startedAt: at(2026, 8, 10, 9, 0),
    segments: [{ start: at(2026, 8, 10, 9, 0), end: at(2026, 8, 10, 9, 40), mode: "focus" }],
    running: false,
    kept: false,
    writtenDates: [],
  };
}

test("switching tasks writes the running session's entry before the new one starts", async () => {
  store.getState().hydrate(fortyMinutesOn(1, "leetcode"));

  await switchFocusSession(2, "ship it");

  // the outgoing session's minutes landed, attributed to ITS promise
  expect(logged).toHaveLength(1);
  expect(logged[0].body.value_numeric).toBe(40);
  expect(logged[0].body.value_json).toMatchObject({ promise_id: 1, title: "leetcode" });

  // and only then did the new one start, from zero
  const next = store.getState().session;
  expect(next).toMatchObject({ promiseId: 2, title: "ship it", running: true });
  expect(next?.segments).toEqual([]);
});

test("a failed write aborts the switch and leaves the running session intact", async () => {
  store.getState().hydrate(fortyMinutesOn(1, "leetcode"));
  failDates.add("2026-08-10");

  await expect(switchFocusSession(2, "ship it")).rejects.toThrow();

  // the 40 minutes are still recoverable, on the task they belong to
  const held = store.getState().session;
  expect(held).toMatchObject({ promiseId: 1, title: "leetcode" });
  expect(held?.segments).toHaveLength(1);
  expect(logged).toHaveLength(0);

  // the write is retryable, and the retry completes the switch
  failDates.clear();
  await switchFocusSession(2, "ship it");
  expect(logged.map((l) => (l.body.value_json as { promise_id: number }).promise_id)).toEqual([1]);
  expect(store.getState().session?.promiseId).toBe(2);
});

test("a second switch while the first write is in flight does not write twice", async () => {
  store.getState().hydrate(fortyMinutesOn(1, "leetcode"));

  // nothing on screen changes until the write resolves, so this is what a
  // double-click on the focus target actually does
  const first = switchFocusSession(2, "ship it");
  const second = switchFocusSession(3, "gym");
  await Promise.all([first, second]);

  // ONE entry for the outgoing session — a sum-agg trackable would otherwise
  // report 80 minutes for 40 minutes of work, permanently
  expect(logged).toHaveLength(1);
  expect(logged[0].body.value_numeric).toBe(40);
  expect(logged[0].body.value_json).toMatchObject({ promise_id: 1 });

  // and a session is running on one of the clicked tasks, not on the old one
  expect([2, 3]).toContain(store.getState().session?.promiseId);
});

test("starting focus with nothing running writes nothing", async () => {
  await switchFocusSession(3, "gym");

  expect(logged).toHaveLength(0);
  expect(store.getState().session).toMatchObject({ promiseId: 3, running: true });
});

test("per-task totals sum the entries, several per day included", () => {
  const rows = [
    { id: 1, trackable_id: 77, date: "2026-08-10", value_boolean: null, value_numeric: 25, value_json: { promise_id: 42 }, source: "focus", created_at: null },
    { id: 2, trackable_id: 77, date: "2026-08-10", value_boolean: null, value_numeric: 25, value_json: { promise_id: 42 }, source: "focus", created_at: null },
    { id: 3, trackable_id: 77, date: "2026-08-10", value_boolean: null, value_numeric: 10, value_json: { promise_id: 9 }, source: "focus", created_at: null },
    // a row with no attribution (a hand edit in the matrix) must not crash or
    // land on some arbitrary task
    { id: 4, trackable_id: 77, date: "2026-08-10", value_boolean: null, value_numeric: 5, value_json: null, source: "manual", created_at: null },
  ];

  expect(minutesByPromise(rows)).toEqual({ 42: 50, 9: 10 });
});
