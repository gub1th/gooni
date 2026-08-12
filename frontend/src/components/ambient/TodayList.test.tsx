/**
 * TODAY-list seam test. Three behaviours the layout exists for:
 *
 *   • ticking strikes the row through IN PLACE — it does not move to a
 *     completed section, because the list is short enough that reordering on
 *     tick is just the row you were looking at jumping out from under you;
 *   • a running session shows its live clock ON the task it belongs to and
 *     clicks back through to the session page — that binding IS the
 *     attribution model made visible;
 *   • `N later` is present whenever there are longer-term rows, because
 *     `+ add` defaults everything to today and without a visible later bucket
 *     TODAY quietly becomes a dumping ground.
 *
 * Plus what decides WHICH rows the list gets (`todayRows.mergeTodayRows`): the
 * dashboard serves ACTIVE commitments only, so retention is the only reason a
 * ticked row — or the task a session is running on — is still on screen.
 *
 * Not a pixel suite.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { FocusReminder } from "../../services/api";
import { TodayList, type SessionRow, type SessionRowState, type TodayRow } from "./TodayList";
import { emptyRetained, mergeTodayRows, retainTicked } from "./todayRows";

afterEach(cleanup);

function reminder(id: number, content: string, state: FocusReminder["state"] = "active"): FocusReminder {
  return {
    id,
    type: "promise",
    content,
    owed_to: null,
    due_at: null,
    due_is_default: true,
    done: state === "kept",
    state,
    resolved_at: null,
    age_days: 0,
    lasted_days: 0,
    thought_id: null,
  };
}

const rows: TodayRow[] = [
  { item: reminder(1, "leetcode"), minutes: 25 },
  { item: reminder(2, "ship the home rebuild"), minutes: 0 },
  { item: reminder(3, "snakes and ladders", "kept"), minutes: 0 },
];

function renderList(over: Partial<Parameters<typeof TodayList>[0]> = {}) {
  const props = {
    rows,
    laterCount: 2,
    laterRows: [reminder(8, "book the flights"), reminder(9, "call mum")],
    sessionRow: null as SessionRow | null,
    onTick: vi.fn(),
    onAdd: vi.fn(),
    onFocus: vi.fn(),
    onTogglePause: vi.fn(),
    onStop: vi.fn(),
    ...over,
  };
  render(<TodayList {...props} />);
  return props;
}

test("a kept row stays in place and reads struck through", () => {
  renderList();

  const titles = screen.getAllByText(/leetcode|ship the home rebuild|snakes and ladders/);
  // order is the order it was given — the kept row did NOT sink to a section
  expect(titles.map((t) => t.textContent)).toEqual([
    "leetcode",
    "ship the home rebuild",
    "snakes and ladders",
  ]);

  const done = screen.getByText("snakes and ladders");
  expect(done).toHaveStyle({ textDecoration: "line-through" });
  const open = screen.getByText("leetcode");
  expect(open).toHaveStyle({ textDecoration: "none" });
});

test("ticking reports the row, and the checkbox states the direction", () => {
  const props = renderList();

  fireEvent.click(screen.getByLabelText("Complete leetcode"));
  expect(props.onTick).toHaveBeenCalledWith(rows[0].item);

  // the already-kept one offers the reverse, not a second complete
  expect(screen.getByLabelText("Reopen snakes and ladders")).toBeInTheDocument();
});

function onRow(state: SessionRowState, label = "12:34"): SessionRow {
  return { promiseId: 2, state, label };
}

test("a running session shows its clock on ITS task", () => {
  renderList({ sessionRow: onRow("focus") });

  expect(screen.getByText("12:34")).toBeInTheDocument();
  // the task with accrued-but-not-running time shows its total instead
  expect(screen.getByText("25m")).toBeInTheDocument();
  // the indicator is plain text now, not a door — the session occupies the
  // wave's slot right above this list, so there is nowhere for it to go
  expect(screen.queryByTitle("back to the session")).not.toBeInTheDocument();
});

test("focus is reachable per row — the one door", () => {
  const props = renderList();
  fireEvent.click(screen.getByLabelText("Focus on ship the home rebuild"));
  expect(props.onFocus).toHaveBeenCalledWith(rows[1].item);
});

// The running row owns its own controls. The focus target there used to route
// into the SWITCH path, which ends-and-writes the live session and starts a new
// one on the same task — one sitting split into two entries, clock back to zero.
test("the running row swaps the focus target for pause and stop", () => {
  const props = renderList({ sessionRow: onRow("focus") });

  expect(screen.queryByLabelText("Focus on ship the home rebuild")).not.toBeInTheDocument();

  fireEvent.click(screen.getByLabelText("Pause ship the home rebuild"));
  expect(props.onTogglePause).toHaveBeenCalled();

  fireEvent.click(screen.getByLabelText("Stop the session on ship the home rebuild"));
  expect(props.onStop).toHaveBeenCalled();

  // every OTHER row still offers focus — the one door is unchanged for them
  expect(screen.getByLabelText("Focus on leetcode")).toBeInTheDocument();
});

test("a paused running row offers resume rather than pause", () => {
  const props = renderList({ sessionRow: onRow("paused") });

  expect(screen.queryByLabelText("Pause ship the home rebuild")).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Resume ship the home rebuild"));
  expect(props.onTogglePause).toHaveBeenCalled();
});

test("the later bucket is visible and expands in place", () => {
  renderList();

  const later = screen.getByText("2 later");
  expect(screen.queryByText("book the flights")).not.toBeInTheDocument();
  fireEvent.click(later);
  expect(screen.getByText("book the flights")).toBeInTheDocument();
  expect(screen.getByText("call mum")).toBeInTheDocument();
});

// Only a live session is accruing. Break was removed in pass 3, so `paused` is
// the one non-accruing state left — and it still must not borrow the clock.
test.each([
  ["paused" as SessionRowState, "paused"],
])("a %s session names itself instead of ticking", (state, label) => {
  renderList({ sessionRow: onRow(state) });

  expect(screen.queryByText("12:34")).not.toBeInTheDocument();
  expect(screen.getByText(label)).toBeInTheDocument();
});

test("a LIVE focus session shows its ticking clock and nothing else", () => {
  renderList({ sessionRow: onRow("focus") });

  expect(screen.getByText("12:34")).toBeInTheDocument();
  expect(screen.queryByText("paused")).not.toBeInTheDocument();
});

test("a kept row with a running session shows BOTH the strike and the clock", () => {
  renderList({
    rows: [{ item: reminder(3, "snakes and ladders", "kept"), minutes: 0 }],
    sessionRow: { promiseId: 3, state: "focus", label: "07:12" },
  });

  expect(screen.getByText("snakes and ladders")).toHaveStyle({ textDecoration: "line-through" });
  expect(screen.getByText("07:12")).toBeInTheDocument();
});

test("a row ticked in this sitting stays at its own index once the server drops it", () => {
  const state = emptyRetained();
  const served = [reminder(1, "leetcode"), reminder(2, "ship it"), reminder(3, "call mum")];
  mergeTodayRows(served, state, null);

  const ticked: FocusReminder = { ...served[1], state: "kept", done: true };
  state.kept.set(2, ticked);

  // the dashboard now serves the two ACTIVE rows only
  const merged = mergeTodayRows([served[0], served[2]], state, null);

  expect(merged.map((r) => r.id)).toEqual([1, 2, 3]);
  expect(merged[1].state).toBe("kept");
});

test("the running task survives being marked kept from the session page", () => {
  const state = emptyRetained();
  const served = [reminder(1, "leetcode"), reminder(2, "ship it")];
  mergeTodayRows(served, state, null);

  // `/focus` marked it kept — this surface never saw the click, so nothing is
  // in `kept`, and the dashboard has stopped serving the row.
  const merged = mergeTodayRows([served[0]], state, { promiseId: 2, title: "ship it", kept: true });

  expect(merged.map((r) => r.id)).toEqual([1, 2]);
  expect(merged[1]).toMatchObject({ state: "kept", done: true, content: "ship it" });
});

test("after a reload the running task is rebuilt from the session alone", () => {
  // nothing retained (in-memory by design), nothing active on the server
  const merged = mergeTodayRows([], emptyRetained(), { promiseId: 9, title: "write it up", kept: true });

  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({ id: 9, content: "write it up", state: "kept", done: true });
});

test("a failed un-tick restores the retention that was keeping the row on screen", () => {
  const state = emptyRetained();
  const served = [reminder(1, "leetcode"), reminder(2, "ship it")];
  mergeTodayRows(served, state, null);

  // tick — the server drops the row from its ACTIVE set, retention holds it
  const kept: FocusReminder = { ...served[1], state: "kept", done: true };
  retainTicked(state, kept);
  expect(mergeTodayRows([served[0]], state, null).map((r) => r.id)).toEqual([1, 2]);

  // un-tick, and the PATCH fails — the row was on screen ONLY because of that
  // retention entry, and the server still holds the promise as kept
  const undo = retainTicked(state, { ...kept, state: "active", done: false });
  undo();

  const merged = mergeTodayRows([served[0]], state, null);
  expect(merged.map((r) => r.id)).toEqual([1, 2]);
  expect(merged[1]).toMatchObject({ state: "kept", done: true });
});

test("a failed tick leaves no retention behind", () => {
  const state = emptyRetained();
  const served = [reminder(1, "leetcode"), reminder(2, "ship it")];
  mergeTodayRows(served, state, null);

  const undo = retainTicked(state, { ...served[1], state: "kept", done: true });
  undo();

  // the promise is still active, so the server's list is the whole truth
  expect(mergeTodayRows([served[0]], state, null).map((r) => r.id)).toEqual([1]);
});

test("retention stops applying once its local day is over", () => {
  const lastNight = new Date(2026, 7, 10, 21, 0).getTime();
  const afterMidnight = new Date(2026, 7, 11, 0, 1).getTime();

  const state = emptyRetained(lastNight);
  const served = [reminder(1, "leetcode"), reminder(2, "ship it")];
  mergeTodayRows(served, state, null, lastNight);
  retainTicked(state, { ...served[0], state: "kept", done: true }, lastNight);

  // still last night: the ticked row stays put even though the server dropped it
  expect(mergeTodayRows([served[1]], state, null, lastNight).map((r) => r.id)).toEqual([1, 2]);

  // 00:01 — the home is always-on and never reloaded, and the server now serves
  // a fresh (empty) short_term. TODAY must not lead with yesterday's finished work.
  expect(mergeTodayRows([], state, null, afterMidnight)).toEqual([]);
});

test("a session running across midnight keeps its row on the new day", () => {
  const lastNight = new Date(2026, 7, 10, 23, 50).getTime();
  const afterMidnight = new Date(2026, 7, 11, 0, 10).getTime();

  const state = emptyRetained(lastNight);
  mergeTodayRows([reminder(5, "ship it")], state, null, lastNight);

  const merged = mergeTodayRows([], state, { promiseId: 5, title: "ship it", kept: true }, afterMidnight);
  expect(merged.map((r) => r.id)).toEqual([5]);
  expect(merged[0]).toMatchObject({ content: "ship it", state: "kept" });
});

test("a running task the server still serves is not duplicated", () => {
  const state = emptyRetained();
  const merged = mergeTodayRows([reminder(4, "gym")], state, { promiseId: 4, title: "gym", kept: false });

  expect(merged).toHaveLength(1);
  expect(merged[0].state).toBe("active");
});

test("+ add creates from a title alone", async () => {
  const props = renderList();

  fireEvent.click(screen.getByText("+ add"));
  const field = screen.getByPlaceholderText("what");
  fireEvent.change(field, { target: { value: "  water the plants  " } });
  fireEvent.keyDown(field, { key: "Enter" });

  expect(props.onAdd).toHaveBeenCalledWith("water the plants");
});
