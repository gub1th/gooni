import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  fetchSpaceNotes,
  fetchGeneralNotes,
  createNote as apiCreateNote,
  updateNote as apiUpdateNote,
  deleteNote as apiDeleteNote,
} from "../services/api";
import type { Note } from "../types/notes";

interface NotesContentState {
  notes: Record<string, Note[]>;
  activeNoteId: number | null;
  loadNotes: (spaceId: string) => Promise<void>;
  createNote: (spaceId: string) => Promise<Note | null>;
  updateNote: (id: number, title: string, content: string) => Promise<void>;
  deleteNote: (id: number, spaceId: string) => Promise<void>;
  selectNote: (id: number | null) => void;
}

export const useNotesContentStore = create<NotesContentState>()(
  persist(
    (set) => ({
      notes: {},
      activeNoteId: null,

      loadNotes: async (spaceId: string) => {
        const fetched =
          spaceId === "general"
            ? await fetchGeneralNotes()
            : await fetchSpaceNotes(parseInt(spaceId, 10));
        set((s) => ({ notes: { ...s.notes, [spaceId]: fetched } }));
      },

      createNote: async (spaceId: string) => {
        const tempId = -Date.now();
        const tempNote: Note = {
          id: tempId,
          title: "",
          content: "",
          space_id: spaceId === "general" ? null : parseInt(spaceId, 10),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        set((s) => ({
          notes: { ...s.notes, [spaceId]: [tempNote, ...(s.notes[spaceId] ?? [])] },
          activeNoteId: tempId,
        }));

        try {
          const realNote = await apiCreateNote(spaceId === "general" ? "general" : parseInt(spaceId, 10));
          set((s) => ({
            notes: {
              ...s.notes,
              [spaceId]: (s.notes[spaceId] ?? []).map((n) => (n.id === tempId ? realNote : n)),
            },
            activeNoteId: realNote.id,
          }));
          return realNote;
        } catch {
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
        const updated = await apiUpdateNote(id, title, content);
        set((s) => {
          const next: Record<string, Note[]> = {};
          for (const [spaceId, items] of Object.entries(s.notes)) {
            next[spaceId] = items.map((n) => (n.id === id ? updated : n));
          }
          return { notes: next };
        });
      },

      deleteNote: async (id: number, spaceId: string) => {
        await apiDeleteNote(id);
        set((s) => ({
          notes: {
            ...s.notes,
            [spaceId]: (s.notes[spaceId] ?? []).filter((n) => n.id !== id),
          },
          activeNoteId: s.activeNoteId === id ? null : s.activeNoteId,
        }));
      },

      selectNote: (id: number | null) => set({ activeNoteId: id }),
    }),
    {
      name: "gooni-notes-content-v1",
      partialize: (s) => ({ activeNoteId: s.activeNoteId }),
    }
  )
);
