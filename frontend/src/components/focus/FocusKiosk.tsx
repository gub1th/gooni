import { FONT } from "../../ui";
import { GooniAsleep } from "./GooniAsleep";
import { FOCUS_PALETTES } from "./focusPalette";
import { FocusExpanded } from "./FocusExpanded";
import { FocusHistory } from "./FocusHistory";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { useFocusSessionStore } from "../../stores/useFocusSessionStore";

// `/focus` — DEMOTED (prototype pass 2) from "where focus happens" to a WINDOW
// onto it. The route survives, its meaning changed: this is a chromeless second
// monitor view of a session that is being driven from the banner on whatever
// surface you are actually working on.
//
// It renders `FocusExpanded`, which since pass 5 exists for this route alone —
// the dimmed overlay that also used it is gone, because on the home the session
// takes the wave's slot instead of stacking a second main thing on top. The
// kiosk deliberately does NOT drive the focus-cam reconcile target: that is
// owned once by `useFocusCamControl` in AppShell.
//
// `GooniAsleep` is the idle state, and it stays HERE rather than moving to the
// home: 2D SVG rather than WebGL because it paints for hours, slow full-figure
// drift for burn-in, low contrast because it is ambient. Those choices only earn
// out on an always-on screen, which is exactly what this route now is.
export function FocusKiosk() {
  const theme = useGooniThemeStore((s) => s.theme);
  const pal = FOCUS_PALETTES[theme];
  const session = useFocusSessionStore((s) => s.session);

  return (
    <div style={{ position: "fixed", inset: 0, background: pal.paper, fontFamily: FONT, overflow: "hidden" }}>
      {session ? (
        <FocusExpanded />
      ) : (
        <>
          <GooniAsleep pal={pal} />
          <div
            style={{
              position: "absolute", bottom: 44, left: 0, right: 0, textAlign: "center",
              fontSize: 12, color: pal.ink3,
            }}
          >
            focus starts from a task
            <FocusHistory pal={pal} />
          </div>
        </>
      )}
    </div>
  );
}
