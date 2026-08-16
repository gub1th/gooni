import { useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  FileText, Brain, LayoutGrid, CalendarDays,
  SearchCheck, type LucideIcon,
} from "lucide-react";
import { FONT, frost, z } from "../../ui";
import { GooniLogo } from "../GooniLogo";

// THE app nav — a persistent centered pill of icons at the left edge (NOT a
// full-height strip): always visible so nav is discoverable, but light enough
// it doesn't wall off the ambient void. Icons at rest; each flies out its label
// on hover (an OVERLAY to the right — no reflow).
//
// It carries NO focus entry, deliberately: focus has exactly one door and it is
// a task row on the home. The widget entries it used to auto-list are gone with
// the widget system; `Trackables` (the log matrix) replaced the calendar one.

const INK = "rgb(var(--gooni-ink, 244 245 244)";

// Distinct hue per item (Bear/Notion-style sidebar identity colors) instead
// of one flat accent green for everything — "home" carries no tint since
// it renders the mascot's own colors instead of a lucide icon.
//
// Desaturated on purpose (2026-08-15): the original hues were tuned as flat
// saturated swatches (#4ADE80/#F59E0B/#3B82F6/#A78BFA/#22D3EE) and read as a
// rainbow of neon dots against the dark, otherwise-calm ambient void — every
// icon competed for attention instead of just staying identifiable. These are
// the same hue family, pulled toward gray so they stay distinguishable at a
// glance without shouting.
const ICON_TINT = {
  Trackables: "#7FA88F", // muted sage green
  Calendar:   "#B99A6B", // muted amber
  Notes:      "#7B93B0", // muted slate blue
  Memories:   "#9C8FAD", // muted violet
  Audit:      "#6FA3A8", // muted teal
} as const;

/**
 * The lane the rail owns at the left edge — the shell reserves it, the header
 * starts after it, and the sliding panel stops clear of it.
 *
 * Exported because four places were spelling `68` independently, and one of
 * them (the header's centred quickfind) has to reason about HALF of it: the
 * header's own centre is offset from the viewport's by exactly this lane, which
 * is why the search bar had been sitting 16px left of the wave it is supposed
 * to line up with, drifting further whenever the date string changed length.
 */
export const RAIL_LANE = 68;

interface NavItem {
  label: string;
  Icon?: LucideIcon;
  color?: string;
  mascot?: boolean; // Home renders the Gooni character instead of a lucide glyph
  go: () => void;
}

export function IconRail() {
  const navigate = useNavigate();
  const [hovered, setHovered] = useState<string | null>(null);

  const nav = (search: Record<string, unknown>) =>
    navigate({ to: "/", search: { note: undefined, conv: undefined, audit: undefined, segment: undefined, view: undefined, trackables: undefined, calendar: undefined, ...search } });

  const items: NavItem[] = [
    { label: "Home", mascot: true, go: () => nav({}) },
    { label: "Trackables", Icon: LayoutGrid, color: ICON_TINT.Trackables, go: () => nav({ trackables: true }) },
    { label: "Calendar", Icon: CalendarDays, color: ICON_TINT.Calendar, go: () => nav({ calendar: true }) },
    { label: "Notes", Icon: FileText, color: ICON_TINT.Notes, go: () => nav({ view: "notes" }) },
    { label: "Memories", Icon: Brain, color: ICON_TINT.Memories, go: () => nav({ view: "memories" }) },
    { label: "Audit", Icon: SearchCheck, color: ICON_TINT.Audit, go: () => nav({ audit: true }) },
  ];

  // Which item is "current" — read straight off the URL (same signals
  // __root.tsx's own isNotes/isEval/etc derive from) so the rail can never
  // disagree with what routes/index.tsx actually renders. No prop threading:
  // this is the same raw-search-probe pattern __root.tsx already uses.
  const routerState = useRouterState();
  const onIndex = routerState.location.pathname === "/";
  const rawSearch: Record<string, unknown> = (routerState.location.search as Record<string, unknown>) ?? {};
  const hasNote = rawSearch.note != null && rawSearch.note !== "";
  const auditFlag = rawSearch.audit === true || rawSearch.audit === "true" || rawSearch.audit === "1" || rawSearch.audit === 1;
  const viewParam = typeof rawSearch.view === "string" ? rawSearch.view : null;
  const trackablesFlag = rawSearch.trackables === true || rawSearch.trackables === "true" || rawSearch.trackables === "1" || rawSearch.trackables === 1;
  const calendarFlag = rawSearch.calendar === true || rawSearch.calendar === "true" || rawSearch.calendar === "1" || rawSearch.calendar === 1;
  const isNotes = onIndex && (hasNote || viewParam === "notes");
  const isEval = onIndex && auditFlag;
  const isMemories = onIndex && viewParam === "memories";
  const isCalendar = onIndex && calendarFlag;
  const isTrackables = onIndex && trackablesFlag;
  const isHome = onIndex && !isNotes && !isEval && !isMemories && !isCalendar && !isTrackables;
  const activeLabel: string =
    isEval ? "Audit" :
    isNotes ? "Notes" :
    isMemories ? "Memories" :
    isCalendar ? "Calendar" :
    isTrackables ? "Trackables" :
    isHome ? "Home" : "";

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
        {items.map((it) => {
          const active = it.label === activeLabel;
          return (
          <button
            key={it.label}
            onClick={it.go}
            onMouseEnter={() => setHovered(it.label)}
            onMouseLeave={() => setHovered((h) => (h === it.label ? null : h))}
            aria-label={it.label}
            aria-current={active ? "page" : undefined}
            style={{
              position: "relative",
              width: 40, height: 40, borderRadius: 999,
              display: "flex", alignItems: "center", justifyContent: "center",
              border: "none", cursor: "pointer", padding: 0,
              // Active gets a faint standing tint; hover layers a touch more on
              // top of it — subtle enough it doesn't compete with the icon's own
              // (now-muted) color, but present at rest so "where am I" doesn't
              // require a hover to answer.
              background: active
                ? (hovered === it.label ? `${INK} / 0.13)` : `${INK} / 0.08)`)
                : (hovered === it.label ? `${INK} / 0.09)` : "transparent"),
              transition: "background 140ms ease",
            }}
          >
            {it.mascot
              ? <GooniLogo size={20} />
              : it.Icon && <it.Icon size={18} strokeWidth={1.9} color={it.color} style={{ opacity: active ? 1 : 0.72 }} />}

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
          );
        })}
      </nav>

    </div>
  );
}
