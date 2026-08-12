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

// The `dot` badge is GONE. Its only consumer was the log button's calendar dot,
// and that dot was the least useful form of a notification: it said something
// existed without saying what, and decoding it meant opening the log and finding
// the event buried in a list. The notch names the event outright now. The prop
// is deleted rather than left exported for the same reason `sheetFrame` was —
// an unused affordance is an invitation to reach for it again.

export function CornerButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
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
        width: 26, height: 26, padding: 0,
        border: "none", background: "transparent", cursor: "pointer",
        display: "grid", placeItems: "center",
        color: active ? frostInk.accent : hover ? ink(0.9) : ink(0.38),
        transition: "color 150ms ease",
      }}
    >
      {children}
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
