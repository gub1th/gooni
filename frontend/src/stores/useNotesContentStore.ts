import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  createNote as apiCreateNote,
  deleteNote as apiDeleteNote,
  fetchNote as apiFetchNote,
  type ApiNote,
  updateNote as apiUpdateNote,
  fetchSpaceNotes,
} from "../services/api";

// One-shot cleanup of the v2 persist key. v2 persisted full note bodies
// (PR #134) and overflowed the ~5MB localStorage quota for any user with
// image-heavy notes — the row would still be sitting there occupying space
// even after we ship v3. Safe to drop on every load: the only consumer was
// this store, which has already moved to v3.
if (typeof window !== "undefined") {
  try {
    window.localStorage.removeItem("gooni-notes-v2");
  } catch {
    // private mode / quota errors — ignore, nothing we can do here
  }
}

// A note is "empty" when it has no title text and no body content beyond
// the editor's empty-paragraph scaffold. Used to auto-clean up notes that
// the user opened but never wrote anything into — see selectNote().
function isEmptyNote(note: ApiNote): boolean {
  const title = (note.title ?? "").trim();
  if (title.length > 0) return false;
  const raw = (note.content ?? "").trim();
  if (raw.length === 0) return true;
  // TipTap saves a fresh editor as `<p></p>` even when the user typed nothing.
  // Strip tags + non-breaking spaces and check for any visible characters.
  const stripped = raw.replace(/<[^>]*>/g, "").replace(/&nbsp;| /g, "").trim();
  return stripped.length === 0;
}


// Notes are considered fresh for this many ms after the last fetch. Inside
// the window, loadNotes is a no-op (the in-memory cache renders instantly).
// Outside, it refetches in the background — UI still shows the cached copy
// until the new payload lands. 60s is long enough that rapid space-switching
// feels free, short enough that an external write (MCP, bot, etc.) shows up
// within a minute. Callers that need fresh-on-demand pass `{ force: true }`.
const NOTES_TTL_MS = 60_000;

interface NotesContentState {
  // Space selection (replaces notesStore)
  selectedSpaceId: string | null;
  selectSpace: (id: string | null) => void;

  // Notes per space
  notes: Record<string, ApiNote[]>;       // keyed by spaceId string
  // Per-space wall-clock ms of the last successful fetch. Used to gate
  // loadNotes against the TTL so we don't slam the API on every space
  // switch. NOT persisted — restoring with stale timestamps would let a
  // ten-minute-old reload skip the next refetch.
  lastLoaded: Record<string, number>;
  activeNoteId: number | null;
  isDirty: boolean;                        // true if active note has unsaved/unmemorized changes
  loadNotes: (spaceId: string, opts?: { force?: boolean }) => Promise<void>;
  createNote: (spaceId: string) => Promise<ApiNote | null>;
  updateNote: (id: number, title: string, content: string) => Promise<void>;
  refetchNote: (id: number) => Promise<void>;
  deleteNote: (id: number, spaceId: string) => Promise<void>;
  selectNote: (id: number | null) => void;
  markDirty: () => void;
}

export const useNotesContentStore = create<NotesContentState>()(
  persist(
    (set, get) => ({
      selectedSpaceId: null,
      notes: {},
      lastLoaded: {},
      activeNoteId: null,
      isDirty: false,

      selectSpace: (id: string | null) => {
        // Route through selectNote(null) first so the empty-note cleanup runs
        // when the user navigates spaces with a blank note open.
        get().selectNote(null);
        set({ selectedSpaceId: id });
      },

      loadNotes: async (spaceId: string, opts?: { force?: boolean }) => {
        const state = get();
        const cached = state.notes[spaceId];
        const stamp = state.lastLoaded[spaceId];
        const fresh = stamp != null && Date.now() - stamp < NOTES_TTL_MS;
        // Cache hit AND not stale AND caller didn't force a refresh —
        // skip the round-trip entirely. The persisted cache makes this
        // win across reloads too (notes show up before any fetch fires).
        if (cached && fresh && !opts?.force) return;
        try {
          const fetched = await fetchSpaceNotes(
            spaceId === "general" ? "general" : parseInt(spaceId)
          );
          set((s) => ({
            notes: { ...s.notes, [spaceId]: fetched },
            lastLoaded: { ...s.lastLoaded, [spaceId]: Date.now() },
          }));
        } catch (e) {
          console.error("loadNotes error:", e);
        }
      },

      createNote: async (spaceId: string) => {
        const tempId = -Date.now();
        const now = new Date().toISOString();
        const optimistic: ApiNote = {
          id: tempId,
          title: null,
          content: null,
          created_at: now,
          updated_at: now,
          last_opened_at: null,
          is_public: false,
          is_pinned: false,
          is_draft: false,
          tags: [],
        };
        // Go through selectNote so the prev note gets memorized if dirty
        get().selectNote(tempId);
        set((s) => ({
          notes: { ...s.notes, [spaceId]: [optimistic, ...(s.notes[spaceId] ?? [])] },
        }));
        try {
          const real = await apiCreateNote(
            spaceId === "general" ? "general" : parseInt(spaceId)
          );
          set((s) => {
            const existing = s.notes[spaceId] ?? [];
            // If a concurrent loadNotes cleared the optimistic entry, still add the real note
            const list = existing.some((n) => n.id === tempId)
              ? existing.map((n) => n.id === tempId ? real : n)
              : [real, ...existing];
            return { notes: { ...s.notes, [spaceId]: list }, activeNoteId: real.id };
          });
          return real;
        } catch (e) {
          console.error("createNote error:", e);
          set((s) => ({
            notes: {
              ...s.notes,
              [spaceId]: (s.notes[spaceId] ?? []).filter((n) => n.id !== tempId),
            },
            activeNoteId: null,
          }));
          return null;
        }
      },

      updateNote: async (id: number, title: string, content: string) => {
        set({ isDirty: true });
        const updated = await apiUpdateNote(id, title, content); // throws on failure
        set((s) => {
          const newNotes: Record<string, ApiNote[]> = {};
          for (const [key, list] of Object.entries(s.notes)) {
            newNotes[key] = list.map((n) => (n.id === id ? updated : n));
          }
          return { notes: newNotes };
        });
      },

      refetchNote: async (id: number) => {
        // Pulls server-of-record state into the store. Used after async
        // backend work (classify_note) finishes — without this, the editor
        // never sees the new classify_signals payload until manual reload.
        try {
          const fresh = await apiFetchNote(id);
          set((s) => {
            const newNotes: Record<string, ApiNote[]> = {};
            for (const [key, list] of Object.entries(s.notes)) {
              newNotes[key] = list.map((n) => (n.id === id ? fresh : n));
            }
            return { notes: newNotes };
          });
        } catch {
          // note may have been deleted — ignore
        }
      },

      deleteNote: async (id: number, spaceId: string) => {
        // Snapshot for rollback. Optimistic: clear from EVERY cached space
        // (a note deleted from All Notes also belongs to its real space's
        // cache, and vice versa — leaving it in either causes ghost rows).
        const snapshot = get().notes;
        const prevActive = get().activeNoteId;
        set((s) => {
          const next: Record<string, ApiNote[]> = {};
          for (const [key, list] of Object.entries(s.notes)) {
            next[key] = list.filter((n) => n.id !== id);
          }
          const activeNoteId = s.activeNoteId === id ? null : s.activeNoteId;
          return { notes: next, activeNoteId };
        });
        try {
          await apiDeleteNote(id);
        } catch (e) {
          console.error("deleteNote error:", e);
          // Roll back so the user sees the row reappear instead of pretending
          // success. Active note also restored if we cleared it.
          set({ notes: snapshot, activeNoteId: prevActive });
          throw e;
        }
        void spaceId; // kept on signature for callers; cache scrub is global now
      },

      selectNote: (id: number | null) => {
        const prevId = get().activeNoteId;
        // When leaving a real (server-persisted) note that the user never
        // wrote into, drop it instead of leaving an "Untitled" stub on disk.
        // Skip negative ids (optimistic temp note still being created).
        if (prevId != null && prevId !== id && prevId > 0) {
          const state = get();
          let prev: ApiNote | undefined;
          let prevSpaceKey: string | null = null;
          for (const [key, list] of Object.entries(state.notes)) {
            const found = list.find((n) => n.id === prevId);
            if (found) { prev = found; prevSpaceKey = key; break; }
          }
          if (prev && prevSpaceKey != null && isEmptyNote(prev)) {
            const spaceKey = prevSpaceKey;
            apiDeleteNote(prevId).catch(() => {});
            set((s) => {
              const list = (s.notes[spaceKey] ?? []).filter((n) => n.id !== prevId);
              return { notes: { ...s.notes, [spaceKey]: list } };
            });
          }
        }
        set({ activeNoteId: id });
      },

      markDirty: () => set({ isDirty: true }),
    }),
    {
      // v2 → v3: stop persisting `notes` — TipTap inlines images as base64
      // data URLs, so a note bigger than ~5MB blew the localStorage quota
      // and hard-stopped reloads (PR #134 → 2026-05-07 incident). The TTL
      // cache stays in-memory only; we eat the first-paint API round-trip
      // until list endpoints get cheap enough to fetch every reload.
      // Bumping the key clears stale `gooni-notes-v2` entries on reload.
      name: "gooni-notes-v3",
      partialize: (s) => ({
        selectedSpaceId: s.selectedSpaceId,
      }),
    }
  )
);
