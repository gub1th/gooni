import { useEffect, useMemo, useState } from "react";
import { ScrollText } from "lucide-react";
import { FONT, z } from "../../ui";
import { ink } from "../ambient/ambientInk";
import { CornerButton, CornerThemeToggle } from "./CornerChrome";
import { useHomeChromeStore } from "../../stores/useHomeChromeStore";
import { QuickFind } from "../ambient/QuickFind";
import { RAIL_LANE } from "../ambient/IconRail";
import { dragRegion } from "../../services/desktop";
import { useDisplayLocationStore } from "../../stores/useDisplayLocationStore";
import { fetchSettings, type ApiNote } from "../../services/api";

// ONE sticky header, on every non-immersive surface.
//
// Everything that used to be scattered along the top — the date floating at the
// left, the quickfind bar floating at the centre, a corner cluster at the right,
// and a separate focus band above all of them — is one row now. Four fixed
// elements at four different offsets is what made the top of the app read as
// unrelated pieces that happened to land near each other, and it is why the
// corner kept colliding with whatever a surface drew in its own top-right.
//
// The height is published as `--gooni-header-h` for the same reason the session
// band published its own: the things that must clear it are `position: fixed`
// with their own offsets and do not inherit the shell's padding.
//
// `focused today` is GONE — the captain did not want it. It was the only reason
// `FocusDayStat` existed on this surface.

export const HEADER_H = 52;

/**
 * What the notch must stay clear of on each side, in viewport terms.
 *
 * The bar is centred on the VIEWPORT, not inside the flex row, so flexbox can
 * no longer keep it off the date and the button cluster — a max width does.
 * Deliberately generous and symmetric: it only ever bites well below the
 * shell's minimum window width, where "the bar gets narrower" is the right
 * answer and "the bar slides under the settings icon" is not.
 */
const SIDE_RESERVE = 200;

/**
 * The header outranks every other fixed sibling on the surface, `LimboCards`
 * included: a lane that started inside this band was clipped, and raising it
 * over the header would only trade a clipped card for a covered header. It is
 * exported so the things that must stay UNDER it compare against this number
 * rather than re-deriving the offset — a second copy is how `top: 24` and
 * `TOP = 64` drifted apart.
 */
export const HEADER_Z = z.overlay + 5;

/**
 * The label under the header clock: a place name Daniel TYPED, or nothing.
 *
 * The label's history is two fallbacks, both removed. First the header printed
 * the IANA zone's trailing path segment as if it were a city —
 * "America/Los_Angeles" → "Los Angeles" to a captain in SF, a category error:
 * a zone id names a set of offset RULES and its city is only the
 * representative one. Then it fell back to the zone ABBREVIATION (PDT/PST),
 * which was at least true — but the captain's verdict was that it looks bad
 * and tells him nothing the clock beside it doesn't. So: a typed place name
 * (`useDisplayLocationStore`, Settings ▸ General), or the slot renders
 * NOTHING. Never anything derived from the timezone.
 */
export function locationLabel(override: string): string | null {
  const trimmed = override.trim();
  return trimmed ? trimmed : null;
}

function HeaderClock() {
  const [settingsTz, setSettingsTz] = useState<string | null>(null);
  useEffect(() => {
    void fetchSettings().then((s) => setSettingsTz(s.nudge_tz)).catch(() => {});
  }, []);
  const override = useDisplayLocationStore((s) => s.displayLocation);

  const tz = useMemo(() => {
    try {
      const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (browserTz) return browserTz;
    } catch { /* ignore */ }
    return settingsTz ?? undefined;
  }, [settingsTz]);

  // Ticks ON the minute rather than every 30s. A 30s poll against a display
  // whose smallest unit is a minute shows the wrong minute for up to half of
  // every one of them; this re-arms itself at each boundary so it also can't
  // drift. (`Date.now() % 60_000` finds the boundary because every real UTC
  // offset is a whole number of minutes.)
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let id = 0;
    function schedule() {
      id = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, 60_000 - (Date.now() % 60_000) + 50);
    }
    schedule();
    return () => window.clearTimeout(id);
  }, []);

  // Both read the SAME `now` and the SAME zone, so the date can never disagree
  // with the time beside it across a midnight tick.
  const date = now
    .toLocaleDateString(undefined, {
      weekday: "short", month: "short", day: "numeric", timeZone: tz,
    })
    .toLowerCase();
  const time = now.toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz,
  });
  // A typed place name, or nothing. Never anything derived from the zone.
  const location = locationLabel(override);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, userSelect: "none" }}>
      {/* Date stays LEFTMOST, as it was before the clock landed — the clock was
          meant to join it and replaced it instead. Baseline-aligned so the two
          read as one line rather than two stacked labels. */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, whiteSpace: "nowrap" }}>
        <div style={{ fontSize: 11.5, color: ink(0.38), lineHeight: 1 }}>
          {date}
        </div>
        <div style={{
          fontSize: 14, fontWeight: 600, color: ink(0.75),
          fontVariantNumeric: "tabular-nums", lineHeight: 1,
        }}>
          {time}
        </div>
      </div>
      {location && (
        <div style={{ fontSize: 9.5, color: ink(0.32), whiteSpace: "nowrap", lineHeight: 1 }}>
          {location}
        </div>
      )}
    </div>
  );
}

export function AppHeader({
  onOpenNote,
  onOpenTrackables,
}: {
  onOpenNote: (note: ApiNote) => void;
  onOpenTrackables: () => void;
}) {
  const logOpen = useHomeChromeStore((s) => s.logOpen);
  const toggleLog = useHomeChromeStore((s) => s.toggleLog);

  return (
    <div
      data-app-header
      style={{
        position: "fixed",
        // Below the session band while that still exists. The notch retires the
        // band, at which point `--gooni-bar-h` is permanently 0 and this is the
        // topmost row.
        top: "var(--gooni-bar-h, 0px)",
        // clears the rail lane, so the rail stays the leftmost thing on screen
        left: RAIL_LANE,
        right: 0,
        height: HEADER_H,
        zIndex: HEADER_Z,
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "0 26px",
        fontFamily: FONT,
        // THE WINDOW'S DRAG HANDLE, in the desktop shell only. `hiddenInset`
        // hides the title bar and gives the page the whole window, which leaves
        // the OS nothing to drag by — an unmovable window. This row is the
        // right handle: it spans the top, and everything in it that is not a
        // control is dead space. Every interactive child opts back OUT below;
        // a drag region swallows clicks, so anything clickable must say so.
        ...dragRegion("drag"),
        // A seam, not a toolbar: the void shows through and a hairline marks the
        // edge. A filled bar here would be the heaviest thing on a surface whose
        // whole premise is that chrome is dim, bare, or summoned.
        background: "transparent",
        borderBottom: `1px solid ${ink(0.06)}`,
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
      }}
    >
      <HeaderClock />

      {/* The search bar sits in the middle of the row and is the widest thing in
          it — deliberately, because pass 8 makes it the notch that carries the
          running session. It is centred on the VIEWPORT rather than in the flex
          row so it does not shift when the date's width changes across days.
          It said that before and was not doing it: `flex: 1` centres a child in
          whatever the date and the button cluster leave over, which is neither
          the viewport's centre nor stable across days. This header starts after
          the rail lane, so its own centre is exactly half a lane to the RIGHT of
          the viewport's — hence the offset, and hence RAIL_LANE being a shared
          constant rather than a `68` copied into a fourth file. The notch now
          lines up with the wave, which is the one thing on the home it is
          supposed to agree with. */}
      <div style={{ flex: 1, minWidth: 0 }} aria-hidden />
      <div
        style={{
          position: "absolute",
          left: `calc(50% - ${RAIL_LANE / 2}px)`,
          // Vertical stated OUTRIGHT rather than left to the static position an
          // abspos child of a flex container inherits — that resolves correctly
          // here, but it is a corner of the spec to be relying on for whether
          // the app's most-used control sits in the middle of its own row.
          top: "50%",
          transform: "translate(-50%, -50%)",
          display: "flex",
          justifyContent: "center",
          // Never grow into the date or the cluster: at a narrow window the bar
          // shrinks instead of sliding under them. In VIEWPORT units, because
          // that is what it is centred on.
          maxWidth: `calc(100vw - ${SIDE_RESERVE * 2}px)`,
          ...dragRegion("no-drag"),
        }}
      >
        <QuickFind onOpenNote={onOpenNote} onOpenTrackables={onOpenTrackables} />
      </div>

      <div
        style={{
          display: "flex", alignItems: "center", gap: 18, flex: "none",
          ...dragRegion("no-drag"),
        }}
      >
        {/* NO calendar dot. It used to wear an accent badge whenever the day
            had an event, and the captain's verdict on using it was that a dot
            says "something exists" without saying WHAT — you cannot decode it
            without opening the log and hunting the event out of a list. The
            notch now names the event outright, all day, so the dot has a
            strictly more informative sibling and is gone rather than doubled. */}
        {toggleLog && (
          <CornerButton label="log" active={logOpen} onClick={toggleLog}>
            <ScrollText size={16} strokeWidth={1.7} />
          </CornerButton>
        )}

        <CornerThemeToggle />
      </div>
    </div>
  );
}
