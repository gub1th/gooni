import { create } from "zustand";
import { LocalStorageService } from "../services/localStorageService";

export type GooniTheme = "cool" | "warm";

export const GOONI_THEMES: GooniTheme[] = ["cool", "warm"];

export interface ThemePalette {
  sidebar: string;
  main: string;
}

export const THEME_PALETTES: Record<GooniTheme, ThemePalette> = {
  cool: { sidebar: "#F2F2F7", main: "#FAFAFA" },
  warm: { sidebar: "#EFECE5", main: "#F6F3EC" },
};

export const GOONI_THEME_LABELS: Record<GooniTheme, string> = {
  cool: "cool",
  warm: "warm",
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
