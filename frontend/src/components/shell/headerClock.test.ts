import { describe, it, expect } from "vitest";
import { locationLabel } from "./AppHeader";

/**
 * The header's location label has failed twice, in the same direction: by
 * deriving something from the timezone. First the IANA zone's representative
 * city ("America/Los_Angeles" → "Los Angeles", to a captain in San Francisco —
 * a category error, since a zone id names offset RULES, not where anyone is);
 * then the zone abbreviation (PDT), true but useless beside a clock already
 * showing that fact. The rule now is total: a place name Daniel typed, or
 * NOTHING. This pins that the label is only ever the typed override.
 */
describe("locationLabel", () => {
  it("shows the typed place name", () => {
    expect(locationLabel("San Francisco")).toBe("San Francisco");
  });

  it("empty means NOTHING — no timezone fallback of any kind", () => {
    expect(locationLabel("")).toBeNull();
  });

  it("whitespace is empty, not a label", () => {
    expect(locationLabel("   ")).toBeNull();
  });
});
