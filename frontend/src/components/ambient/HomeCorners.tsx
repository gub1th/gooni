import { useState } from "react";
import { Mic, MicOff, Moon, ScrollText, Sun } from "lucide-react";
import { FONT, frostInk, z } from "../../ui";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { ink } from "./ambientInk";
import { FocusBanner } from "../focus/FocusBanner";

// The two corners, Momentum's shape. Bare glyphs and bare text on the void —
// no frosted pill, no card. Chrome only earns a surface when it's summoned.
//
// Top-left is the date. Top-right is the FOCUS BANNER (the day summary at rest,
// the running session when there is one — see FocusBanner), the
// mic as a bare icon that reads accent-green while it's listening, the log
// button, and the light/dark toggle. The log button wears a small accent dot
// when the day has a calendar event — the calendar itself is a TAB inside the
// log sheet, so the dot is a reason to open the log rather than a surface.
//
// The theme toggle lives HERE rather than in the shared `TopRightControls`:
// the home owns its own corner, and two separate top-right clusters read as a
// mistake.

export function HomeDate() {
  const now = new Date();
  const label = now
    .toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
    .toLowerCase();
  return (
    <div
      style={{
        position: "fixed", top: 22, left: 26, zIndex: z.overlay,
        fontFamily: FONT, fontSize: 11.5, color: ink(0.38), pointerEvents: "none",
      }}
    >
      {label}
    </div>
  );
}

function CornerButton({
  label,
  active,
  dot,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
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
    <div
      style={{
        position: "fixed", top: 20, right: 26, zIndex: z.overlay,
        display: "flex", alignItems: "center", gap: 20, fontFamily: FONT,
      }}
    >
      <FocusBanner />

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

      <ThemeToggle />
    </div>
  );
}

function ThemeToggle() {
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
