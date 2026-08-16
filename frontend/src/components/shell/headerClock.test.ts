import { describe, it, expect } from "vitest";
import { tzAbbreviation } from "./AppHeader";

/**
 * The header used to print an IANA zone's trailing path segment as a location —
 * "America/Los_Angeles" → "Los Angeles" — to a captain sitting in San
 * Francisco. That is a category error, not a formatting slip: a zone id names a
 * set of offset RULES and its city is only the representative one, so San
 * Diego, Portland and Seattle would all have read "Los Angeles" too. No amount
 * of prettifying the string makes it true, which is why the label is now
 * something the zone can actually answer.
 */
describe("tzAbbreviation", () => {
  const summer = new Date("2026-08-16T12:00:00Z"); // PDT
  const winter = new Date("2026-01-15T12:00:00Z"); // PST

  it("answers the abbreviation, and it tracks DST", () => {
    expect(tzAbbreviation(summer, "America/Los_Angeles")).toBe("PDT");
    expect(tzAbbreviation(winter, "America/Los_Angeles")).toBe("PST");
  });

  it("never returns a city name derived from the zone id", () => {
    for (const tz of ["America/Los_Angeles", "America/New_York", "Asia/Jakarta"]) {
      const label = tzAbbreviation(summer, tz);
      expect(label).toBeTruthy();
      // The bug in one assertion: the representative city must never surface.
      expect(label).not.toContain(tz.split("/").pop()!.replace(/_/g, " "));
    }
  });

  it("a zone with no common abbreviation falls back to a GMT offset, which is still not a city", () => {
    // Still true, still honest, still not a place name.
    expect(tzAbbreviation(summer, "Asia/Jakarta")).toMatch(/^(GMT|UTC)/);
  });

  it("a bogus zone yields null rather than throwing at the header", () => {
    expect(tzAbbreviation(summer, "Not/AZone")).toBeNull();
  });
});
