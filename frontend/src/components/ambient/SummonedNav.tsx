import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Radio, FileText, MessageSquare, BarChart3, Brain, ClipboardList,
  Settings as SettingsIcon, type LucideIcon,
} from "lucide-react";
import { FONT, z } from "../../ui";
import { SettingsModal } from "../SettingsModal";

// Slice 3 — even the nav isn't resident. A 12px hot strip on the left edge;
// hover it (or the panel) and a frosted glass rail slides in. Leave → it
// retreats after a short grace. Same visionOS frost recipe as AmbientOverlay,
// tuned dark for the black ambient home. Home is the only surface that swaps
// the docked sidebar for this; every other view keeps its normal chrome.

const FADE_MS = 200;
const GRACE_MS = 260;

interface NavItem {
  label: string;
  Icon: LucideIcon;
  go: () => void;
}

export function SummonedNav() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);

  function summon() {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
  }
  function retreat() {
    setVisible(false);
    closeTimer.current = window.setTimeout(() => setOpen(false), FADE_MS);
  }
  function scheduleRetreat() {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(retreat, GRACE_MS);
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
      {/* left-edge hot strip — invisible, just a hover target */}
      <div
        onMouseEnter={summon}
        style={{ position: "fixed", top: 0, left: 0, bottom: 0, width: 14, zIndex: z.overlay + 1 }}
      />

      {open && (
        <div
          onMouseEnter={summon}
          onMouseLeave={scheduleRetreat}
          style={{
            position: "fixed", top: 0, bottom: 0, left: 0, zIndex: z.overlay + 1,
            width: 210, padding: "60px 14px 24px",
            display: "flex", flexDirection: "column", gap: 4,
            background: "color-mix(in srgb, #0a0d0c 60%, transparent)",
            backdropFilter: "blur(var(--gooni-overlay-blur, 18px))",
            WebkitBackdropFilter: "blur(var(--gooni-overlay-blur, 18px))",
            borderRight: "1px solid rgba(255,255,255,0.08)",
            opacity: visible ? 1 : 0,
            transform: visible ? "translateX(0)" : "translateX(-14px)",
            transition: `opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease`,
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
              onClick={() => { it.go(); retreat(); }}
              style={{
                display: "flex", alignItems: "center", gap: 11,
                padding: "9px 10px", borderRadius: 9, cursor: "pointer",
                border: "none", background: "transparent",
                color: "rgba(244,245,244,0.82)", fontFamily: FONT,
                fontSize: 13.5, fontWeight: 500, textAlign: "left",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.07)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <it.Icon size={16} strokeWidth={1.9} color="rgba(74,222,128,0.9)" />
              {it.label}
            </button>
          ))}
        </div>
      )}

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
