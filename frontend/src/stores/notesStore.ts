import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  seedConversation as apiSeedConversation,
  createSpaceConversation,
  fetchConversationMessages,
  fetchGeneralFeed,
  fetchSpaceFeed,
  sendConversationMessage,
} from "../services/api";
import type { FeedItem, NotesState } from "../types/notes";

export const useNotesStore = create<NotesState>()(
  persist(
    (set) => ({
      spaces: [],
      selectedSpaceId: null,

      selectSpace: (id) => {
        set({
          selectedSpaceId: id,
          expandedEntryId: null,
          messages: {},
        });
      },

      // ── Feed ──────────────────────────────────────────────────────────────

      feedEntries: {},

      loadFeed: async (spaceId) => {
        try {
          const items =
            spaceId === "general"
              ? await fetchGeneralFeed()
              : await fetchSpaceFeed(parseInt(spaceId, 10));
          set((s) => ({ feedEntries: { ...s.feedEntries, [spaceId]: items } }));
        } catch (e) {
          console.error("loadFeed error:", e);
        }
      },

      startConversation: async (spaceId, content) => {
        const tempId = -Date.now();
        const tempItem: FeedItem = {
          id: tempId,
          type: "conversation",
          title: null,
          summary: null,
          goal_id: null,
          space_id: null,
          source: "web",
          created_at: new Date().toISOString(),
        };

        // Show immediately
        set((s) => ({
          feedEntries: {
            ...s.feedEntries,
            [spaceId]: [tempItem, ...(s.feedEntries[spaceId] ?? [])],
          },
          expandedEntryId: tempId,
        }));

        try {
          const apiSpaceId: number | "general" =
            spaceId === "general" ? "general" : parseInt(spaceId, 10);
          const item = await createSpaceConversation(apiSpaceId, content);

          set((s) => ({
            feedEntries: {
              ...s.feedEntries,
              [spaceId]: s.feedEntries[spaceId].map((e) =>
                e.id === tempId ? item : e
              ),
            },
            expandedEntryId: item.id,
          }));
          return item;
        } catch {
          set((s) => ({
            feedEntries: {
              ...s.feedEntries,
              [spaceId]: s.feedEntries[spaceId].filter((e) => e.id !== tempId),
            },
            expandedEntryId: null,
          }));
          return null;
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

      sendMessage: async (conversationId, content) => {
        try {
          const msgs = await sendConversationMessage(conversationId, content);
          set((s) => ({ messages: { ...s.messages, [conversationId]: msgs } }));
        } catch (e) {
          console.error("sendMessage error:", e);
        }
      },

      seedConversation: async (conversationId, entryContent) => {
        try {
          const msgs = await apiSeedConversation(conversationId, entryContent);
          set((s) => ({ messages: { ...s.messages, [conversationId]: msgs } }));
        } catch (e) {
          console.error("seedConversation error:", e);
        }
      },

      // ── UI state ──────────────────────────────────────────────────────────

      expandedEntryId: null,
      setExpandedEntry: (id) => set({ expandedEntryId: id }),
    }),
    {
      name: "gooni-notes-v5",
      partialize: (s) => ({
        selectedSpaceId: s.selectedSpaceId,
      }),
    }
  )
);
