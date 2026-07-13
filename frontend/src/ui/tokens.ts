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

// Dark-frost ink palette — the text/surface tokens for chrome that floats on
// the black void (audit panels, eval, memories). Theme-INDEPENDENT dark glass,
// same as `frost` below: these read dark-on-void in BOTH themes, unlike
// `color.*` which follows the theme and goes WHITE in light mode (white cards
// on a black void — the bug this fixes). Key shape MIRRORS `color` so a legacy
// light surface migrates by swapping the import (`color as ctok` → `frostInk
// as ctok`) rather than rewriting every call site. Promoted from the palette
// that lived locally at the top of ambient/TurnTracePanel.tsx.
export const frostInk = {
  // ── text — EXACTLY 3 legible tiers; nothing renders below text-3 ──────────
  /** text-1 — primary content */
  text: "rgba(255,255,255,0.92)",
  /** alias of text-1 (headings) */
  strong: "rgba(255,255,255,0.92)",
  /** text-2 — secondary / metadata */
  muted: "rgba(255,255,255,0.58)",
  /** text-3 — micro-labels, timestamps, placeholders (the FLOOR — nothing dimmer) */
  faint: "rgba(255,255,255,0.40)",
  /** alias of text-3 — never dip below this */
  dim: "rgba(255,255,255,0.40)",

  // ── surfaces — depth via SURFACE, not outline (neutral, per spec) ────────
  /** canvas — the pure-black base a full audit surface sits on */
  sheet: "#000000",
  /** page base — transparent so the canvas shows through */
  bg: "transparent",
  /** surface — cards + panels */
  card: "#0C0C0C",
  /** surface-hi — hover / raised / inputs */
  cardRaised: "#141414",
  /** code / JSON block fill — one notch below surface, no stroke */
  codeBg: "#0A0A0A",
  /** hover background */
  hover: "#141414",
  /** input field background (surface-hi, no stroke) */
  inputBg: "#141414",
  /** disabled control background */
  disabled: "#141414",

  // ── hairline — dividers ONLY, sparingly (no card strokes) ─────────────────
  border: "rgba(255,255,255,0.06)",
  hairline: "rgba(255,255,255,0.06)",

  /** monospace stack for code / JSON blocks */
  mono: "'SF Mono', ui-monospace, Menlo, Monaco, monospace",

  // ── accent — GREEN is the ONLY accent in the product ─────────────────────
  /** accent green — links, active, primary text */
  accent: "#4ADE80",
  /** accent @ 12% — primary-button + active-pill fills */
  accentDim: "rgba(74,222,128,0.12)",
  good: "#4ADE80",
  /** muted amber — pending only */
  warn: "#E0A83E",
  /** muted red — negative TEXT (never a saturated solid fill) */
  bad: "#F87171",
  /** muted red @ 12% — negative fills */
  badDim: "rgba(248,113,113,0.12)",

  // ── legacy semantic aliases — retuned to green/muted so old call sites that
  //    read `.danger`/`.success`/`.warning`/`.accent` stop emitting blue ─────
  danger: "#F87171",
  dangerText: "#F87171",
  success: "#4ADE80",
  successBright: "#4ADE80",
  warning: "#E0A83E",
  warningText: "#E0A83E",
  white: "#FFFFFF",
} as const;

// Frosted-surface language of the ambient shell. THE three sanctioned frost
// levels — any summoned chrome (nav rails, edge panels, floating sheets)
// picks one instead of hand-rolling rgba+blur. Dark-glass over the void by
// design: frost reads against the black home surface in both themes.
export const frost = {
  /** nav rails + small summoned chrome (SummonedNav) */
  chrome: {
    background: "color-mix(in srgb, #0a0d0c 62%, transparent)",
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
  },
  /** edge panels + cards floating over the waveform (AmbientOverlay zones) */
  panel: {
    background: "color-mix(in srgb, #0a0d0c 55%, transparent)",
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
  },
  /** full-height view sheets summoned over the home void */
  sheet: {
    background: "color-mix(in srgb, #0a0d0c 38%, transparent)",
    backdropFilter: "blur(24px)",
    WebkitBackdropFilter: "blur(24px)",
  },
} as const;

// The frame every non-home view renders inside — a window floating on the
// void. Content keeps its own themed background; the frame supplies the
// inset, radius, and hairline that make it read as a summoned layer.
export const sheetFrame = {
  margin: 14,
  borderRadius: 18,
  // NO window border. The app sits on pure black; depth = radius + drop shadow
  // + surface-vs-void contrast. A hard 1px stroke here was the most out-of-
  // place thing on screen (nothing in the Whisper surfaces has one).
  border: "none",
  boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
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
