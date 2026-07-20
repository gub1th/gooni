import { create } from "zustand";
import { LocalStorageService } from "../services/localStorageService";

export type GooniTheme = "light" | "dark";

export const GOONI_THEMES: GooniTheme[] = ["light", "dark"];

// Two themes only. This palette is the SINGLE source of truth for the
// `--gooni-*` CSS vars (pushed in routes/__root.tsx), which the `src/ui`
// color tokens read. Values here MUST be raw hex/rgba — they DEFINE the
// tokens, so they can't reference them. (Previously 5 light variants + dark.)
export interface ThemePalette {
  sidebar: string;
  main: string;
  bg: string;
  card: string;
  text: string;
  muted: string;
  faint: string;
  border: string;
  hover: string;
  inputBg: string;
  disabled: string;
}

export const THEME_PALETTES: Record<GooniTheme, ThemePalette> = {
  // Warmed toward the public page's off-white + soft-green world (Daniel's
  // reference for "nice" light mode). Kept close to the Apple-neutral values so
  // existing light surfaces don't jar.
  light: {
    sidebar: "#F4F2EC",
    main: "#FBFAF7",
    bg: "#FBFAF7",
    card: "#FFFFFF",
    text: "#1C1C1E",
    muted: "#8A8A82",
    faint: "#B4B2AA",
    border: "#E7E4DC",
    hover: "#F1EFE8",
    inputBg: "#FFFFFF",
    disabled: "#C9C7BF",
  },
  dark: {
    sidebar: "#181818",
    main: "#1E1E1F",
    bg: "#1E1E1F",
    card: "#2A2A2C",
    text: "#E5E5E7",
    muted: "#9A9AA2",
    faint: "#6E6E73",
    border: "rgba(255,255,255,0.10)",
    hover: "rgba(255,255,255,0.06)",
    inputBg: "#2A2A2C",
    disabled: "rgba(255,255,255,0.10)",
  },
};

export const GOONI_THEME_LABELS: Record<GooniTheme, string> = {
  light: "light",
  dark: "dark",
};

// ── Ambient-surface base colors ──────────────────────────────────────────────
// The void home + all its chrome (nav, rail, sticky, widgets, log matrix) paint
// with these via the `--gooni-ink` / `--gooni-surf` / `--gooni-void` vars. `ink`
// and `surf` are SPACE-SEPARATED RGB TRIPLETS so one var carries every alpha the
// call sites need — `rgb(var(--gooni-ink) / 0.5)`. Dark = the historical
// near-white-on-black look (unchanged); light = dark-ink-on-warm-off-white,
// mirroring the public page.
export interface AmbientPalette {
  ink: string; // text/icon base — RGB triplet
  surf: string; // panel/fill base — RGB triplet
  void: string; // the app ground behind every sheet
}
export const AMBIENT_PALETTES: Record<GooniTheme, AmbientPalette> = {
  dark: { ink: "244 245 244", surf: "11 15 13", void: "#000000" },
  light: { ink: "28 28 30", surf: "250 249 246", void: "#f7f6f2" },
};

// The rest color of the breathing waveform (MorphLine sets `stroke` in JS, so it
// can't read a CSS var — it picks by theme). Dark = near-white line on black;
// light = ink line on off-white (a white line would vanish). Energy still blends
// this toward GREEN.
export const WAVE_REST_COLOR: Record<GooniTheme, string> = {
  dark: "#F4F5F4",
  light: "#1C1C1E",
};

// ── Frost-ink palette ────────────────────────────────────────────────────────
// The text/surface tokens for chrome floating on the void (audit, eval,
// memories, TurnTracePanel). `ui/frostInk` reads these via `--gooni-fi-*`, so
// flipping the whole audit surface light↔dark is just swapping this record. Dark
// values are byte-identical to the historical frostInk (dark look preserved);
// light is dark-on-warm. Keys mirror `frostInk` exactly (minus `mono`/`white`,
// which don't theme-shift).
export type FrostInkPalette = Record<string, string>;
export const FROST_INK_PALETTES: Record<GooniTheme, FrostInkPalette> = {
  dark: {
    text: "rgba(255,255,255,0.92)",
    strong: "rgba(255,255,255,0.92)",
    muted: "rgba(255,255,255,0.58)",
    faint: "rgba(255,255,255,0.40)",
    dim: "rgba(255,255,255,0.40)",
    sheet: "#000000",
    bg: "transparent",
    card: "#0C0C0C",
    cardRaised: "#141414",
    codeBg: "#0A0A0A",
    hover: "#141414",
    inputBg: "#141414",
    disabled: "#141414",
    border: "rgba(255,255,255,0.06)",
    hairline: "rgba(255,255,255,0.06)",
    accent: "#4ADE80",
    accentDim: "rgba(74,222,128,0.12)",
    good: "#4ADE80",
    warn: "#E0A83E",
    bad: "#F87171",
    badDim: "rgba(248,113,113,0.12)",
    danger: "#F87171",
    dangerText: "#F87171",
    success: "#4ADE80",
    successBright: "#4ADE80",
    warning: "#E0A83E",
    warningText: "#E0A83E",
  },
  light: {
    text: "rgba(17,17,19,0.92)",
    strong: "rgba(17,17,19,0.92)",
    muted: "rgba(17,17,19,0.56)",
    faint: "rgba(17,17,19,0.38)",
    dim: "rgba(17,17,19,0.38)",
    sheet: "#f7f6f2",
    bg: "transparent",
    card: "#ffffff",
    cardRaised: "#f3f2ec",
    codeBg: "#f0efe7",
    hover: "rgba(17,17,19,0.05)",
    inputBg: "#ffffff",
    disabled: "#ececec",
    border: "rgba(17,17,19,0.10)",
    hairline: "rgba(17,17,19,0.10)",
    accent: "#1b8b4a",
    accentDim: "rgba(27,139,74,0.12)",
    good: "#1b8b4a",
    warn: "#B45309",
    bad: "#DC2626",
    badDim: "rgba(220,38,38,0.10)",
    danger: "#DC2626",
    dangerText: "#DC2626",
    success: "#1b8b4a",
    successBright: "#1b8b4a",
    warning: "#B45309",
    warningText: "#B45309",
  },
};

// The three sanctioned frost-glass fills (chrome/panel/sheet). `ui/frost` reads
// them via `--gooni-frost-*`; blur is theme-invariant so only the tint swaps.
// Dark = the original dark glass over black; light = white glass over off-white.
export const FROST_SURFACE_PALETTES: Record<GooniTheme, Record<"chrome" | "panel" | "sheet", string>> = {
  dark: {
    chrome: "color-mix(in srgb, #0a0d0c 62%, transparent)",
    panel: "color-mix(in srgb, #0a0d0c 55%, transparent)",
    sheet: "color-mix(in srgb, #0a0d0c 38%, transparent)",
  },
  light: {
    chrome: "color-mix(in srgb, #ffffff 70%, transparent)",
    panel: "color-mix(in srgb, #ffffff 64%, transparent)",
    sheet: "color-mix(in srgb, #f7f6f2 58%, transparent)",
  },
};

interface ThemeStore {
  theme: GooniTheme;
  setTheme: (theme: GooniTheme) => void;
}

// Legacy themes (cool/warm/mint/rose/slate) all collapse to "light"; "dark"
// carries over. Anything unrecognized falls back to light.
function normalizeTheme(stored: string | null | undefined): GooniTheme {
  if (stored === "dark") return "dark";
  return "light";
}

function loadInitialTheme(): GooniTheme {
  return normalizeTheme(LocalStorageService.get<string>("gooni_theme", "light"));
}

export const useGooniThemeStore = create<ThemeStore>((set) => ({
  theme: loadInitialTheme(),
  setTheme: (theme) => {
    LocalStorageService.set("gooni_theme", theme);
    set({ theme });
  },
}));
