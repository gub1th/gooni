// Design tokens — single source of truth for the Gooni UI.
//
// Colors come in two flavors:
//   • theme tokens (`color.text`, `color.muted`, …) — resolve to the
//     `--gooni-*` CSS custom properties set in routes/__root.tsx, with the
//     historical light-mode hex baked in as the fallback. Using these keeps
//     dark mode working without per-call overrides.
//   • semantic accents (`color.accent`, `color.danger`, …) — fixed brand/
//     status hues that don't change with theme.
//
// Before this module these values were copy-pasted as raw hex across ~180
// files (the muted gray `#8E8E93` alone appeared 283×). Import from here.

export const FONT =
  "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

export const color = {
  // ── theme tokens (dark-mode aware via CSS vars) ──────────────────────────
  /** primary body text */
  text: "var(--gooni-text, #1C1C1E)",
  /** secondary / muted text + icons */
  muted: "var(--gooni-muted, #8E8E93)",
  /** faint text (placeholders, disabled labels) */
  faint: "var(--gooni-faint, #AEAEB2)",
  /** page background */
  bg: "var(--gooni-bg, #FAFAFA)",
  /** raised surface (cards, modals, inputs) */
  card: "var(--gooni-card, #FFFFFF)",
  /** hairline borders + dividers */
  border: "var(--gooni-border, #E5E5EA)",
  /** hover background tint */
  hover: "var(--gooni-hover, #F2F2F7)",
  /** input field background */
  inputBg: "var(--gooni-input-bg, #FFFFFF)",
  /** disabled control background */
  disabled: "var(--gooni-disabled, #C7C7CC)",

  // ── semantic accents (theme-independent) ─────────────────────────────────
  /** primary action / links */
  accent: "#0A84FF",
  /** destructive action */
  danger: "#FF3B30",
  /** danger text on light bg (darker, AA-contrast) */
  dangerText: "#B91C1C",
  /** success / positive */
  success: "#16A34A",
  /** success bright (badges on dark) */
  successBright: "#4ADE80",
  /** warning / pending */
  warning: "#F59E0B",
  /** warning text on light bg */
  warningText: "#92400E",

  /** pure white — for fixed surfaces that shouldn't theme-shift */
  white: "#FFFFFF",
} as const;

// Translucent overlays (modal backdrops, hover scrims). Kept separate because
// they're alpha layers, not solid tokens.
export const scrim = {
  backdrop: "rgba(0,0,0,0.32)",
  faint: "rgba(0,0,0,0.06)",
  soft: "rgba(0,0,0,0.10)",
} as const;

export const radius = {
  sm: 6,
  md: 8,
  lg: 12,
  pill: 999,
} as const;

// 4px base spacing scale.
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const fontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 24,
} as const;

// z-index ladder — single source of truth so overlays stop fighting. Before
// this was centralized, modals lived at BOTH 1000 and 10000, the chat orb
// tied the 1000 tier (so it pierced attachment/eval modals), and one-off
// surfaces squatted on 1300 / 1500 / 4000 / 9999. Every global layer now maps
// to one of these rungs; purely-local in-component stacking (small values
// within a single subtree's own stacking context) is left alone.
//
// Order, low → high:
//   dropdown   menus, popovers, context menus, kebab dropdowns
//   sticky     sticky section headers
//   fab        chat launcher orb — deliberately BELOW every modal
//   modalScrim full-screen modal backdrop (+ single-layer modal cards)
//   modalCard  modal card when it must layer above its own scrim
//   panel      docked / floating chat panel (sits above modals)
//   toast      transient toasts + flying animations, top of the stack
export const z = {
  dropdown: 100,
  sticky: 200,
  fab: 900,
  // Ambient overlay (Slice 4): frosted edge panels — above the log +
  // the fab, deliberately BELOW every modal so a modal always wins.
  overlay: 950,
  modalScrim: 1000,
  modalCard: 1010,
  panel: 1100,
  toast: 1200,
} as const;

// Ambient-surface visual tokens (Slice 4). Read via the CSS vars
// (--gooni-overlay-blur / --gooni-glow-dot, pushed per-theme in
// __root's ThemeVarSync) with these as light-theme fallbacks.
export const ambient = {
  overlayBlur: "18px",
  glowDot: "#0A84FF",
} as const;
