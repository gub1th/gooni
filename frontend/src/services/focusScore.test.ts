import { describe, it, expect } from "vitest";
import { scoreTier, focusFractionSeries } from "./focusScore";

describe("scoreTier", () => {
  it("buckets good/ok/low at the documented thresholds", () => {
    expect(scoreTier(90)).toBe("good");
    expect(scoreTier(75)).toBe("good");
    expect(scoreTier(60)).toBe("ok");
    expect(scoreTier(45)).toBe("ok");
    expect(scoreTier(10)).toBe("low");
  });
});

describe("focusFractionSeries", () => {
  it("splits a fully-covered span into all-1 buckets", () => {
    const series = focusFractionSeries(0, 1000, [{ start: 0, end: 1000 }], 4);
    expect(series).toEqual([1, 1, 1, 1]);
  });

  it("reflects partial coverage per bucket", () => {
    // covers only the first half of the span
    const series = focusFractionSeries(0, 1000, [{ start: 0, end: 500 }], 4);
    expect(series[0]).toBe(1);
    expect(series[1]).toBe(1);
    expect(series[2]).toBe(0);
    expect(series[3]).toBe(0);
  });

  it("returns empty for a degenerate span", () => {
    expect(focusFractionSeries(1000, 1000, [], 4)).toEqual([]);
  });
});
