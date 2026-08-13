/**
 * Limbo-lane seam tests. The lane is `position: fixed` chrome on a surface it
 * does not own the top of:
 *
 *   • the sticky header is also fixed, and one layer ABOVE this — so the lane
 *     has to START below it. The header stays on top; raising the card over it
 *     would only trade a clipped card for a covered header.
 *   • `StickyLayer` reserves the same band, and it must measure against where
 *     the lane actually starts rather than against a second hardcoded guess
 *     (the old `top: 24` / `TOP = 64` pair could drift apart silently).
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LimboCards, LANE_TOP } from "./LimboCards";
import { HEADER_H } from "../shell/AppHeader";
import type { LogMessage } from "../../services/api";

vi.mock("./TracedOutline", () => ({
  TracedOutline: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <div style={style}>{children}</div>
  ),
}));

function glow(id: number, summary: string): LogMessage {
  return {
    id,
    conversation_id: 1,
    role: "user",
    content: summary,
    created_at: "2026-08-12T10:00:00",
    has_actionable_signal: true,
    signal_preview: { signals: [{ summary, utterance: summary }], status: "pending", promise_ids: [] },
    source: "web",
  } as unknown as LogMessage;
}

afterEach(cleanup);

describe("limbo lane placement", () => {
  it("starts below the sticky header, not at a magic offset", () => {
    const { container } = render(
      <LimboCards items={[glow(1, "call mum")]} onPromote={() => {}} onDismiss={() => {}} />,
    );
    const lane = container.firstElementChild as HTMLElement;
    expect(lane.style.position).toBe("fixed");
    // Reads the published height at runtime; the fallback is the same source.
    expect(lane.style.top).toContain("--gooni-header-h");
    expect(lane.style.top).toContain(`${HEADER_H}px`);
    // ...and it clears the header rather than overlapping it.
    expect(LANE_TOP).toBeGreaterThan(HEADER_H);
  });

  it("keeps the header on top — the lane never outranks it", async () => {
    const { container } = render(
      <LimboCards items={[glow(1, "call mum")]} onPromote={() => {}} onDismiss={() => {}} />,
    );
    const lane = container.firstElementChild as HTMLElement;
    const { z } = await import("../../ui");
    expect(Number(lane.style.zIndex)).toBeLessThan(z.overlay + 5);
  });

  it("caps the cards and counts the rest — a correct read makes this MORE likely", () => {
    const items = [1, 2, 3, 4, 5].map((i) => glow(i, `commitment ${i}`));
    render(<LimboCards items={items} onPromote={() => {}} onDismiss={() => {}} />);
    expect(screen.getAllByText(/^commitment/)).toHaveLength(3);
    expect(screen.getByText("+2 more waiting")).toBeInTheDocument();
  });
});
