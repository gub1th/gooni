import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Radio, FileText, Brain,
  SearchCheck, Settings as SettingsIcon, type LucideIcon,
} from "lucide-react";
import { FONT, frost, z } from "../../ui";
import { SettingsModal } from "../SettingsModal";
import { TracedOutline } from "./TracedOutline";
import { WIDGETS } from "../widgets/registry";
import { useWidgetOverlayStore } from "../../stores/useWidgetOverlayStore";

// THE app nav — one rail, every surface (hoisted to AppShell in the
// unification pass; the docked sidebar is just the notes browser now).
// A faint 3-dot grip sits at the left-center edge; hover it (or the panel)
// and the frosted rail traces itself in. Leave → it retreats.

const FADE_MS = 220;
const GRACE_MS = 280;

interface NavItem {
  label: string;
  Icon: LucideIcon;
  go: () => void;
}

export function SummonedNav() {
  const navigate = useNavigate();
  const openWidget = useWidgetOverlayStore((s) => s.open);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);

  function summon() {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
  }
  function scheduleRetreat() {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), GRACE_MS);
  }

  const nav = (search: Record<string, unknown>) =>
    navigate({ to: "/", search: { note: undefined, conv: undefined, audit: undefined, segment: undefined, view: undefined, ...search } });

  // Every widget with a full panel gets a nav entry (opens its overlay).
  // Auto-extensible: register a widget → it appears here for free.
  const widgetItems: NavItem[] = WIDGETS.filter((w) => w.Panel).map((w) => ({
    label: w.title,
    Icon: w.Icon,
    go: () => openWidget(w.id, "week"),
  }));

  // Focus is the home now — it's reached via the visible top-right button, NOT
  // a nav entry (Daniel: "focus shouldn't be a sidebar item"). "Capture" points
  // at the waveform capture surface (/home).
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
      {/* visible handle — always faintly there so you know there's a way out */}
      <button
        aria-label="Open navigation"
        onMouseEnter={summon}
        onFocus={summon}
        onClick={summon}
        style={{
          position: "fixed", left: 10, top: "50%", transform: "translateY(-50%)",
          zIndex: z.overlay + 2, width: 22, height: 46, borderRadius: 12,
          border: "none", cursor: "pointer", padding: 0,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4,
          background: "transparent",
          opacity: open ? 0 : 0.6, transition: `opacity ${FADE_MS}ms ease`,
        }}
      >
        {[0, 1, 2].map((i) => (
          <span key={i} style={{ width: 4, height: 4, borderRadius: 999, background: "rgb(var(--gooni-ink, 244 245 244) / 0.7)" }} />
        ))}
      </button>

      {/* left-edge hot strip widens the summon target beyond the tiny grip */}
      <div
        onMouseEnter={summon}
        style={{ position: "fixed", top: 0, left: 0, bottom: 0, width: 16, zIndex: z.overlay + 1 }}
      />

      <div
        onMouseEnter={summon}
        onMouseLeave={scheduleRetreat}
        style={{
          position: "fixed", top: "50%", left: 16, transform: "translateY(-50%)",
          zIndex: z.overlay + 1, pointerEvents: open ? "auto" : "none",
        }}
      >
        <TracedOutline
          show={open}
          radius={16}
          color="transparent"
          strokeWidth={0}
          glow={0}
          contentDelayMs={140}
          style={{ width: 208 }}
        >
          <div
            style={{
              padding: "14px 12px", borderRadius: 16,
              display: "flex", flexDirection: "column", gap: 3,
              ...frost.chrome,
            }}
          >
            <div style={{
              fontSize: 10, fontWeight: 700, letterSpacing: 1.6, textTransform: "uppercase",
              color: "rgb(var(--gooni-ink, 244 245 244) / 0.4)", padding: "0 10px 8px",
            }}>
              gooni
            </div>
            {items.map((it) => (
              <button
                key={it.label}
                onClick={() => { it.go(); setOpen(false); }}
                style={{
                  display: "flex", alignItems: "center", gap: 11, padding: "9px 10px",
                  borderRadius: 9, cursor: "pointer", border: "none", background: "transparent",
                  color: "rgb(var(--gooni-ink, 244 245 244) / 0.82)", fontFamily: FONT, fontSize: 13.5,
                  fontWeight: 500, textAlign: "left",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgb(var(--gooni-ink, 244 245 244) / 0.07)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <it.Icon size={16} strokeWidth={1.9} color="rgba(74,222,128,0.9)" />
                {it.label}
              </button>
            ))}
          </div>
        </TracedOutline>
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
