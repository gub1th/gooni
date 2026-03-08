import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  type ApiNote,
  fetchSpaceNotes,
  createNote as apiCreateNote,
  updateNote as apiUpdateNote,
  deleteNote as apiDeleteNote,
} from "../services/api";

interface NotesContentState {
  // Space selection (replaces notesStore)
  selectedSpaceId: string | null;
  selectSpace: (id: string) => void;

  // Notes per space
  notes: Record<string, ApiNote[]>;       // keyed by spaceId string
  activeNoteId: number | null;
  loadNotes: (spaceId: string) => Promise<void>;
  createNote: (spaceId: string) => Promise<ApiNote | null>;
  updateNote: (id: number, title: string, content: string) => Promise<void>;
  deleteNote: (id: number, spaceId: string) => Promise<void>;
  selectNote: (id: number | null) => void;
}

export const useNotesContentStore = create<NotesContentState>()(
  persist(
    (set) => ({
      selectedSpaceId: null,
      notes: {},
      activeNoteId: null,

      selectSpace: (id: string) => {
        set({ selectedSpaceId: id, activeNoteId: null });
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
        };
        set((s) => ({
          notes: {
            ...s.notes,
            [spaceId]: [optimistic, ...(s.notes[spaceId] ?? [])],
          },
          activeNoteId: tempId,
        }));
        try {
          const real = await apiCreateNote(
            spaceId === "general" ? "general" : parseInt(spaceId)
          );
          set((s) => {
            const list = (s.notes[spaceId] ?? []).map((n) =>
              n.id === tempId ? real : n
            );
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
        try {
          const updated = await apiUpdateNote(id, title, content);
          set((s) => {
            const newNotes: Record<string, ApiNote[]> = {};
            for (const [key, list] of Object.entries(s.notes)) {
              newNotes[key] = list.map((n) => (n.id === id ? updated : n));
            }
            return { notes: newNotes };
          });
        } catch (e) {
          console.error("updateNote error:", e);
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

      selectNote: (id: number | null) => {
        set({ activeNoteId: id });
      },
    }),
    {
      name: "gooni-notes-content-v1",
      partialize: (s) => ({
        selectedSpaceId: s.selectedSpaceId,
        activeNoteId: s.activeNoteId,
      }),
    }
  )
);
