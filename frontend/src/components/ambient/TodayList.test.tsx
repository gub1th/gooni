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
import { TodayList, type TodayRow } from "./TodayList";
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
    runningId: null as number | null,
    runningLabel: "",
    onTick: vi.fn(),
    onAdd: vi.fn(),
    onFocus: vi.fn(),
    onResume: vi.fn(),
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

test("a running session shows its clock on ITS task and routes back to it", () => {
  const props = renderList({ runningId: 2, runningLabel: "12:34" });

  const back = screen.getByTitle("back to the session");
  expect(back).toHaveTextContent("12:34");
  fireEvent.click(back);
  expect(props.onResume).toHaveBeenCalled();

  // the task with accrued-but-not-running time shows its total instead
  expect(screen.getByText("25m")).toBeInTheDocument();
  // and the clock appears exactly once — it belongs to one promise
  expect(screen.getAllByTitle("back to the session")).toHaveLength(1);
});

test("focus is reachable per row — the one door", () => {
  const props = renderList();
  fireEvent.click(screen.getByLabelText("Focus on ship the home rebuild"));
  expect(props.onFocus).toHaveBeenCalledWith(rows[1].item);
});

test("the later bucket is visible and expands in place", () => {
  renderList();

  const later = screen.getByText("2 later");
  expect(screen.queryByText("book the flights")).not.toBeInTheDocument();
  fireEvent.click(later);
  expect(screen.getByText("book the flights")).toBeInTheDocument();
  expect(screen.getByText("call mum")).toBeInTheDocument();
});

test("a kept row with a running session shows BOTH the strike and the clock", () => {
  const props = renderList({ rows: [{ item: reminder(3, "snakes and ladders", "kept"), minutes: 0 }], runningId: 3, runningLabel: "07:12" });

  expect(screen.getByText("snakes and ladders")).toHaveStyle({ textDecoration: "line-through" });
  const back = screen.getByTitle("back to the session");
  expect(back).toHaveTextContent("07:12");
  fireEvent.click(back);
  expect(props.onResume).toHaveBeenCalled();
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
