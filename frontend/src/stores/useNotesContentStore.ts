import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  createNote as apiCreateNote,
  deleteNote as apiDeleteNote,
  fetchNote as apiFetchNote,
  type ApiNote,
  patchNote as apiPatchNote,
  fetchAllNotes,
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

// The `spaceId` dimension is GONE. Spaces died in the v2 nuke; every call
// site had been passing the literal "general" ever since, so `notes` was a
// dictionary with exactly one key threaded through ~15 signatures. Folders
// replaced Spaces as the grouping (a real FK on the note, see
// services/note_service/folders.py) and they narrow the list at the SERVER,
// not by bucketing the store.
interface NotesContentState {
  notes: ApiNote[];
  // Wall-clock ms of the last successful fetch. Gates loadNotes against the
  // TTL so we don't slam the API. NOT persisted — restoring with a stale
  // timestamp would let a ten-minute-old reload skip the next refetch.
  lastLoaded: number | null;
  activeNoteId: number | null;
  isDirty: boolean;                        // true if active note has unsaved changes
  loadNotes: (opts?: { force?: boolean }) => Promise<void>;
  createNote: () => Promise<ApiNote | null>;
  updateNote: (id: number, title: string, content: string) => Promise<void>;
  refetchNote: (id: number) => Promise<void>;
  deleteNote: (id: number) => Promise<void>;
  selectNote: (id: number | null) => void;
  markDirty: () => void;
}

export const useNotesContentStore = create<NotesContentState>()(
  persist(
    (set, get) => ({
      notes: [],
      lastLoaded: null,
      activeNoteId: null,
      isDirty: false,

      loadNotes: async (opts?: { force?: boolean }) => {
        const state = get();
        const fresh = state.lastLoaded != null && Date.now() - state.lastLoaded < NOTES_TTL_MS;
        // Cache hit AND not stale AND caller didn't force — skip the round
        // trip. The persisted cache wins across reloads too (notes show up
        // before any fetch fires).
        if (state.notes.length && fresh && !opts?.force) return;
        try {
          const fetched = await fetchAllNotes();
          set({ notes: fetched, lastLoaded: Date.now() });
        } catch (e) {
          console.error("loadNotes error:", e);
        }
      },

      createNote: async () => {
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
          tags: [],
        };
        // Go through selectNote so the prev note gets memorized if dirty
        get().selectNote(tempId);
        set((s) => ({ notes: [optimistic, ...s.notes] }));
        try {
          const real = await apiCreateNote("general");
          set((s) => ({
            // If a concurrent loadNotes cleared the optimistic entry, still
            // add the real note rather than dropping it.
            notes: s.notes.some((n) => n.id === tempId)
              ? s.notes.map((n) => (n.id === tempId ? real : n))
              : [real, ...s.notes],
            activeNoteId: real.id,
          }));
          return real;
        } catch (e) {
          console.error("createNote error:", e);
          set((s) => ({
            notes: s.notes.filter((n) => n.id !== tempId),
            activeNoteId: null,
          }));
          return null;
        }
      },

      updateNote: async (id: number, title: string, content: string) => {
        set({ isDirty: true });
        const updated = await apiPatchNote(id, { title, content }); // throws on failure
        set((s) => ({ notes: s.notes.map((n) => (n.id === id ? updated : n)) }));
      },

      refetchNote: async (id: number) => {
        // Pulls server-of-record state into the store. Used after async
        // backend work (classify_note) finishes — without this, the editor
        // never sees the new classify_signals payload until manual reload.
        try {
          const fresh = await apiFetchNote(id);
          set((s) => {
            // Rebuild ONLY the buckets that actually hold this note, and only
            // when its row differs. The old version mapped every bucket
            // unconditionally, so each call handed back a new array identity
            // for every list in the store — every subscriber re-rendered on a
            // refetch of one note, whether or not it was showing that note.
            // Compounded by the save path firing several store writes per
            // edit (patch → resolve → post-classify refetch).
            const i = s.notes.findIndex((n) => n.id === id);
            // Not present, or already this exact object: return the SAME
            // state so zustand's identity check short-circuits instead of
            // notifying every subscriber.
            if (i === -1 || s.notes[i] === fresh) return s;
            const next = s.notes.slice();
            next[i] = fresh;
            return { notes: next };
          });
        } catch {
          // note may have been deleted — ignore
        }
      },

      deleteNote: async (id: number) => {
        // Snapshot for rollback, then drop it optimistically.
        const snapshot = get().notes;
        const prevActive = get().activeNoteId;
        set((s) => ({
          notes: s.notes.filter((n) => n.id !== id),
          activeNoteId: s.activeNoteId === id ? null : s.activeNoteId,
        }));
        try {
          await apiDeleteNote(id);
        } catch (e) {
          console.error("deleteNote error:", e);
          // Roll back so the user sees the row reappear instead of pretending
          // success. Active note also restored if we cleared it.
          set({ notes: snapshot, activeNoteId: prevActive });
          throw e;
        }
      },

      selectNote: (id: number | null) => {
        const prevId = get().activeNoteId;
        // When leaving a real (server-persisted) note that the user never
        // wrote into, drop it instead of leaving an "Untitled" stub on disk.
        // Skip negative ids (optimistic temp note still being created).
        if (prevId != null && prevId !== id && prevId > 0) {
          const prev = get().notes.find((n) => n.id === prevId);
          if (prev && isEmptyNote(prev)) {
            apiDeleteNote(prevId).catch(() => {});
            set((s) => ({ notes: s.notes.filter((n) => n.id !== prevId) }));
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
      // Nothing is persisted any more. `selectedSpaceId` was the last field
      // here and it only ever held "general". `notes` is deliberately not
      // persisted (see above), and everything else is per-session.
      partialize: () => ({}),
    }
  )
);
