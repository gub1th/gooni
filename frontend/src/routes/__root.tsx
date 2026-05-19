import { useEffect, useState } from "react";
import {
  createRootRoute,
  Outlet,
  useLocation,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { THEME_PALETTES, useGooniThemeStore } from "../stores/useGooniThemeStore";
import { QuickNav } from "../components/QuickNav";
import { QuickComposer } from "../components/QuickComposer";
import { ErrorView, NotFoundView } from "../components/ErrorView";
import { PasswordGate } from "../components/PasswordGate";
import { Sidebar } from "../components/notes/Sidebar";
import { GooniLayer } from "../components/GooniLayer";
import { useWindowWidth } from "../hooks/useWindowWidth";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { useConversationsStore } from "../stores/useConversationsStore";

// Pushes the current theme's tokens to CSS custom properties on <html>. Components
// read them via `var(--gooni-text, ...)` etc., with sensible light fallbacks so
// non-migrated components stay readable while migration proceeds incrementally.
function ThemeVarSync() {
  const theme = useGooniThemeStore((s) => s.theme);
  useEffect(() => {
    const palette = THEME_PALETTES[theme];
    const root = document.documentElement;
    const tokens: Record<string, string | undefined> = {
      "--gooni-bg":        palette.bg,
      "--gooni-card":      palette.card,
      "--gooni-text":      palette.text,
      "--gooni-muted":     palette.muted,
      "--gooni-border":    palette.border,
      "--gooni-hover":     palette.hover,
      "--gooni-input-bg":  palette.inputBg,
      "--gooni-disabled":  palette.disabled,
      "--gooni-sidebar":   palette.sidebar,
      "--gooni-main":      palette.main,
    };
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

const SIDEBAR_BREAKPOINT = 768;

// Paths that render their own chrome — sidebar stays unmounted there so
// the public portfolio doesn't leak owner-only affordances.
function isChromelessPath(pathname: string): boolean {
  return pathname === "/public" || pathname.startsWith("/public/");
}

// Single Sidebar instance for the whole authed app. Mounted once at
// root and persists across child route changes — replaces the per-route
// remount pattern that wiped sidebar scrollTop + in-memory state (drag,
// inline edit drafts) every time you clicked Memories / New chat.
// Routes render only their right-column content into <Outlet />.
function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const windowWidth = useWindowWidth();
  const [sidebarOpen, setSidebarOpen] = useState(windowWidth >= SIDEBAR_BREAKPOINT);
  useEffect(() => {
    setSidebarOpen(windowWidth >= SIDEBAR_BREAKPOINT);
  }, [windowWidth >= SIDEBAR_BREAKPOINT]);

  // Store actions invoked by Sidebar's compose / new-chat buttons.
  // Lifted from routes/index.tsx so the buttons work on every route.
  const selectedSpaceId = useNotesContentStore((s) => s.selectedSpaceId);
  const selectSpace = useNotesContentStore((s) => s.selectSpace);
  const createNote = useNotesContentStore((s) => s.createNote);
  const newChat = useConversationsStore((s) => s.newChat);

  if (isChromelessPath(location.pathname)) {
    return <Outlet />;
  }

  // URL-derive every Sidebar active flag. `/` is the multi-view route
  // (dashboard / notes / chat / lists / eval / stats); we pick the
  // current view from the same search-param signals routes/index.tsx
  // reads when it chooses what to render.
  const onIndex = location.pathname === "/";
  // TanStack Router types Search at the route level; at __root we don't
  // know it. Read the raw search blob and probe known keys defensively.
  const rawSearch: Record<string, unknown> =
    (routerState.location.search as Record<string, unknown>) ?? {};
  const hasNote = rawSearch.note != null && rawSearch.note !== "";
  const hasConv = rawSearch.conv != null && rawSearch.conv !== "";
  const hasList = rawSearch.list != null && rawSearch.list !== "";
  const auditFlag =
    rawSearch.audit === true || rawSearch.audit === "true" || rawSearch.audit === "1";
  const viewParam = typeof rawSearch.view === "string" ? rawSearch.view : null;

  const isNotes = onIndex && hasNote;
  const isChat = onIndex && hasConv;
  const isLists = onIndex && hasList;
  const isEval = onIndex && auditFlag;
  const isStats = onIndex && viewParam === "stats";
  const isDashboard =
    onIndex && !isNotes && !isChat && !isLists && !isEval && !isStats;
  const activeListId =
    isLists && typeof rawSearch.list === "number"
      ? (rawSearch.list as number)
      : isLists && typeof rawSearch.list === "string"
        ? Number(rawSearch.list) || null
        : null;

  // Compose / new-chat callbacks. The store actions live in Zustand
  // already; we just call them then navigate. routes/index.tsx's
  // useEffect on `search` repopulates / re-views accordingly.
  function handleCompose() {
    const spaceId = selectedSpaceId ?? "general";
    selectSpace(spaceId);
    createNote(spaceId);
    navigate({
      to: "/",
      search: {
        note: undefined,
        conv: undefined,
        list: undefined,
        audit: undefined,
        segment: undefined,
      },
      replace: true,
    });
  }

  function handleNewChat() {
    newChat();
    navigate({
      to: "/",
      search: {
        note: undefined,
        conv: undefined,
        list: undefined,
        audit: undefined,
        segment: undefined,
      },
      replace: true,
    });
  }

  function gotoBlank() {
    navigate({
      to: "/",
      search: {
        note: undefined,
        conv: undefined,
        list: undefined,
        audit: undefined,
        segment: undefined,
      },
    });
  }

  return (
    <PasswordGate>
      <div
        style={{
          display: "flex",
          height: "100vh",
          overflow: "hidden",
          background: "var(--gooni-bg, #FFFFFF)",
          position: "relative",
        }}
      >
        {sidebarOpen && (
          <Sidebar
            isDashboard={isDashboard}
            isNotes={isNotes}
            isChat={isChat}
            isLists={isLists}
            isEval={isEval}
            isStats={isStats}
            activeListId={activeListId}
            showCompose={!isNotes}
            onLogoClick={gotoBlank}
            onSpaceSelect={gotoBlank}
            onCompose={handleCompose}
            onNewChat={handleNewChat}
            onSelectList={(id) =>
              navigate({
                to: "/",
                search: {
                  note: undefined,
                  conv: undefined,
                  list: id,
                  audit: undefined,
                  segment: undefined,
                },
              })
            }
            onOpenEval={() =>
              navigate({
                to: "/",
                search: {
                  note: undefined,
                  conv: undefined,
                  list: undefined,
                  audit: true,
                  segment: undefined,
                },
              })
            }
            onOpenStats={() =>
              navigate({
                to: "/",
                // ?view=stats is the URL representation of the stats
                // tab — index.tsx reads it to decide what to render.
                search: ({
                  note: undefined,
                  conv: undefined,
                  list: undefined,
                  audit: undefined,
                  segment: undefined,
                  view: "stats",
                } as unknown) as {
                  note: undefined;
                  conv: undefined;
                  list: undefined;
                  audit: undefined;
                  segment: undefined;
                },
              })
            }
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
        <GooniLayer />
      </div>
    </PasswordGate>
  );
}

export const Route = createRootRoute({
  component: () => (
    <>
      <ThemeVarSync />
      <AppShell />
      {/* Cmd+K command palette — works on every route, including /public/*
          where the sidebar isn't mounted. Solves #134: getting from any
          page to a list (or any other surface) in two keystrokes. */}
      <QuickNav />
      {/* Cmd+E quick-capture composer — body-only, saves to General. */}
      <QuickComposer />
    </>
  ),
  // Tanstack Router's `errorComponent` doubles as a React error boundary
  // for everything below — catches render throws in any child route /
  // component so a bad .map() doesn't blank the page. `notFoundComponent`
  // owns unmatched URLs.
  errorComponent: ErrorView,
  notFoundComponent: NotFoundView,
});
