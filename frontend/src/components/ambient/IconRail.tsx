import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Radio, FileText, Brain, LayoutGrid, CalendarDays,
  SearchCheck, Settings as SettingsIcon, type LucideIcon,
} from "lucide-react";
import { FONT, frost, z } from "../../ui";
import { SettingsModal } from "../SettingsModal";

// THE app nav — a persistent centered pill of icons at the left edge (NOT a
// full-height strip): always visible so nav is discoverable, but light enough
// it doesn't wall off the ambient void. Icons at rest; each flies out its label
// on hover (an OVERLAY to the right — no reflow).
//
// It carries NO focus entry, deliberately: focus has exactly one door and it is
// a task row on the home. The widget entries it used to auto-list are gone with
// the widget system; `Trackables` (the log matrix) replaced the calendar one.

const INK = "rgb(var(--gooni-ink, 244 245 244)";
const ACCENT = "rgba(74,222,128,0.9)";

interface NavItem {
  label: string;
  Icon: LucideIcon;
  go: () => void;
}

export function IconRail() {
  const navigate = useNavigate();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);

  const nav = (search: Record<string, unknown>) =>
    navigate({ to: "/", search: { note: undefined, conv: undefined, audit: undefined, segment: undefined, view: undefined, trackables: undefined, calendar: undefined, ...search } });

  const items: NavItem[] = [
    { label: "Home", Icon: Radio, go: () => nav({}) },
    { label: "Trackables", Icon: LayoutGrid, go: () => nav({ trackables: true }) },
    { label: "Calendar", Icon: CalendarDays, go: () => nav({ calendar: true }) },
    { label: "Notes", Icon: FileText, go: () => nav({ view: "notes" }) },
    { label: "Memories", Icon: Brain, go: () => navigate({ to: "/memories", search: { focus: undefined } }) },
    { label: "Audit", Icon: SearchCheck, go: () => nav({ audit: true }) },
    { label: "Settings", Icon: SettingsIcon, go: () => setSettingsOpen(true) },
  ];

  return (
    <div style={{ fontFamily: FONT }}>
      <nav
        aria-label="Main navigation"
        style={{
          position: "fixed", left: 12, top: "50%", transform: "translateY(-50%)",
          zIndex: z.overlay + 2,
          display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
          padding: "8px 6px", borderRadius: 999,
          ...frost.chrome,
        }}
      >
        {items.map((it) => (
          <button
            key={it.label}
            onClick={it.go}
            onMouseEnter={() => setHovered(it.label)}
            onMouseLeave={() => setHovered((h) => (h === it.label ? null : h))}
            aria-label={it.label}
            style={{
              position: "relative",
              width: 40, height: 40, borderRadius: 999,
              display: "flex", alignItems: "center", justifyContent: "center",
              border: "none", cursor: "pointer", padding: 0,
              background: hovered === it.label ? `${INK} / 0.09)` : "transparent",
              transition: "background 140ms ease",
            }}
          >
            <it.Icon size={18} strokeWidth={1.9} color={ACCENT} />

            {/* label flyout — overlay to the right, no content push */}
            <span
              style={{
                position: "absolute", left: "calc(100% + 10px)", top: "50%",
                transform: `translateY(-50%) translateX(${hovered === it.label ? 0 : -4}px)`,
                whiteSpace: "nowrap", pointerEvents: "none",
                padding: "5px 10px", borderRadius: 8,
                fontSize: 12.5, fontWeight: 500,
                color: `${INK} / 0.9)`,
                ...frost.chrome,
                opacity: hovered === it.label ? 1 : 0,
                transition: "opacity 140ms ease, transform 140ms ease",
              }}
            >
              {it.label}
            </span>
          </button>
        ))}
      </nav>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
