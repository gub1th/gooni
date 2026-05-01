import { useEffect } from "react";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { THEME_PALETTES, useGooniThemeStore } from "../stores/useGooniThemeStore";

// Pushes the current theme's tokens to CSS custom properties on <html>. Components
// read them via `var(--gooni-text, ...)` etc., with sensible light fallbacks so
// non-migrated components stay readable while migration proceeds incrementally.
function ThemeVarSync() {
  const theme = useGooniThemeStore((s) => s.theme);
  useEffect(() => {
    const palette = THEME_PALETTES[theme];
    const root = document.documentElement;
    const tokens: Record<string, string | undefined> = {
      "--gooni-bg":        palette.bg,
      "--gooni-card":      palette.card,
      "--gooni-text":      palette.text,
      "--gooni-muted":     palette.muted,
      "--gooni-border":    palette.border,
      "--gooni-hover":     palette.hover,
      "--gooni-input-bg":  palette.inputBg,
      "--gooni-disabled":  palette.disabled,
      "--gooni-sidebar":   palette.sidebar,
      "--gooni-main":      palette.main,
    };
    for (const [k, v] of Object.entries(tokens)) {
      if (v == null) root.style.removeProperty(k);
      else root.style.setProperty(k, v);
    }
    // Tag the body so we can opt-in to dark-mode-only CSS rules later.
    document.body.dataset.gooniTheme = theme;
    // Page background — keeps the chrome around fixed/scrollable areas dark
    // even before each component migrates to vars.
    if (palette.bg) document.body.style.background = palette.bg;
    else document.body.style.removeProperty("background");
  }, [theme]);
  return null;
}

export const Route = createRootRoute({
  component: () => (
    <>
      <ThemeVarSync />
      <Outlet />
    </>
  ),
});
