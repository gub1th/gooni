import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  fetchSpaceNotes,
  fetchGeneralNotes,
  createNote,
  updateNote,
  deleteNote,
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
    (set, get) => ({
      notes: {},
      activeNoteId: null,

      loadNotes: async (spaceId: string) => {
        try {
          const notes = spaceId === "general"
            ? await fetchGeneralNotes()
            : await fetchSpaceNotes(parseInt(spaceId, 10));
          set({ notes: { ...get().notes, [spaceId]: notes } });
        } catch (e) {
          console.error("loadNotes error:", e);
        }
      },

      createNote: async (spaceId: string) => {
        // Optimistically add empty note
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
          const realNote = await createNote(
            spaceId === "general" ? "general" : parseInt(spaceId, 10)
          );

          // Replace temp with real
          set((s) => ({
            notes: {
              ...s.notes,
              [spaceId]: s.notes[spaceId].map((n) =>
                n.id === tempId ? realNote : n
              ),
            },
            activeNoteId: realNote.id,
          }));

          return realNote;
        } catch (e) {
          console.error("createNote error:", e);
          // Rollback on failure
          set((s) => ({
            notes: {
              ...s.notes,
              [spaceId]: s.notes[spaceId].filter((n) => n.id !== tempId),
            },
            activeNoteId: null,
          }));
          return null;
        }
      },

      updateNote: async (id: number, title: string, content: string) => {
        try {
          await updateNote(id, title, content);

          // Update in all spaces that might contain this note
          set((s) => {
            const next: Record<string, Note[]> = {};
            for (const [spaceId, notes] of Object.entries(s.notes)) {
              next[spaceId] = notes.map((note) =>
                note.id === id ? { ...note, title, content, updated_at: new Date().toISOString() } : note
              );
            }
            return { notes: next };
          });
        } catch (e) {
          console.error("updateNote error:", e);
        }
      },

      deleteNote: async (id: number, spaceId: string) => {
        try {
          await deleteNote(id);

          set((s) => ({
            notes: {
              ...s.notes,
              [spaceId]: s.notes[spaceId].filter((n) => n.id !== id),
            },
            activeNoteId: s.activeNoteId === id ? null : s.activeNoteId,
          }));
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
        activeNoteId: s.activeNoteId,
      }),
    }
  )
);
