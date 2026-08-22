/**
 * QuickFind seam test. One flow, same spirit as ChatLogView.test.tsx: type a
 * query → hits from DIFFERENT primitives render together, each tagged with its
 * kind → Enter opens the top hit. The point of the test is the MIXING (a note,
 * a promise and a trackable in one list); it is not a pixel suite.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ApiNote, ApiPromise, FocusReminder, Trackable } from "../../services/api";

const note: ApiNote = {
  id: 3,
  title: "gym log",
  content: null,
  excerpt: "push day, 5x5",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  last_opened_at: null,
  is_public: false,
  is_pinned: false,
  tags: [],
};

const reminder: FocusReminder = {
  id: 9,
  type: "promise",
  content: "gym monday",
  owed_to: null,
  due_at: null,
  due_is_default: true,
  done: false,
  state: "active",
  resolved_at: null,
  age_days: 1,
  lasted_days: 1,
  thought_id: null,
};

const promise: ApiPromise = {
  id: 21,
  utterance: "no skipping gym this week",
  summary: null,
  state: "active",
  cadence: "once",
  cadence_target: null,
  is_important: false,
  parent_promise_id: null,
  inferred_due: null,
  slip_count: 0,
  resolved_at: null,
  source_message_id: null,
  created_at: null,
  updated_at: null,
};

const trackable = {
  id: 4,
  name: "gym",
  kind: "boolean",
  unit: null,
  cadence: null,
  target: null,
  is_important: true,
  agg: "last",
  schema_hint: null,
  source: "manual",
  parent_promise_id: null,
} as unknown as Trackable;

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

vi.mock("../../services/api", () => ({
  searchNoteTitles: vi.fn(async () => [note]),
  searchNotes: vi.fn(async () => []),
  fetchMemories: vi.fn(async () => ({ total: 0, memories: [], next_cursor: null, has_more: false })),
  fetchTrackables: vi.fn(async () => [trackable]),
  fetchPromises: vi.fn(async () => [promise]),
  fetchRecentNotes: vi.fn(async () => []),
  fetchFocusDashboard: vi.fn(async () => ({
    circles: [],
    overflow_topics: [],
    notch: { reminders: [], promises: [] },
    log: [],
    short_term: { overdue: [], today: [reminder], tomorrow: [], this_week: [] },
    long_term: [],
    rollups: [],
    generated_at: new Date().toISOString(),
  })),
}));

afterEach(cleanup);

test("quickfind mixes kinds for one query and opens the top hit", async () => {
  const onOpenNote = vi.fn();
  const onOpenTrackables = vi.fn();
  const { QuickFind } = await import("./QuickFind");
  render(<QuickFind onOpenNote={onOpenNote} onOpenTrackables={onOpenTrackables} />);

  const input = screen.getByLabelText("quickfind");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "gym" } });

  // one query, four primitives — note first (title match), then the two
  // commitment stores, then the trackable.
  await screen.findByText("gym log");
  await waitFor(() => expect(screen.getByText("gym monday")).toBeInTheDocument());
  expect(screen.getByText("no skipping gym this week")).toBeInTheDocument();
  expect(screen.getByText("gym")).toBeInTheDocument();

  // each row carries its kind label — that's how a mixed list stays readable
  expect(screen.getAllByText("promise")).toHaveLength(2);
  expect(screen.getByText("note")).toBeInTheDocument();
  expect(screen.getByText("trackable")).toBeInTheDocument();

  // Enter takes the highlighted (first) hit → the note opens inline
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onOpenNote).toHaveBeenCalledWith(note);
});
