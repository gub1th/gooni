import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { frostInk } from "../../ui";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { ink } from "../ambient/ambientInk";

// The glyph vocabulary for the sticky header (`AppHeader`).
//
// These used to be the two top-right CORNER clusters — one on the home, one on
// the panel surfaces — written twice with different anchors and materials, which
// pass 7 collapsed into one shared set of primitives. Pass 8 finished the job by
// deleting the floating corner outright: everything it held now sits in the
// header row, so what survives here is the button and the theme toggle, not the
// positioning.
//
// `CORNER_ANCHOR` and `CORNER_RESERVE` went with it. The reserve existed because
// a fixed cluster floated ABOVE each surface and collided with whatever that
// surface drew in its own top-right (the note editor's Publish button, the
// ambient overlay's summon button). A header that occupies its own row and is
// cleared by the shell's padding cannot collide with anything, so both call
// sites went back to their natural insets.
//
// The treatment is the home's, which is the one that survived pass 7: a bare
// glyph on the void, dim at rest, brightening on hover. A frosted pill for a
// control at an edge inverts the rule that chrome only earns a surface when it
// is summoned.

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
