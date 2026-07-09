/**
 * Log view seam test (ambient-loop v2 Slice 3 — the FE test precedent).
 * One flow, per the PRD's testing decisions: mock a message list with
 * mixed glow flags → assert render, tap-glow opens the peek panel,
 * Promote fires the expected POST. Extend incrementally; don't grow this
 * into a pixel-assertion suite.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { LogMessage } from "../services/api";

const glowMessage: LogMessage = {
  id: 11,
  conversation_id: 1,
  role: "user",
  content: "imma hit the gym 6x a week",
  created_at: new Date().toISOString(),
  source: "whatsapp",
  has_actionable_signal: true,
  signal_preview: {
    status: "pending",
    promise_ids: [],
    signals: [
      {
        kind: "create",
        utterance: "imma hit the gym 6x a week",
        summary: "gym six times a week",
        cadence: "n_per_week",
        cadence_target: 6,
        due_date: null,
        due_hint: null,
        is_important: false,
        parent_hint: null,
      },
    ],
  },
};

const plainMessage: LogMessage = {
  id: 12,
  conversation_id: 1,
  role: "user",
  content: "saw a cool paper today",
  created_at: new Date().toISOString(),
  source: "web",
  has_actionable_signal: false,
  signal_preview: null,
};

const promoteMock = vi.fn(async (_id: number) => ({
  message: {
    ...glowMessage,
    signal_preview: {
      ...glowMessage.signal_preview!,
      status: "promoted" as const,
      promise_ids: [7],
    },
  },
  promises: [],
}));

vi.mock("../services/api", () => ({
  fetchMessageLog: vi.fn(async () => [glowMessage, plainMessage]),
  promoteMessage: (id: number) => promoteMock(id),
  undoPromoteMessage: vi.fn(),
  dismissMessageGlow: vi.fn(),
  // AmbientOverlay mounts inside ChatLogView — give it empty zones.
  fetchOverlay: vi.fn(async () => ({
    action_horizon: [],
    trackables_today: [],
    anchor: null,
    whoop_select: [],
  })),
  setOverlayAnchorNote: vi.fn(),
  searchNoteTitles: vi.fn(async () => []),
}));

afterEach(cleanup);

test("log renders messages, glow dot opens peek, Promote fires the POST", async () => {
  const { ChatLogView } = await import("./ChatLogView");
  render(<ChatLogView />);

  // Both messages render in the stream; only the actionable one has a dot.
  await screen.findByText("imma hit the gym 6x a week");
  expect(screen.getByText("saw a cool paper today")).toBeInTheDocument();
  expect(screen.getByTestId("glow-dot-11")).toBeInTheDocument();
  expect(screen.queryByTestId("glow-dot-12")).not.toBeInTheDocument();

  // Tap dot → peek shows Gooni's parse (summary + cadence pill).
  screen.getByTestId("glow-dot-11").click();
  await screen.findByTestId("peek-panel-11");
  expect(screen.getByText("gym six times a week")).toBeInTheDocument();
  expect(screen.getByText("6x/wk")).toBeInTheDocument();

  // Promote → the API call fires with the message id; undo strip appears.
  screen.getByTestId("promote-11").click();
  await waitFor(() => expect(promoteMock).toHaveBeenCalledWith(11));
  await screen.findByTestId("undo-11");
});
