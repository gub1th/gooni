import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Radio, FileText, MessageSquare, BarChart3, Brain, ClipboardList,
  Settings as SettingsIcon, type LucideIcon,
} from "lucide-react";
import { FONT, z } from "../../ui";
import { SettingsModal } from "../SettingsModal";
import { TracedOutline } from "./TracedOutline";

// Slice 3 — the nav is summoned too, but (unlike v1) it has a VISIBLE handle
// so you can actually find your way off the home. A faint 3-dot grip sits at
// the left-center edge; hover it (or the panel) and the frosted rail traces
// itself in. Leave → it retreats. Home is the only surface that swaps the
// docked sidebar for this.

const FADE_MS = 220;
const GRACE_MS = 280;

interface NavItem {
  label: string;
  Icon: LucideIcon;
  go: () => void;
}

export function SummonedNav() {
  const navigate = useNavigate();
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

  const items: NavItem[] = [
    { label: "Home", Icon: Radio, go: () => nav({}) },
    { label: "Log", Icon: ClipboardList, go: () => nav({ view: "log" }) },
    { label: "Notes", Icon: FileText, go: () => nav({ view: "notes" }) },
    { label: "Chat", Icon: MessageSquare, go: () => nav({ view: "chat" }) },
    { label: "Stats", Icon: BarChart3, go: () => nav({ view: "stats" }) },
    { label: "Memories", Icon: Brain, go: () => navigate({ to: "/memories", search: { focus: undefined } }) },
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
          <span key={i} style={{ width: 4, height: 4, borderRadius: 999, background: "rgba(244,245,244,0.7)" }} />
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
          color="rgba(244,245,244,0.55)"
          strokeWidth={1.25}
          glow={0.15}
          contentDelayMs={140}
          style={{ width: 208 }}
        >
          <div
            style={{
              padding: "14px 12px", borderRadius: 16,
              display: "flex", flexDirection: "column", gap: 3,
              background: "color-mix(in srgb, #0a0d0c 62%, transparent)",
              backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
            }}
          >
            <div style={{
              fontSize: 10, fontWeight: 700, letterSpacing: 1.6, textTransform: "uppercase",
              color: "rgba(255,255,255,0.4)", padding: "0 10px 8px",
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
                  color: "rgba(244,245,244,0.82)", fontFamily: FONT, fontSize: 13.5,
                  fontWeight: 500, textAlign: "left",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.07)")}
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
