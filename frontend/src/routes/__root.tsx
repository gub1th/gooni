import { useEffect, useState } from "react";
import {
  createRootRoute,
  Outlet,
  useLocation,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import {
  THEME_PALETTES,
  AMBIENT_PALETTES,
  FOCUS_GLOW,
  FROST_INK_PALETTES,
  FROST_SURFACE_PALETTES,
  useGooniThemeStore,
} from "../stores/useGooniThemeStore";
import { QuickNav } from "../components/QuickNav";
import { QuickComposer } from "../components/QuickComposer";
import { ErrorView, NotFoundView } from "../components/ErrorView";
import { PasswordGate } from "../components/PasswordGate";
import { Sidebar } from "../components/notes/Sidebar";
// ONE app nav: the persistent IconRail pill. The hover-summoned SummonedNav it
// replaced was deleted with the widget system it hosted.
import { IconRail, RAIL_LANE } from "../components/ambient/IconRail";
import { FooterIsland } from "../components/shell/FooterIsland";
import { useFocusCamControl } from "../components/focus/useFocusCamControl";
import { SurfacePanel } from "../components/shell/SurfacePanel";
import { AppHeader, HEADER_H } from "../components/shell/AppHeader";
import { SettingsModal } from "../components/settings/SettingsModal";
import { useHomeChromeStore } from "../stores/useHomeChromeStore";
import { FocusKiosk } from "../components/focus/FocusKiosk";

// Pushes the current theme's tokens to CSS custom properties on <html>. Components
// read them via `var(--gooni-text, ...)` etc., with sensible light fallbacks so
// non-migrated components stay readable while migration proceeds incrementally.
function ThemeVarSync() {
  const theme = useGooniThemeStore((s) => s.theme);
  useEffect(() => {
    const palette = THEME_PALETTES[theme];
    const ambient = AMBIENT_PALETTES[theme];
    const frostSurf = FROST_SURFACE_PALETTES[theme];
    const root = document.documentElement;
    const tokens: Record<string, string | undefined> = {
      "--gooni-bg":        palette.bg,
      "--gooni-card":      palette.card,
      "--gooni-text":      palette.text,
      "--gooni-muted":     palette.muted,
      "--gooni-faint":     palette.faint,
      "--gooni-border":    palette.border,
      "--gooni-hover":     palette.hover,
      "--gooni-input-bg":  palette.inputBg,
      "--gooni-disabled":  palette.disabled,
      "--gooni-sidebar":   palette.sidebar,
      "--gooni-main":      palette.main,
      // Ambient overlay tokens (Slice 4). Blur is theme-invariant; the
      // glow dot brightens slightly on dark so it reads through the frost.
      "--gooni-overlay-blur": "18px",
      "--gooni-glow-dot":  theme === "dark" ? "#3B9CFF" : "#0A84FF",
      // Ambient-surface bases — the void home + its chrome read these as
      // `rgb(var(--gooni-ink) / α)` etc. Triplets so one var carries all alphas.
      "--gooni-ink":       ambient.ink,
      "--gooni-surf":      ambient.surf,
      "--gooni-void":      ambient.void,
      // Frost-glass fills (blur lives in the token; only the tint themes).
      "--gooni-frost-chrome": frostSurf.chrome,
      "--gooni-frost-panel":  frostSurf.panel,
      "--gooni-frost-sheet":  frostSurf.sheet,
      // Neutral surface-tint base for hovers/borders/dividers on themed cards
      // (settings, notes). White on dark, black on light — so a `rgb(var(
      // --gooni-tint) / α)` hairline is visible in BOTH themes (the historical
      // hardcoded rgba(0,0,0,…) vanished on dark). NOT for shadows/scrims.
      "--gooni-tint":      theme === "dark" ? "255 255 255" : "0 0 0",
      // The focus hue, as a real token rather than a literal — the wave reads it
      // in JS, but anything else that ever needs "a session is running" should
      // read the var rather than repeat the hex.
      "--gooni-focus":     FOCUS_GLOW[theme],
    };
    // Frost-ink palette (audit/eval/memories chrome) → --gooni-fi-<key>.
    for (const [k, v] of Object.entries(FROST_INK_PALETTES[theme])) {
      tokens[`--gooni-fi-${k}`] = v;
    }
    for (const [k, v] of Object.entries(tokens)) {
      if (v == null) root.style.removeProperty(k);
      else root.style.setProperty(k, v);
    }
    // Tag the body so we can opt-in to dark-mode-only CSS rules later.
    document.body.dataset.gooniTheme = theme;
    // Page background — keeps the chrome around fixed/scrollable areas dark
    // even before each component migrates to vars.
    if (palette.bg) document.body.style.background = palette.bg;
    else document.body.style.removeProperty("background");
  }, [theme]);
  return null;
}

// Paths that render their own chrome — sidebar stays unmounted there so
// the public portfolio doesn't leak owner-only affordances. `/focus` is the
// focus-system kiosk: a bare second-monitor display, so the ambient nav /
// sidebar / widget overlays stand down there too (it brings its own PasswordGate).
function isChromelessPath(pathname: string): boolean {
  return (
    pathname === "/public" ||
    pathname.startsWith("/public/") ||
    // The plaza is the public portfolio's front door, so it renders
    // bare — outside PasswordGate — like the rest of /public. It was
    // previously behind the gate, which meant the "wander the plaza"
    // link on the public page dead-ended at a password prompt for
    // every visitor. It reads only public notes + static content.
    pathname === "/creative" ||
    pathname === "/walk"
    // /focus used to be chromeless too, which is exactly why it never
    // slid in: the early-return below skips AppShell (and every
    // SurfacePanel it hosts) entirely for a chromeless path. It's gated
    // by the same shared PasswordGate now, so it stays OUT of this list;
    // see `isFocusRoute` for how it's kept visually distinct instead.
  );
}

// Immersive paths hide the ambient chrome (the icon rail + corner controls).
// /creative is an immersive 3D world — floating app nav pops over the plaza and
// breaks the scene. Sidebar still mounts there.
function isImmersivePath(pathname: string): boolean {
  return pathname === "/creative" || pathname.startsWith("/creative/");
}

// Single Sidebar instance for the whole authed app. Mounted once at
// root and persists across child route changes — replaces the per-route
// remount pattern that wiped sidebar scrollTop + in-memory state (drag,
// inline edit drafts) every time you clicked Memories / New chat.
// Routes render only their right-column content into <Outlet />.
function AppShell() {
  // ONE owner of the focus-cam reconcile target, mounted here because AppShell
  // survives every route change — see the hook for why no view may own it.
  useFocusCamControl();
  const location = useLocation();
  const navigate = useNavigate();
  const routerState = useRouterState();
  // Settings is a MODAL over whatever page you are on (pass 9), so its open
  // state lives here rather than in the URL — it is not a destination.
  const [settingsOpen, setSettingsOpen] = useState(false);

  // URL-derive every Sidebar active flag. `/` is the multi-view route
  // (log / notes / eval); we pick the current view from
  // the same search-param signals routes/index.tsx reads when it
  // chooses what to render.
  const onIndex = location.pathname === "/";
  // TanStack Router types Search at the route level; at __root we don't
  // know it. Read the raw search blob and probe known keys defensively.
  const rawSearch: Record<string, unknown> =
    (routerState.location.search as Record<string, unknown>) ?? {};
  const hasNote = rawSearch.note != null && rawSearch.note !== "";
  const auditFlag =
    rawSearch.audit === true || rawSearch.audit === "true" || rawSearch.audit === "1";
  const viewParam = typeof rawSearch.view === "string" ? rawSearch.view : null;

  // isNotes covers BOTH variants of the notes shell: a specific note
  // open via ?note=N, and the All-Notes discovery view via ?view=notes
  // (no specific id). The All Notes sidebar row keys its active state
  // off this prop, so omitting ?view=notes left the row inactive when
  // you clicked it.
  const isNotes = onIndex && (hasNote || viewParam === "notes");
  const isEval = onIndex && auditFlag;
  const isLog = onIndex && viewParam === "log";
  // Memories moved off its own `/memories` route onto the index route, so that
  // the home is mounted behind it for the panel to slide over. It has to be
  // named here for the same reason every other view is: without it `isHome`
  // stays true and the home paints its void straight over the panel.
  const isMemories = onIndex && viewParam === "memories";
  // The week grid is a surface too, not an overlay the home draws on itself.
  const isCalendar =
    onIndex &&
    (rawSearch.calendar === true || rawSearch.calendar === "true" || rawSearch.calendar === "1");
  // Trackables — the log matrix — moved off being an overlay AmbientHome drew
  // on itself onto a route view of its own, same reason memories/calendar did:
  // without it here, isHome stays true and the home paints its void straight
  // over the panel that is meant to be sliding over it.
  const isTrackables =
    onIndex &&
    (rawSearch.trackables === true || rawSearch.trackables === "true" || rawSearch.trackables === "1");
  // The ambient home is the index default — active when nothing else claims the
  // URL. It paints its own void and owns its own corners, so the docked sidebar
  // and the shared top-right cluster stand down here.
  const isHome = onIndex && !isNotes && !isEval && !isLog && !isMemories && !isCalendar && !isTrackables;
  // /focus is a real route, not a search param on "/" — it needs its own
  // persistent SurfacePanel (below) rather than the shared one SurfaceHost
  // drives, since that one is offset for the shared rail/header and /focus
  // renders neither (it's still a full-bleed, self-chromed hub).
  const isFocusRoute = location.pathname === "/focus";

  // The header's height, for the same reason the band publishes its own: the
  // things that must clear it are `position: fixed` with their own offsets and
  // never see the shell's padding. It replaces `--gooni-corner-w`, which existed
  // only because a floating corner cluster could collide with a surface's own
  // top-right controls — a header in its own row cannot.
  useEffect(() => {
    document.documentElement.style.setProperty("--gooni-header-h", `${HEADER_H}px`);
  }, []);

  function gotoBlank() {
    navigate({
      to: "/",
      search: {
        note: undefined,
        conv: undefined,
        audit: undefined,
        segment: undefined,
        view: undefined,
        trackables: undefined,
      },
    });
  }

  // Notes-view nav for surfaces with no specific note id (All Notes click,
  // space-row click). The Sidebar already mutates the store (selectSpace,
  // loadNotes); this just forces the route to render the notes view.
  function gotoNotesView() {
    navigate({
      to: "/",
      search: {
        note: undefined,
        conv: undefined,
        audit: undefined,
        segment: undefined,
        view: "notes",
        trackables: undefined,
      },
      replace: true,
    });
  }

  function handleSelectNote(id: number) {
    navigate({
      to: "/",
      search: {
        note: id,
        conv: undefined,
        audit: undefined,
        segment: undefined,
        view: undefined,
        trackables: undefined,
      },
    });
  }

  // /creative is its own immersive world — exempt from the sheet frame.
  const isImmersive = isImmersivePath(location.pathname);
  // Every non-home authed surface renders as a summoned layer over the void.
  // `/` (the ambient home) paints its own void ground full-bleed, so it is the
  // one authed surface that is NOT a sheet. /focus gets its OWN dedicated
  // panel below (full-bleed, own IconRail) rather than this shared one.
  const isSheet = !isHome && !isImmersive && !isChromelessPath(location.pathname) && !isFocusRoute;
  // Which non-home surface is showing — priority mirrors routes/index.tsx's
  // own `view` derivation so the two never disagree about what's on screen.
  const surfaceKey = isEval
    ? "eval"
    : isNotes
    ? "notes"
    : isLog
    ? "log"
    : isMemories
    ? "memories"
    : isCalendar
    ? "calendar"
    : isTrackables
    ? "trackables"
    : "home";

  // Esc = drop the summoned layer, back to presence. Skips text inputs and
  // open dialogs (the canonical Modal stopPropagation()s Escape at the
  // document level before this window listener fires).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
         t.tagName === "SELECT" || t.isContentEditable)
      ) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (!isSheet || isChromelessPath(location.pathname)) return;
      navigate({
        to: "/",
        search: { note: undefined, conv: undefined, audit: undefined, segment: undefined, view: undefined, trackables: undefined },
      });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSheet]);

  // Chromeless paths (public portfolio) render bare — checked AFTER all
  // hooks so the hook order is stable across paths (rules-of-hooks).
  if (isChromelessPath(location.pathname)) {
    return <Outlet />;
  }

  return (
    <PasswordGate>
      {/* Global thin/translucent scrollbar — applies to everything except
          explicit opt-outs. Daniel's "feels like part of the app" pass.
          Firefox uses scrollbar-width/color; WebKit uses ::-webkit-scrollbar.
          Track stays transparent; thumb fades in only on hover of the
          scrollable container so the bar is invisible at rest. */}
      <style>{`
        * {
          scrollbar-width: thin;
          scrollbar-color: transparent transparent;
        }
        *:hover {
          scrollbar-color: rgb(var(--gooni-tint, 0 0 0) / 0.20) transparent;
        }
        *::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        *::-webkit-scrollbar-track {
          background: transparent;
        }
        *::-webkit-scrollbar-thumb {
          background: transparent;
          border-radius: 4px;
          transition: background 0.18s ease;
        }
        *:hover::-webkit-scrollbar-thumb {
          background: rgb(var(--gooni-tint, 0 0 0) / 0.18);
        }
        *::-webkit-scrollbar-thumb:hover {
          background: rgb(var(--gooni-tint, 0 0 0) / 0.32);
        }
        *::-webkit-scrollbar-corner {
          background: transparent;
        }

        /* Dark-mode safety net for form controls. Many inputs/textareas
           set no inline background, so in dark they fell back to the
           browser default (white box + black text → unreadable). A
           stylesheet rule NEVER overrides an inline style, so this only
           touches BARE controls — any input that sets its own inline
           background/color keeps it. Scoped to dark so light can't
           regress (a transparent blend-in input stays transparent in
           light). inputBg ≈ card in dark, so blend-in inputs still blend. */
        body[data-gooni-theme="dark"] input,
        body[data-gooni-theme="dark"] textarea,
        body[data-gooni-theme="dark"] select {
          background-color: var(--gooni-input-bg, #2A2A2C);
          color: var(--gooni-text, #E5E5E7);
        }
        body[data-gooni-theme="dark"] input::placeholder,
        body[data-gooni-theme="dark"] textarea::placeholder {
          color: var(--gooni-faint, #6E6E73);
        }
      `}</style>
      <div
        style={{
          display: "flex",
          height: "100vh",
          // BORDER-BOX, or the header's reserved lane is added ON TOP of a
          // full-viewport height: `100vh + 52` is 52px of document overflow on
          // every surface. Invisible under macOS overlay scrollbars, which is
          // how it survived — but the desktop shell renders classic ones, so
          // the app opened with a permanent vertical scrollbar tracking nothing
          // and 11px narrower than the window. The wave measures
          // `window.innerWidth` (which counts the scrollbar) while everything
          // laid out counts the 11px less, so it also put the notch and the
          // wave permanently out of alignment.
          boxSizing: "border-box",
          overflow: "hidden",
          // The void is the app's ground; views float on it as sheets.
          background: isImmersive ? "var(--gooni-bg, #FFFFFF)" : "var(--gooni-void, #000000)",
          position: "relative",
          // Reserve a permanent left lane for the persistent IconRail so nothing
          // underlaps it. STATIC (not hover-driven) → no reflow jank. Immersive
          // surfaces (and /focus, which owns its own full-bleed chrome) get no
          // lane.
          paddingLeft: isImmersive || isFocusRoute ? 0 : RAIL_LANE,
          paddingTop: isImmersive || isFocusRoute ? 0 : HEADER_H,
        }}
      >
        {/* Non-home surfaces SLIDE IN as one panel over a home that stays
            put; the home renders plainly underneath. `sheetFrame` is retired
            as the page treatment — it framed every surface as a floating
            window, which is what made them read as pasted on. */}
        <SurfaceHost isSheet={isSheet} viewKey={surfaceKey} onDismiss={gotoBlank}>
        {/* Notes sidebar — always expanded when notes is the active view,
            no collapse toggle. It's the note browser only; app-level nav
            lives in IconRail, which stays visible alongside it. */}
        {isNotes && (
          <Sidebar
            onAllNotes={gotoNotesView}
            onSelectNote={handleSelectNote}
          />
        )}
        <div
          style={{
            flex: 1,
            display: "flex",
            minWidth: 0,
            position: "relative",
            overflow: "hidden",
          }}
        >
          <Outlet />
        </div>
        </SurfaceHost>
        {/* /focus's own persistent, full-bleed panel — see SurfaceHost above
            for why it can't share that one. Mounted here (not by the route
            switch) for the same reason SurfaceHost is: a node that first
            paints already open has no parked frame to animate FROM, so it
            has to live for the whole session and just sit off-screen until
            `isFocusRoute` flips it open. FocusKiosk renders its OWN IconRail
            inside, so the shared one below stands down whenever this is up. */}
        <SurfacePanel open={isFocusRoute} viewKey="focus" onDismiss={gotoBlank} fullBleed>
          <FocusKiosk />
        </SurfacePanel>
        {/* IconRail is THE app-level nav, always present — including on
            notes, where the Sidebar next to it is note-browser-only and
            carries no app nav of its own. /focus renders its own, so this
            one stands down there. */}
        {!isImmersive && !isFocusRoute && (
          <IconRail onOpenSettings={() => setSettingsOpen((o) => !o)} settingsActive={settingsOpen} />
        )}
        {!isImmersive && !isFocusRoute && <FooterIsland />}
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        {/* ONE sticky header, on every non-immersive surface — date, quickfind,
            mic, log, theme. It replaces four separately-positioned fixed
            elements plus the two rival corner clusters. Settings joins it when
            it becomes a surface; the rail still owns it. /focus stays
            chrome-less here — it's still a bare full-bleed hub, just one that
            now slides in rather than snapping open. */}
        {!isImmersive && !isFocusRoute && (
          <AppHeader
            onOpenNote={(n) => useHomeChromeStore.getState().openNote?.(n)}
            onOpenTrackables={() => navigate({ to: "/", search: { trackables: true } })}
          />
        )}
      </div>
    </PasswordGate>
  );
}

/**
 * One host for every surface. The panel is ALWAYS the container — on the home
 * it is simply parked off the right edge with nothing in it, because the home
 * renders through a body portal rather than through this tree.
 *
 * It used to swap between a plain div and the panel per route, which mounted
 * the panel already open and unmounted it on dismissal — so neither the
 * entrance nor the exit could animate, and a surface still arrived from
 * nowhere. Keeping one instance is what gives the motion an origin.
 */
function SurfaceHost({
  isSheet,
  viewKey,
  onDismiss,
  children,
}: {
  isSheet: boolean;
  viewKey: string;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  return (
    <SurfacePanel open={isSheet} viewKey={viewKey} onDismiss={onDismiss}>
      {children}
    </SurfacePanel>
  );
}

/** Cmd+K / Cmd+E, mounted only on authed surfaces. */
function OwnerShortcuts() {
  const location = useLocation();
  if (isChromelessPath(location.pathname)) return null;
  return (
    <>
      {/* Cmd+K command palette — works on every authed route, including
          ones where the sidebar isn't mounted. Solves #134: getting from
          any page to a list (or any other surface) in two keystrokes. */}
      <QuickNav />
      {/* Cmd+E quick-capture composer — body-only, saves to General. */}
      <QuickComposer />
    </>
  );
}

export const Route = createRootRoute({
  component: () => (
    <>
      <ThemeVarSync />
      <AppShell />
      {/* Owner-only shortcuts. These are siblings of AppShell, so the
          chromeless early-return inside it does NOT cover them — without
          this gate a visitor on /public, /creative or /walk could press
          Cmd+K and read the private app's navigation (Log, All Notes,
          Memories, Eval/Audit), or Cmd+E and get a composer that POSTs to
          the authed /notes. The requests 401, so nothing leaks, but it
          discloses the internal structure and hands visitors dead
          controls. */}
      <OwnerShortcuts />
    </>
  ),
  // Tanstack Router's `errorComponent` doubles as a React error boundary
  // for everything below — catches render throws in any child route /
  // component so a bad .map() doesn't blank the page. `notFoundComponent`
  // owns unmatched URLs.
  errorComponent: ErrorView,
  notFoundComponent: NotFoundView,
});
