import { Sun, Moon, type LucideIcon } from "lucide-react";
import { FONT, z } from "../../ui";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { FocusBanner } from "../focus/FocusBanner";

// Top-right chrome for the SHEET surfaces: the light/dark toggle, and nothing
// else. The home-jump button it used to sit beside pointed at `/home`, which no
// longer exists — `/` IS the ambient home now — and the focus button is gone
// because focus has exactly one door and it is a task row.
//
// It also carries the FOCUS BANNER, so a running session and its pause/resume
// follow you onto every non-home surface. That is the whole point of pass 2:
// focus is a state, not a place, so its controls cannot live on one route.
//
// Mounted in AppShell for every non-immersive, non-kiosk surface EXCEPT the
// home, which owns its own top-right cluster (and mounts the banner there).

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

export function TopRightControls() {
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
        alignItems: "center",
        gap: 12,
        fontFamily: FONT,
      }}
    >
      <FocusBanner />
      <IconButton
        Icon={theme === "dark" ? Sun : Moon}
        label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      />
    </div>
  );
}
