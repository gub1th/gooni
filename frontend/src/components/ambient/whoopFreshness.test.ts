import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { parseUtc, clock, sleepClock, relAge, freshness, STALE_MS } from "./whoopFreshness";

// The naive-UTC trap only shows up OFF UTC — under TZ=UTC a wrong parse and a
// right one agree, so a CI box in UTC would green-light the bug. Pin a
// non-zero offset for the whole file (Node re-reads TZ when process.env.TZ is
// assigned, which is what stubEnv does). PDT = UTC-7 on the June dates below.
beforeAll(() => { vi.stubEnv("TZ", "America/Los_Angeles"); });
afterAll(() => { vi.unstubAllEnvs(); });

describe("parseUtc", () => {
  it("treats a suffix-less stamp as UTC, not local", () => {
    // Would FAIL if the Z were never appended: local parse in PDT yields
    // 2026-06-29T13:20Z, seven hours off.
    expect(parseUtc("2026-06-29T06:20:00")).toBe(Date.UTC(2026, 5, 29, 6, 20, 0));
  });

  it("respects an offset that is already present", () => {
    // Would FAIL if the Z were appended unconditionally: "…+07:00Z" is not a
    // valid ISO string and parses to NaN → null.
    expect(parseUtc("2026-06-29T06:20:00+07:00")).toBe(Date.UTC(2026, 5, 28, 23, 20, 0));
    expect(parseUtc("2026-06-29T06:20:00Z")).toBe(Date.UTC(2026, 5, 29, 6, 20, 0));
    expect(parseUtc("2026-06-29T06:20:00-04:00")).toBe(Date.UTC(2026, 5, 29, 10, 20, 0));
  });

  it("keeps fractional seconds working", () => {
    expect(parseUtc("2026-06-29T06:20:00.500")).toBe(Date.UTC(2026, 5, 29, 6, 20, 0, 500));
  });

  it("passes date-only strings through (already UTC per spec)", () => {
    expect(parseUtc("2026-06-29")).toBe(Date.UTC(2026, 5, 29));
  });

  it("returns null for missing or junk input", () => {
    expect(parseUtc(null)).toBeNull();
    expect(parseUtc(undefined)).toBeNull();
    expect(parseUtc("")).toBeNull();
    expect(parseUtc("   ")).toBeNull();
    expect(parseUtc("not-a-date")).toBeNull();
  });
});

describe("clock / sleepClock", () => {
  it("renders naive-UTC stamps in the viewer's local time", () => {
    expect(clock("2026-06-29T06:20:00")).toBe("11:20p"); // 06:20Z → 23:20 PDT
    expect(clock("2026-06-29T14:05:00")).toBe("7:05a");
  });

  it("handles midnight and noon", () => {
    expect(clock("2026-06-29T07:00:00")).toBe("12:00a"); // 00:00 PDT
    expect(clock("2026-06-29T19:00:00")).toBe("12:00p");
  });

  it("needs both ends of the window", () => {
    expect(sleepClock("2026-06-29T06:20:00", "2026-06-29T14:05:00")).toBe("11:20p → 7:05a");
    expect(sleepClock("2026-06-29T06:20:00", null)).toBeNull();
    expect(sleepClock(null, null)).toBeNull();
  });
});

describe("relAge", () => {
  it("steps minutes → hours → days", () => {
    expect(relAge(0)).toBe("0m ago");
    expect(relAge(59 * 60_000)).toBe("59m ago");
    expect(relAge(60 * 60_000)).toBe("1h ago");
    expect(relAge(23 * 3600_000)).toBe("23h ago");
    // hours run past a day so the 36h stale boundary stays legible
    expect(relAge(24 * 3600_000)).toBe("24h ago");
    expect(relAge(47 * 3600_000)).toBe("47h ago");
    expect(relAge(48 * 3600_000)).toBe("2d ago");
    expect(relAge(15 * 24 * 3600_000)).toBe("15d ago");
  });

  it("clamps a future timestamp instead of printing a negative age", () => {
    expect(relAge(-5 * 60_000)).toBe("0m ago");
  });
});

describe("freshness", () => {
  const now = Date.UTC(2026, 6, 14, 12, 0, 0);

  it("is fresh just inside the stale threshold", () => {
    const f = freshness(new Date(now - STALE_MS + 60_000).toISOString(), now);
    expect(f).toMatchObject({ stale: false, known: true });
    expect(f.label).toBe("35h ago");
  });

  it("goes stale just past it", () => {
    const f = freshness(new Date(now - STALE_MS - 60_000).toISOString(), now);
    expect(f).toMatchObject({ stale: true, known: true, label: "36h ago" });
  });

  it("reads naive-UTC input without a timezone shift", () => {
    // 30h before `now`, written the way WHOOP actually sends it.
    expect(freshness("2026-07-13T06:00:00", now)).toMatchObject({
      stale: false, known: true, label: "30h ago",
    });
  });

  it("admits ignorance rather than claiming freshness or printing NaN", () => {
    for (const bad of [null, undefined, "", "garbage"]) {
      const f = freshness(bad, now);
      expect(f).toEqual({ label: "age unknown", stale: false, known: false });
      expect(f.label).not.toMatch(/NaN/);
    }
  });
});
