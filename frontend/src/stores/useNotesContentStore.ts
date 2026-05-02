import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  createNote as apiCreateNote,
  deleteNote as apiDeleteNote,
  fetchNote as apiFetchNote,
  moveNote as apiMoveNote,
  type ApiNote,
  updateNote as apiUpdateNote,
  fetchSpaceNotes,
} from "../services/api";

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


interface NotesContentState {
  // Space selection (replaces notesStore)
  selectedSpaceId: string | null;
  selectSpace: (id: string | null) => void;

  // Notes per space
  notes: Record<string, ApiNote[]>;       // keyed by spaceId string
  activeNoteId: number | null;
  isDirty: boolean;                        // true if active note has unsaved/unmemorized changes
  loadNotes: (spaceId: string) => Promise<void>;
  createNote: (spaceId: string) => Promise<ApiNote | null>;
  updateNote: (id: number, title: string, content: string) => Promise<void>;
  refetchNote: (id: number) => Promise<void>;
  deleteNote: (id: number, spaceId: string) => Promise<void>;
  removeSpace: (spaceId: string) => void;
  selectNote: (id: number | null) => void;
  markDirty: () => void;
  moveNote: (noteId: number, fromSpaceId: string, toSpaceId: string) => Promise<void>;
}

export const useNotesContentStore = create<NotesContentState>()(
  persist(
    (set, get) => ({
      selectedSpaceId: null,
      notes: {},
      activeNoteId: null,
      isDirty: false,

      selectSpace: (id: string | null) => {
        // Route through selectNote(null) first so the empty-note cleanup runs
        // when the user navigates spaces with a blank note open.
        get().selectNote(null);
        set({ selectedSpaceId: id });
      },

      loadNotes: async (spaceId: string) => {
        try {
          const fetched = await fetchSpaceNotes(
            spaceId === "general" ? "general" : parseInt(spaceId)
          );
          set((s) => ({ notes: { ...s.notes, [spaceId]: fetched } }));
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
          space_id: spaceId === "general" ? null : parseInt(spaceId),
          created_at: now,
          updated_at: now,
          last_opened_at: null,
          is_public: false,
          is_pinned: false,
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
        try {
          await apiDeleteNote(id);
          set((s) => {
            const list = (s.notes[spaceId] ?? []).filter((n) => n.id !== id);
            const activeNoteId = s.activeNoteId === id ? null : s.activeNoteId;
            return { notes: { ...s.notes, [spaceId]: list }, activeNoteId };
          });
        } catch (e) {
          console.error("deleteNote error:", e);
        }
      },

      removeSpace: (spaceId: string) => {
        set((s) => {
          const newNotes = { ...s.notes };
          delete newNotes[spaceId];
          const selectedSpaceId = s.selectedSpaceId === spaceId ? "general" : s.selectedSpaceId;
          const activeNoteId = s.selectedSpaceId === spaceId ? null : s.activeNoteId;
          return { notes: newNotes, selectedSpaceId, activeNoteId };
        });
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

      moveNote: async (noteId: number, fromSpaceId: string, toSpaceId: string) => {
        if (fromSpaceId === toSpaceId) return;
        const note = (get().notes[fromSpaceId] ?? []).find((n) => n.id === noteId);
        if (!note) return;

        const movedNote = { ...note, space_id: toSpaceId === "general" ? null : Number(toSpaceId) };

        // Optimistic: move note, switch to target space
        set((s) => ({
          notes: {
            ...s.notes,
            [fromSpaceId]: (s.notes[fromSpaceId] ?? []).filter((n) => n.id !== noteId),
            [toSpaceId]: [movedNote, ...(s.notes[toSpaceId] ?? [])],
          },
          selectedSpaceId: toSpaceId,
          activeNoteId: noteId,
        }));

        try {
          await apiMoveNote(noteId, toSpaceId);
          // Refresh target space to pick up any notes not yet loaded
          get().loadNotes(toSpaceId);
        } catch (e) {
          // Rollback
          set((s) => ({
            notes: {
              ...s.notes,
              [fromSpaceId]: [note, ...(s.notes[fromSpaceId] ?? []).filter((n) => n.id !== noteId)],
              [toSpaceId]: (s.notes[toSpaceId] ?? []).filter((n) => n.id !== noteId),
            },
            selectedSpaceId: fromSpaceId,
            activeNoteId: noteId,
          }));
          console.error("moveNote error:", e);
        }
      },
    }),
    {
      name: "gooni-notes-v1",
      partialize: (s) => ({ selectedSpaceId: s.selectedSpaceId }),
    }
  )
);
