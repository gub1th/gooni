import { Mic, MicOff, ScrollText, Settings as SettingsIcon } from "lucide-react";
import { FONT, z } from "../../ui";
import { ink } from "../ambient/ambientInk";
import { CornerButton, CornerThemeToggle } from "./CornerChrome";
import { useHomeChromeStore } from "../../stores/useHomeChromeStore";
import { QuickFind } from "../ambient/QuickFind";
import type { ApiNote } from "../../services/api";

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

function HeaderDate() {
  const label = new Date()
    .toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
    .toLowerCase();
  return (
    <div style={{ fontSize: 11.5, color: ink(0.38), whiteSpace: "nowrap", userSelect: "none" }}>
      {label}
    </div>
  );
}

export function AppHeader({
  onOpenNote,
  onOpenTrackables,
  onOpenSettings,
  settingsActive,
  onHome = false,
}: {
  onOpenNote: (note: ApiNote) => void;
  onOpenTrackables: () => void;
  /** absent until settings becomes a surface — the rail still owns it until then */
  onOpenSettings?: () => void;
  settingsActive?: boolean;
  /** the home is showing — the notch's re-attach control needs to know */
  onHome?: boolean;
}) {
  const voiceOn = useHomeChromeStore((s) => s.voiceOn);
  const listening = useHomeChromeStore((s) => s.listening);
  const hasEventToday = useHomeChromeStore((s) => s.hasEventToday);
  const logOpen = useHomeChromeStore((s) => s.logOpen);
  const toggleVoice = useHomeChromeStore((s) => s.toggleVoice);
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
        left: 68,
        right: 0,
        height: HEADER_H,
        zIndex: z.overlay + 5,
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "0 26px",
        fontFamily: FONT,
        // A seam, not a toolbar: the void shows through and a hairline marks the
        // edge. A filled bar here would be the heaviest thing on a surface whose
        // whole premise is that chrome is dim, bare, or summoned.
        background: "transparent",
        borderBottom: `1px solid ${ink(0.06)}`,
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
      }}
    >
      <HeaderDate />

      {/* The search bar sits in the middle of the row and is the widest thing in
          it — deliberately, because pass 8 makes it the notch that carries the
          running session. It is centred on the VIEWPORT rather than in the flex
          row so it does not shift when the date's width changes across days. */}
      <div style={{ flex: 1, display: "flex", justifyContent: "center", minWidth: 0 }}>
        <QuickFind onOpenNote={onOpenNote} onOpenTrackables={onOpenTrackables} onHome={onHome} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 18, flex: "none" }}>
        {toggleVoice && (
          <CornerButton
            label={voiceOn ? (listening ? "listening — click to go silent" : "voice on — click to go silent") : "voice off — click to talk"}
            active={listening}
            onClick={toggleVoice}
          >
            {voiceOn ? <Mic size={15} strokeWidth={1.7} /> : <MicOff size={15} strokeWidth={1.7} />}
          </CornerButton>
        )}

        {toggleLog && (
          <CornerButton
            label={hasEventToday ? "log — the day has a calendar event" : "log"}
            dot={hasEventToday}
            active={logOpen}
            onClick={toggleLog}
          >
            <ScrollText size={16} strokeWidth={1.7} />
          </CornerButton>
        )}

        <CornerThemeToggle />

        {/* Settings moved OUT of the left rail: the rail is navigation between
            surfaces, and settings is a tool. It is a slide-in surface like every
            other one now, so the rail entry was also the last thing pretending
            a modal was a destination. */}
        {onOpenSettings && (
          <CornerButton label="Settings" active={settingsActive} onClick={onOpenSettings}>
            <SettingsIcon size={15} strokeWidth={1.7} />
          </CornerButton>
        )}
      </div>
    </div>
  );
}
