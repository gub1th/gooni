import { Mic, MicOff, ScrollText } from "lucide-react";
import { FONT, z } from "../../ui";
import { ink } from "./ambientInk";
import { CORNER_ANCHOR, CornerButton, CornerThemeToggle } from "../shell/CornerChrome";
import { FocusDayStat } from "../focus/FocusDayStat";

// The two corners, Momentum's shape. Bare glyphs and bare text on the void —
// no frosted pill, no card. Chrome only earns a surface when it's summoned.
//
// Top-left is the date. Top-right is the SHARED corner cluster (`focused today`
// + the light/dark toggle, both from components/shell/CornerChrome) with two
// home-only glyphs slotted in: the mic, which reads accent-green while it is
// actually listening, and the log button. The log button wears a small accent
// dot when the day has a calendar event — the calendar is its own summoned
// surface, so the dot is a reason to open the log rather than a surface.
//
// The mic and the log do NOT travel to the other surfaces: they are home
// functions, not chrome. The frame around them is what has to be identical
// everywhere, and that now lives in one file rather than being written twice.

export function HomeDate() {
  const now = new Date();
  const label = now
    .toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
    .toLowerCase();
  return (
    <div
      style={{
        position: "fixed", top: "calc(var(--gooni-bar-h, 0px) + 22px)", left: 26, zIndex: z.overlay,
        fontFamily: FONT, fontSize: 11.5, color: ink(0.38), pointerEvents: "none",
      }}
    >
      {label}
    </div>
  );
}

export function HomeCorner({
  voiceOn,
  listening,
  onToggleVoice,
  onOpenLog,
  hasEventToday,
}: {
  voiceOn: boolean;
  /** mic actually hot right now — the only thing that turns the glyph green */
  listening: boolean;
  onToggleVoice: () => void;
  onOpenLog: () => void;
  hasEventToday: boolean;
}) {
  return (
    <div style={CORNER_ANCHOR}>
      <FocusDayStat />

      <CornerButton
        label={voiceOn ? (listening ? "listening — click to go silent" : "voice on — click to go silent") : "voice off — click to talk"}
        active={listening}
        onClick={onToggleVoice}
      >
        {voiceOn ? <Mic size={15} strokeWidth={1.7} /> : <MicOff size={15} strokeWidth={1.7} />}
      </CornerButton>

      {/* its own LOG glyph — the calendar icon moved inside the timeline tab */}
      <CornerButton
        label={hasEventToday ? "log — the day has a calendar event" : "log"}
        dot={hasEventToday}
        onClick={onOpenLog}
      >
        <ScrollText size={16} strokeWidth={1.7} />
      </CornerButton>

      <CornerThemeToggle />
    </div>
  );
}
