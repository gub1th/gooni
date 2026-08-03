import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Radio, FileText, Brain,
  SearchCheck, Settings as SettingsIcon, type LucideIcon,
} from "lucide-react";
import { FONT, frost, z } from "../../ui";
import { SettingsModal } from "../SettingsModal";
import { WIDGETS } from "../widgets/registry";
import { useWidgetOverlayStore } from "../../stores/useWidgetOverlayStore";

// PROTOTYPE — persistent slim icon rail, an alternative to SummonedNav's
// hover-summoned panel. A floating centered pill (NOT a full-height strip):
// always visible so nav is discoverable on the dashboard, but light enough it
// doesn't wall off the ambient wave void. Icons at rest; each icon flies out
// its label on hover (an OVERLAY to the right — no content reflow, unlike a
// persistent labeled rail that pushes columns).
//
// Same item set + wiring as SummonedNav so it's a true drop-in.

const INK = "rgb(var(--gooni-ink, 244 245 244)";
const ACCENT = "rgba(74,222,128,0.9)";

interface NavItem {
  label: string;
  Icon: LucideIcon;
  go: () => void;
}

export function IconRail() {
  const navigate = useNavigate();
  const openWidget = useWidgetOverlayStore((s) => s.open);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);

  const nav = (search: Record<string, unknown>) =>
    navigate({ to: "/", search: { note: undefined, conv: undefined, audit: undefined, segment: undefined, view: undefined, ...search } });

  const widgetItems: NavItem[] = WIDGETS.filter((w) => w.Panel).map((w) => ({
    label: w.title,
    Icon: w.Icon,
    go: () => openWidget(w.id, "week"),
  }));

  const items: NavItem[] = [
    { label: "Capture", Icon: Radio, go: () => navigate({ to: "/home" }) },
    ...widgetItems,
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
