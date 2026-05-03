import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChatView } from "../components/ChatView";
import { Dashboard } from "../components/Dashboard";
import { EvalView } from "../components/eval/EvalView";
import { StatsView } from "../components/StatsView";
import { Globe, Plug } from "lucide-react";
import { GooniLayer } from "../components/GooniLayer";
import { ListView } from "../components/lists/ListView";
import { NoteEditor } from "../components/notes/NoteEditor";
import { NotesList } from "../components/notes/NotesList";
import { PlanView } from "../components/PlanView";
import { Sidebar } from "../components/notes/Sidebar";
import { PasswordGate } from "../components/PasswordGate";
import { useWindowWidth } from "../hooks/useWindowWidth";
import { useListsStore } from "../stores/useListsStore";
import { useNotesContentStore } from "../stores/useNotesContentStore";
import { useSpacesStore } from "../stores/useSpacesStore";
import { useConversationsStore } from "../stores/useConversationsStore";
import { fetchNote } from "../services/api";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    note: typeof search.note === "number" ? search.note : typeof search.note === "string" ? Number(search.note) : undefined,
    conv: typeof search.conv === "number" ? search.conv : typeof search.conv === "string" ? Number(search.conv) : undefined,
    list: typeof search.list === "number" ? search.list : typeof search.list === "string" ? Number(search.list) : undefined,
    // ?audit=1 → land on the Audit (eval) view. Lets the Sidebar Audit
    // button navigate from any route (including /memories, /chat-audit)
    // without each route having to wire an onOpenEval prop.
    audit: search.audit === true || search.audit === "true" || search.audit === "1" || undefined,
  }),
  component: NotesPage,
});

// Sidebar auto-collapses below this width
const SIDEBAR_BREAKPOINT = 768;

const topRightBtn: React.CSSProperties = {
  height: 30, borderRadius: 8,
  border: "0.5px solid rgba(0,0,0,0.08)",
  background: "rgba(255,255,255,0.85)",
  backdropFilter: "blur(6px)",
  WebkitBackdropFilter: "blur(6px)",
  cursor: "pointer",
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  color: "#3C3C43",
  padding: "0 10px",
  gap: 6,
  fontSize: 12,
  fontWeight: 500,
  transition: "background 0.12s",
  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
};

function NotesPage() {
  const fetchSpaces = useSpacesStore((s) => s.fetch);
  const { selectedSpaceId, selectSpace, loadNotes, createNote, selectNote } = useNotesContentStore();
  const windowWidth = useWindowWidth();
  const { fetchConversations, newChat, selectConversation } = useConversationsStore();
  const fetchAllLists = useListsStore((s) => s.fetchAll);
  const navigate = useNavigate({ from: "/" });
  const search = Route.useSearch();

  // Initialize view from URL so deep-linking a note doesn't flash the dashboard first.
  const [view, setView] = useState<"notes" | "dashboard" | "chat" | "lists" | "plan" | "eval" | "stats">(() =>
    search.audit ? "eval" : search.note ? "notes" : search.conv ? "chat" : search.list ? "lists" : "dashboard"
  );
  const [activeListId, setActiveListId] = useState<number | null>(search.list ?? null);
  // Note currently being planned (set by Dashboard's "💬 Plan this" pill).
  // Lives in route state so the Plan view can mount/unmount cleanly without
  // polluting the conversations store with a "current planning target" field.
  const [planNoteId, setPlanNoteId] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(windowWidth >= SIDEBAR_BREAKPOINT);

  useEffect(() => {
    setSidebarOpen(windowWidth >= SIDEBAR_BREAKPOINT);
  }, [windowWidth >= SIDEBAR_BREAKPOINT]);

  // Initial load: restore from URL params
  useEffect(() => {
    fetchSpaces();
    fetchConversations();
    fetchAllLists();
    // Note: search.note / search.conv handling moved to dedicated effect below
    // so navigation TO this page (e.g. from the notes-map "open this note")
    // also takes effect, not just the first mount.
  }, []);

  // React to search.note changes — fires both on initial mount and on
  // subsequent navigations (e.g. clicking a node in the notes map while
  // already on /). Without this, navigate({ to: "/", search: { note } })
  // from elsewhere would silently no-op when the page is already mounted.
  useEffect(() => {
    if (!search.note) return;
    fetchNote(search.note).then((note) => {
      const noteSpaceId = note.space_id == null ? "general" : String(note.space_id);
      // Don't yank the user out of "All Notes" just because they clicked a
      // note that lives in a specific space. If selectedSpaceId is "general"
      // (or unset), keep them there so the second column doesn't reflow.
      // Otherwise, follow the note into its space — that's the deep-link
      // case (notes-map / search), where the user expects to land in
      // context.
      const current = useNotesContentStore.getState().selectedSpaceId;
      const stayOnAllNotes = current == null || current === "general";
      const targetSpace = stayOnAllNotes ? "general" : noteSpaceId;
      if (!stayOnAllNotes && current !== noteSpaceId) {
        selectSpace(noteSpaceId);
      } else if (current == null) {
        selectSpace("general");
      }
      // Seed the fetched note into the store so NoteEditor finds it on the
      // very next render. Without this, selectNote sets activeNoteId but the
      // editor's lookup `notes[spaceId].find(n => n.id === activeNoteId)`
      // returns undefined until loadNotes resolves — leaving Daniel staring
      // at an empty "All Notes" screen for the duration of that fetch.
      useNotesContentStore.setState((s) => {
        const existing = s.notes[targetSpace] ?? [];
        const deduped = existing.filter((n) => n.id !== note.id);
        return { notes: { ...s.notes, [targetSpace]: [note, ...deduped] } };
      });
      selectNote(note.id);
      loadNotes(targetSpace);
      setView("notes");
    }).catch(() => {
      setView("dashboard");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.note]);

  // Same pattern for conversation deep-links.
  useEffect(() => {
    if (!search.conv) return;
    selectConversation(search.conv);
    setView("chat");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.conv]);

  // ?audit=1 lands directly on the Audit tab.
  useEffect(() => {
    if (search.audit) setView("eval");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.audit]);

  useEffect(() => {
    if (view === "notes") {
      const spaceId = selectedSpaceId ?? "general";
      if (!selectedSpaceId) selectSpace("general");
      loadNotes(spaceId);
    }
  }, [view]);

  // (Auto-select on space entry was removed — it caused confusing behavior when the
  //  most-recent note lived in both a specific space and All Notes. The editor now
  //  shows an empty state, and the user picks a note from the rail.)

  useEffect(() => {
    if (view !== "notes" && selectedSpaceId) {
      selectSpace(null);
    }
  }, [view, selectedSpaceId]);

  // Cmd+N: new note
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        handleCompose();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedSpaceId, view]);

  function setViewAndUrl(
    v: "notes" | "dashboard" | "chat" | "lists" | "plan" | "eval" | "stats",
    noteId?: number,
    convId?: number,
    listId?: number,
  ) {
    setView(v);
    if (v === "notes" && noteId) {
      navigate({ search: { note: noteId, conv: undefined, list: undefined , audit: undefined}, replace: true });
    } else if (v === "chat" && convId) {
      navigate({ search: { note: undefined, conv: convId, list: undefined , audit: undefined}, replace: true });
    } else if (v === "lists" && listId) {
      navigate({ search: { note: undefined, conv: undefined, list: listId , audit: undefined}, replace: true });
    } else {
      navigate({ search: { note: undefined, conv: undefined, list: undefined , audit: undefined}, replace: true });
    }
  }

  function handleSelectList(id: number) {
    setActiveListId(id);
    setViewAndUrl("lists", undefined, undefined, id);
  }

  function handleNewChat() {
    newChat();
    setViewAndUrl("chat");
  }

  function handlePlanNote(noteId: number) {
    // Reset chat state — PlanView's effect will fire planNote() on mount
    // with the resolved note content (PlanView fetches the note itself
    // so we don't need to plumb the entry text through here).
    newChat();
    setPlanNoteId(noteId);
    setView("plan");
    navigate({ search: { note: undefined, conv: undefined, list: undefined , audit: undefined}, replace: true });
  }

  function handleCompose() {
    const spaceId = selectedSpaceId ?? "general";
    setView("notes");
    selectSpace(spaceId);
    createNote(spaceId);
    navigate({ search: { note: undefined, conv: undefined, list: undefined , audit: undefined}, replace: true });
  }

  // When active note changes while in notes view, update URL
  const { activeNoteId } = useNotesContentStore();
  useEffect(() => {
    if (view === "notes" && activeNoteId && activeNoteId > 0) {
      navigate({ search: { note: activeNoteId, conv: undefined, list: undefined , audit: undefined}, replace: true });
    }
  }, [activeNoteId, view]);

  // When active conversation changes while in chat view, update URL
  const { activeId: activeConvId } = useConversationsStore();
  useEffect(() => {
    if (view === "chat" && activeConvId) {
      navigate({ search: { note: undefined, conv: activeConvId, list: undefined , audit: undefined}, replace: true });
    }
  }, [activeConvId, view]);

  return (
    <PasswordGate>
    <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: "var(--gooni-bg, #FFFFFF)", position: "relative" }}>
      {sidebarOpen && (
        <Sidebar
          isDashboard={view === "dashboard"}
          isNotes={view === "notes"}
          isChat={view === "chat"}
          isLists={view === "lists"}
          isEval={view === "eval"}
          isStats={view === "stats"}
          activeListId={view === "lists" ? activeListId : null}
          showCompose={view !== "notes"}
          onLogoClick={() => setViewAndUrl("dashboard")}
          onSpaceSelect={() => setView("notes")}
          onCompose={handleCompose}
          onNewChat={handleNewChat}
          onSelectList={handleSelectList}
          onOpenEval={() => setViewAndUrl("eval")}
          onOpenStats={() => setView("stats")}
        />
      )}

      <div style={{ flex: 1, display: "flex", minWidth: 0, position: "relative", overflow: "hidden" }}>
        {view === "dashboard" ? (
          <Dashboard
            onOpenNote={() => setView("notes")}
            onPlanNote={handlePlanNote}
            onOpenStats={() => setView("stats")}
          />
        ) : view === "chat" ? (
          <ChatView />
        ) : view === "plan" && planNoteId != null ? (
          <PlanView
            noteId={planNoteId}
            onExit={() => { setPlanNoteId(null); setView("dashboard"); }}
          />
        ) : view === "lists" && activeListId != null ? (
          <ListView
            listId={activeListId}
            onOpenSourceNote={(noteId) => setViewAndUrl("notes", noteId)}
          />
        ) : view === "eval" ? (
          <EvalView />
        ) : view === "stats" ? (
          <StatsView />
        ) : (
          <>
            <NotesList />
            <NoteEditor />
          </>
        )}
      </div>

      {/* Top-right pair: Public profile + Public MCP. Floats above the
          content so it's reachable from every view without crowding the
          sidebar. Distinct icons (Globe vs Plug) so a glance tells them
          apart; "MCP" drops the redundant "Public" prefix. */}
      <div style={{
        position: "fixed",
        top: 12, right: 14,
        display: "flex", gap: 6,
        zIndex: 90,
      }}>
        <button
          onClick={() => navigate({ to: "/public" })}
          title="Public profile (visitors see this)"
          aria-label="Public profile"
          style={topRightBtn}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.85)")}
        >
          <Globe size={14} strokeWidth={1.7} />
          <span>Public</span>
        </button>
        <button
          onClick={() => navigate({ to: "/public/mcp" })}
          title="MCP — public connector page"
          aria-label="MCP"
          style={topRightBtn}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.85)")}
        >
          <Plug size={14} strokeWidth={1.7} />
          <span>MCP</span>
        </button>
      </div>

      {/* FAB + floating panel + mascot all live in GooniLayer so /memories and
          any other authed route get the same chat affordance for free. */}
      <GooniLayer />
    </div>
    </PasswordGate>
  );
}
