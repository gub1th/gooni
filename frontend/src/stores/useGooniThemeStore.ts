import { create } from "zustand";
import { LocalStorageService } from "../services/localStorageService";

export type GooniTheme = "cool" | "warm" | "mint" | "rose" | "slate" | "dark";

export const GOONI_THEMES: GooniTheme[] = ["cool", "warm", "mint", "rose", "slate", "dark"];

// Light themes are background-only — text/card/border/etc fall back to the
// global hardcoded light defaults baked into components. Dark theme overrides
// every token so it actually reads dark across the migrated surfaces. Other
// surfaces still look light-themed under dark — follow-up PRs will migrate
// those incrementally as they get touched.
export interface ThemePalette {
  sidebar: string;
  main: string;
  // Optional tokens — only `dark` sets these; light themes use light defaults.
  bg?: string;
  card?: string;
  text?: string;
  muted?: string;
  border?: string;
  hover?: string;
  inputBg?: string;
  disabled?: string;
}

export const THEME_PALETTES: Record<GooniTheme, ThemePalette> = {
  cool:  { sidebar: "#F2F2F7", main: "#FAFAFA" }, // default — Apple-ish neutral
  warm:  { sidebar: "#EFECE5", main: "#F6F3EC" }, // cream / beige
  mint:  { sidebar: "#E6EEE8", main: "#F2F7F3" }, // subtle sage
  rose:  { sidebar: "#F2EBEA", main: "#FAF4F3" }, // soft blush
  slate: { sidebar: "#E7EAEF", main: "#F3F5F8" }, // cool blue-gray
  dark:  {
    sidebar: "#181818",
    main: "#1E1E1F",
    bg: "#1E1E1F",
    card: "#2A2A2C",
    text: "#E5E5E7",
    muted: "#9A9AA2",
    border: "rgba(255,255,255,0.10)",
    hover: "rgba(255,255,255,0.06)",
    inputBg: "#2A2A2C",
    disabled: "rgba(255,255,255,0.10)",
  },
};

export const GOONI_THEME_LABELS: Record<GooniTheme, string> = {
  cool:  "cool",
  warm:  "warm",
  mint:  "mint",
  rose:  "rose",
  slate: "slate",
  dark:  "dark",
};

interface ThemeStore {
  theme: GooniTheme;
  setTheme: (theme: GooniTheme) => void;
}

function loadInitialTheme(): GooniTheme {
  const stored = LocalStorageService.get<GooniTheme>("gooni_theme", "cool");
  if (stored && GOONI_THEMES.includes(stored)) return stored;
  return "cool";
}

export const useGooniThemeStore = create<ThemeStore>((set) => ({
  theme: loadInitialTheme(),
  setTheme: (theme) => {
    LocalStorageService.set("gooni_theme", theme);
    set({ theme });
  },
}));
