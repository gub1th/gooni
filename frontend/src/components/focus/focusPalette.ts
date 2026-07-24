// Two-mode palette for the focus arcs canvas — ported verbatim from the
// reference mockup (gooni-arcs-events.html). Kept LOCAL to the focus surfaces
// (not the app's --gooni-* vars) so the arcs-specific tokens — spine, lift
// shadows, event tint — are fully under this surface's control.
//
// Dark: charcoal ground, raised cards, GLOW as the elevation cue (shadows don't
// read on dark). Light: warm off-white paper, white cards, soft drop shadow.

import type { GooniTheme } from "../../stores/useGooniThemeStore";

export interface FocusPalette {
  paper: string; // page ground
  card: string; // thought card surface
  ink: string; // primary text
  ink2: string; // secondary text
  ink3: string; // tertiary / labels
  accent: string; // the single green
  rule: string; // hairlines
  warn: string; // flags
  spine: string; // gutter spine
  lift: string; // card shadow (hover)
  liftSm: string; // card shadow (rest)
  tint: number; // event-card bg tint strength (0..1)
  event: string; // event-card category ink (device telemetry)
}

export const FOCUS_PALETTES: Record<GooniTheme, FocusPalette> = {
  light: {
    paper: "#F6F3EC",
    card: "#FFFFFF",
    ink: "#2B2A25",
    ink2: "#8C8B82",
    ink3: "#B4B3A9",
    accent: "#3D9F6B",
    rule: "rgba(43,42,37,.09)",
    warn: "#C4703A",
    spine: "rgba(43,42,37,.13)",
    lift: "0 1px 2px rgba(43,42,37,.04),0 10px 28px rgba(43,42,37,.055)",
    liftSm: "0 1px 2px rgba(43,42,37,.04),0 4px 14px rgba(43,42,37,.045)",
    tint: 0.13,
    event: "#8E93A8",
  },
  dark: {
    paper: "#161714",
    card: "#1F211D",
    ink: "#E8E7DF",
    ink2: "#8E9086",
    ink3: "#5E6058",
    accent: "#58C88C",
    rule: "rgba(232,231,223,.1)",
    warn: "#E09A62",
    spine: "rgba(232,231,223,.14)",
    lift: "0 0 0 1px rgba(232,231,223,.05),0 14px 40px rgba(0,0,0,.55)",
    liftSm: "0 0 0 1px rgba(232,231,223,.05),0 6px 20px rgba(0,0,0,.45)",
    tint: 0.17,
    event: "#8E93A8",
  },
};
