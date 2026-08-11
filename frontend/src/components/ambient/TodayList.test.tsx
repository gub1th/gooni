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
 * Not a pixel suite.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { FocusReminder } from "../../services/api";
import { TodayList, type TodayRow } from "./TodayList";

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

test("+ add creates from a title alone", async () => {
  const props = renderList();

  fireEvent.click(screen.getByText("+ add"));
  const field = screen.getByPlaceholderText("what");
  fireEvent.change(field, { target: { value: "  water the plants  " } });
  fireEvent.keyDown(field, { key: "Enter" });

  expect(props.onAdd).toHaveBeenCalledWith("water the plants");
});
