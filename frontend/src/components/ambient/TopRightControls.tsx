import { useNavigate } from "@tanstack/react-router";
import { Radio, Sun, Moon, Target, type LucideIcon } from "lucide-react";
import { FONT, z } from "../../ui";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";

// Always-visible top-right chrome: the two controls Daniel wanted OUT of the
// hover nav — a home jump and the light/dark toggle. Focus is no longer a
// sidebar item; this button is the visible way to it. On the Focus home the
// jump instead points at the waveform capture surface (/home), so the pair is
// never a dead "you're already here" button.
//
// Mounted once in AppShell for every non-immersive, non-kiosk surface.

function IconButton({
  Icon,
  label,
  onClick,
}: {
  Icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        width: 34,
        height: 34,
        borderRadius: 10,
        cursor: "pointer",
        padding: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.12)",
        background: "rgb(var(--gooni-surf, 11 15 13) / 0.42)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        color: "rgb(var(--gooni-ink, 244 245 244) / 0.68)",
        transition: "color 160ms ease, background 160ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "rgb(var(--gooni-ink, 244 245 244) / 0.95)";
        e.currentTarget.style.background = "rgb(var(--gooni-ink, 244 245 244) / 0.08)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "rgb(var(--gooni-ink, 244 245 244) / 0.68)";
        e.currentTarget.style.background = "rgb(var(--gooni-surf, 11 15 13) / 0.42)";
      }}
    >
      <Icon size={16} strokeWidth={1.9} />
    </button>
  );
}

export function TopRightControls({ isFocusHome }: { isFocusHome: boolean }) {
  const navigate = useNavigate();
  const theme = useGooniThemeStore((s) => s.theme);
  const setTheme = useGooniThemeStore((s) => s.setTheme);

  return (
    <div
      style={{
        position: "fixed",
        top: 14,
        right: 14,
        zIndex: z.overlay + 3,
        display: "flex",
        gap: 8,
        fontFamily: FONT,
      }}
    >
      {isFocusHome ? (
        <IconButton
          Icon={Radio}
          label="Capture (waveform home)"
          onClick={() => navigate({ to: "/home" })}
        />
      ) : (
        <IconButton
          Icon={Target}
          label="Focus"
          onClick={() =>
            navigate({
              to: "/",
              search: { note: undefined, conv: undefined, audit: undefined, segment: undefined, view: undefined },
            })
          }
        />
      )}
      <IconButton
        Icon={theme === "dark" ? Sun : Moon}
        label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      />
    </div>
  );
}
