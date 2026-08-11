import { useState } from "react";
import { CalendarDays, Mic, MicOff } from "lucide-react";
import { FONT, frostInk, z } from "../../ui";
import { ink } from "./ambientInk";
import { fmtMinutes } from "../../services/focusTime";

// The two corners, Momentum's shape. Bare glyphs and bare text on the void —
// no frosted pill, no card. Chrome only earns a surface when it's summoned.
//
// Top-left is the date. Top-right is value-over-label (`focused today`), the
// mic as a bare icon that reads accent-green while it's listening, and the log
// button, which wears a small accent dot when the day has a calendar event.
// That dot is the whole remaining calendar surface.

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
  focusedMinutes,
  voiceOn,
  listening,
  onToggleVoice,
  onOpenLog,
  hasEventToday,
}: {
  focusedMinutes: number;
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
      <div style={{ textAlign: "right", lineHeight: 1.15 }}>
        <div style={{ fontSize: 19, fontWeight: 500, letterSpacing: "-0.01em", color: ink(0.92), fontVariantNumeric: "tabular-nums" }}>
          {fmtMinutes(focusedMinutes)}
        </div>
        <div style={{ fontSize: 10, letterSpacing: "0.02em", color: ink(0.38), marginTop: 2 }}>focused today</div>
      </div>

      <CornerButton
        label={voiceOn ? (listening ? "listening — click to go silent" : "voice on — click to go silent") : "voice off — click to talk"}
        active={listening}
        onClick={onToggleVoice}
      >
        {voiceOn ? <Mic size={15} strokeWidth={1.7} /> : <MicOff size={15} strokeWidth={1.7} />}
      </CornerButton>

      <CornerButton
        label={hasEventToday ? "log — the day has a calendar event" : "log"}
        dot={hasEventToday}
        onClick={onOpenLog}
      >
        <CalendarDays size={16} strokeWidth={1.7} />
      </CornerButton>
    </div>
  );
}
