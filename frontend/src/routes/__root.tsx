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
import { CollapsedSidebar } from "../components/notes/CollapsedSidebar";
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

// Paths where the Gooni chat orb (ChatLauncher + GooniMascot inside
// GooniLayer) is intentionally hidden. /creative is an immersive 3D
// world — the bottom-right FAB pops up over the plaza and breaks the
// scene. Sidebar still mounts on /creative; only the floating orb +
// mascot get suppressed.
function suppressGooniLayer(pathname: string): boolean {
  return pathname === "/creative" || pathname.startsWith("/creative/");
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

  // isNotes covers BOTH variants of the notes shell: a specific note
  // open via ?note=N, and the All-Notes discovery view via ?view=notes
  // (no specific id). The All Notes sidebar row keys its active state
  // off this prop, so omitting ?view=notes left the row inactive when
  // you clicked it. isChat similarly handles ?view=chat for parity.
  const isNotes = onIndex && (hasNote || viewParam === "notes");
  const isChat = onIndex && (hasConv || viewParam === "chat");
  const isLists = onIndex && hasList;
  const isEval = onIndex && auditFlag;
  const isDashboard =
    onIndex && !isNotes && !isChat && !isLists && !isEval;
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
    // createNote sets activeNoteId → NotesPage's effect on activeNoteId
    // rewrites the URL to ?note=<id>, which flips view to "notes".
    navigate({
      to: "/",
      search: {
        note: undefined,
        conv: undefined,
        list: undefined,
        audit: undefined,
        segment: undefined,
        view: undefined,
      },
      replace: true,
    });
  }

  function handleNewChat() {
    newChat();
    // No conv id yet (created on first send). ?view=chat forces chat view
    // in NotesPage; once a real convId lands, the activeConvId effect
    // rewrites the URL to ?conv=<id>.
    navigate({
      to: "/",
      search: {
        note: undefined,
        conv: undefined,
        list: undefined,
        audit: undefined,
        segment: undefined,
        view: "chat",
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
        view: undefined,
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
        list: undefined,
        audit: undefined,
        segment: undefined,
        view: "notes",
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
        list: undefined,
        audit: undefined,
        segment: undefined,
        view: undefined,
      },
    });
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
          scrollbar-color: rgba(15,23,42,0.20) transparent;
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
          background: rgba(15,23,42,0.18);
        }
        *::-webkit-scrollbar-thumb:hover {
          background: rgba(15,23,42,0.32);
        }
        *::-webkit-scrollbar-corner {
          background: transparent;
        }
      `}</style>
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
            activeListId={activeListId}
            showCompose={!isNotes}
            onLogoClick={gotoBlank}
            onSpaceSelect={gotoNotesView}
            onAllNotes={gotoNotesView}
            onSelectNote={handleSelectNote}
            onCompose={handleCompose}
            onNewChat={handleNewChat}
            onClose={() => setSidebarOpen(false)}
            onSelectList={(id) =>
              navigate({
                to: "/",
                search: {
                  note: undefined,
                  conv: undefined,
                  list: id,
                  audit: undefined,
                  segment: undefined,
                  view: undefined,
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
                  view: undefined,
                },
              })
            }
          />
        )}
        {/* Claude-style icon rail. Renders when sidebarOpen=false instead
            of completely hiding the sidebar — gives one-click access to
            New chat / Search / All Notes / Memories / Audit / Settings
            without expanding. Replaces the prior floating panel-open
            affordance. */}
        {!sidebarOpen && (
          <CollapsedSidebar
            isDashboard={isDashboard}
            isNotes={isNotes}
            isChat={isChat}
            isEval={isEval}
            onOpen={() => setSidebarOpen(true)}
            onLogoClick={gotoBlank}
            onAllNotes={gotoNotesView}
            onNewChat={handleNewChat}
            onOpenEval={() =>
              navigate({
                to: "/",
                search: {
                  note: undefined,
                  conv: undefined,
                  list: undefined,
                  audit: true,
                  segment: undefined,
                  view: undefined,
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
        {!suppressGooniLayer(location.pathname) && <GooniLayer />}
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
