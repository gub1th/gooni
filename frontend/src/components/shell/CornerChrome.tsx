import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { FONT, frostInk, z } from "../../ui";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { ink } from "../ambient/ambientInk";

// THE top-right corner, owned by the shell and shared by every surface.
//
// It was written twice — once on the home (bare glyphs on the void, anchored
// 20/26) and once for the panel surfaces (34px frosted rounded buttons,
// anchored 14/14). Same slot, same job, two looks and two positions, so the
// chrome visibly jumped and changed material the moment you opened a surface.
// That is half of the "chrome behaves differently depending which surface you
// are on" complaint, and it is why these primitives now live in one file.
//
// The home's treatment is the one that survived: bare glyph on the void, dim
// at rest, brightening on hover. A frosted pill for a control that sits at an
// edge is exactly the chrome-earns-a-surface-only-when-summoned rule inverted —
// and it read as a second material floating over the panel behind it.
//
// The home adds two glyphs of its own (mic, log) INSIDE this same cluster.
// Those are home functions, not chrome, so they don't travel; the frame they
// sit in does.

/** Anchor every corner cluster identically — under the session band, same inset. */
export const CORNER_ANCHOR: React.CSSProperties = {
  position: "fixed",
  top: "calc(var(--gooni-bar-h, 0px) + 20px)",
  right: 26,
  zIndex: z.overlay + 3,
  display: "flex",
  alignItems: "center",
  gap: 20,
  fontFamily: FONT,
};

export function CornerButton({
  label,
  active,
  dot,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  /** small accent badge — a reason to open this, not a state of it */
  dot?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative", width: 26, height: 26, padding: 0,
        border: "none", background: "transparent", cursor: "pointer",
        display: "grid", placeItems: "center",
        color: active ? frostInk.accent : hover ? ink(0.9) : ink(0.38),
        transition: "color 150ms ease",
      }}
    >
      {children}
      {dot && (
        <span
          aria-hidden
          style={{
            position: "absolute", top: 1, right: 1, width: 6, height: 6, borderRadius: 999,
            background: frostInk.accent,
            // ring in the void colour so the dot reads as a badge, not a smudge
            boxShadow: "0 0 0 2px var(--gooni-void, #000)",
          }}
        />
      )}
    </button>
  );
}

/** The light/dark switch — the one control that is on every surface. */
export function CornerThemeToggle() {
  const theme = useGooniThemeStore((s) => s.theme);
  const setTheme = useGooniThemeStore((s) => s.setTheme);
  return (
    <CornerButton
      label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
    >
      {theme === "dark" ? <Sun size={15} strokeWidth={1.7} /> : <Moon size={15} strokeWidth={1.7} />}
    </CornerButton>
  );
}
