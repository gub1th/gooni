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
  light: {
    sidebar: "#F2F2F7",
    main: "#FAFAFA",
    bg: "#FAFAFA",
    card: "#FFFFFF",
    text: "#1C1C1E",
    muted: "#8E8E93",
    faint: "#AEAEB2",
    border: "#E5E5EA",
    hover: "#F2F2F7",
    inputBg: "#FFFFFF",
    disabled: "#C7C7CC",
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
