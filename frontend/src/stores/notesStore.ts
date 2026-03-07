import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { FeedItem, NotesState, Space } from "../types/notes";
import {
  fetchGoalFeed,
  createGoalNote,
  createGoalConversation,
  updateNote,
  fetchConversationMessages,
  sendConversationMessage,
  seedConversation as apiSeedConversation,
} from "../services/api";

export const useNotesStore = create<NotesState>()(
  persist(
    (set) => ({
      spaces: [],
      selectedSpaceId: null,

      selectSpace: (id) => {
        set({ selectedSpaceId: id, expandedEntryId: null, activeEditEntryId: null });
      },

      createSpace: (name, section = "iCloud") => {
        const space: Space = {
          id: Math.random().toString(36).slice(2) + Date.now().toString(36),
          name,
          type: "folder",
          section,
        };
        set((s) => ({ spaces: [...s.spaces, space] }));
      },

      // ── Feed ──────────────────────────────────────────────────────────────

      feedEntries: {},

      loadFeed: async (spaceId, goalId) => {
        if (goalId == null) return; // only goal-backed spaces have a backend feed
        try {
          const items = await fetchGoalFeed(goalId);
          set((s) => ({ feedEntries: { ...s.feedEntries, [spaceId]: items } }));
        } catch (e) {
          console.error("loadFeed error:", e);
        }
      },

      submitNote: async (spaceId, goalId, content) => {
        if (goalId == null) return;
        try {
          const item = await createGoalNote(goalId, content);
          set((s) => ({
            feedEntries: {
              ...s.feedEntries,
              [spaceId]: [item, ...(s.feedEntries[spaceId] ?? [])],
            },
          }));
        } catch (e) {
          console.error("submitNote error:", e);
        }
      },

      startConversation: async (spaceId, goalId, content) => {
        if (goalId == null) return null;
        try {
          const item = await createGoalConversation(goalId, content);
          set((s) => ({
            feedEntries: {
              ...s.feedEntries,
              [spaceId]: [item, ...(s.feedEntries[spaceId] ?? [])],
            },
            expandedEntryId: item.id,
          }));
          return item;
        } catch (e) {
          console.error("startConversation error:", e);
          return null;
        }
      },

      updateEntry: async (noteId, content) => {
        try {
          const updated = await updateNote(noteId, content);
          set((s) => {
            const next: Record<string, FeedItem[]> = {};
            for (const [sid, items] of Object.entries(s.feedEntries)) {
              next[sid] = items.map((item) =>
                item.id === noteId ? { ...item, ...updated } : item
              );
            }
            return { feedEntries: next };
          });
        } catch (e) {
          console.error("updateEntry error:", e);
        }
      },

      // ── Messages ──────────────────────────────────────────────────────────

      messages: {},

      loadMessages: async (conversationId) => {
        try {
          const msgs = await fetchConversationMessages(conversationId);
          set((s) => ({ messages: { ...s.messages, [conversationId]: msgs } }));
        } catch (e) {
          console.error("loadMessages error:", e);
        }
      },

      sendMessage: async (conversationId, content, goalId) => {
        try {
          const msgs = await sendConversationMessage(conversationId, content, goalId);
          set((s) => ({ messages: { ...s.messages, [conversationId]: msgs } }));
        } catch (e) {
          console.error("sendMessage error:", e);
        }
      },

      seedConversation: async (conversationId, goalId) => {
        try {
          const msgs = await apiSeedConversation(conversationId, goalId, "");
          set((s) => ({ messages: { ...s.messages, [conversationId]: msgs } }));
        } catch (e) {
          console.error("seedConversation error:", e);
        }
      },

      // ── UI state ──────────────────────────────────────────────────────────

      expandedEntryId: null,
      setExpandedEntry: (id) => set({ expandedEntryId: id }),

      activeEditEntryId: null,
      setActiveEditEntry: (id) => set({ activeEditEntryId: id }),
    }),
    {
      name: "gooni-notes-v4",
      partialize: (s) => ({
        selectedSpaceId: s.selectedSpaceId,
      }),
    }
  )
);
