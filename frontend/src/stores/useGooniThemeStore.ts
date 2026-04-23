import { create } from "zustand";
import { LocalStorageService } from "../services/localStorageService";

export type GooniTheme = "cool" | "warm" | "mint" | "rose" | "slate";

export const GOONI_THEMES: GooniTheme[] = ["cool", "warm", "mint", "rose", "slate"];

export interface ThemePalette {
  sidebar: string;
  main: string;
}

export const THEME_PALETTES: Record<GooniTheme, ThemePalette> = {
  cool:  { sidebar: "#F2F2F7", main: "#FAFAFA" }, // default — Apple-ish neutral
  warm:  { sidebar: "#EFECE5", main: "#F6F3EC" }, // cream / beige
  mint:  { sidebar: "#E6EEE8", main: "#F2F7F3" }, // subtle sage
  rose:  { sidebar: "#F2EBEA", main: "#FAF4F3" }, // soft blush
  slate: { sidebar: "#E7EAEF", main: "#F3F5F8" }, // cool blue-gray
};

export const GOONI_THEME_LABELS: Record<GooniTheme, string> = {
  cool:  "cool",
  warm:  "warm",
  mint:  "mint",
  rose:  "rose",
  slate: "slate",
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
