import { CORNER_ANCHOR, CornerThemeToggle } from "../shell/CornerChrome";
import { FocusDayStat } from "../focus/FocusDayStat";

// Top-right chrome for the PANEL surfaces: `focused today` and the light/dark
// toggle. The home-jump button it used to sit beside pointed at `/home`, which
// no longer exists — `/` IS the ambient home now — and the focus button is gone
// because focus has exactly one door and it is a task row.
//
// Its frame is now the SHARED one (`CORNER_ANCHOR` + `CornerButton`), so this
// cluster and the home's sit in the same place and are made of the same thing.
// It used to be 34px frosted rounded buttons anchored 14/14 against the home's
// bare glyphs anchored 20/26 — the corner visibly moved and changed material
// the moment a surface opened.
//
// Mounted in AppShell for every non-immersive, non-kiosk surface EXCEPT the
// home, which mounts the same cluster plus its own mic and log glyphs.

export function TopRightControls() {
  return (
    <div style={CORNER_ANCHOR}>
      <FocusDayStat />
      <CornerThemeToggle />
    </div>
  );
}
