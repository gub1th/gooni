import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  seedConversation as apiSeedConversation,
  createSpaceConversation,
  createSpaceNote,
  fetchConversationMessages,
  fetchGeneralFeed,
  fetchSpaceFeed,
  sendConversationMessage,
  updateNote,
} from "../services/api";
import type { FeedItem, NotesState, Space } from "../types/notes";

export const useNotesStore = create<NotesState>()(
  persist(
    (set) => ({
      spaces: [],
      selectedSpaceId: null,

      selectSpace: (id) => {
        set({ 
          selectedSpaceId: id, 
          expandedEntryId: null, 
          activeEditEntryId: null,
          // Clean up messages from previous space to prevent cross-contamination
          messages: {}
        });
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

      loadFeed: async (spaceId) => {
        try {
          const items = spaceId === "general"
            ? await fetchGeneralFeed()
            : await fetchSpaceFeed(parseInt(spaceId, 10));
          set((s) => ({ feedEntries: { ...s.feedEntries, [spaceId]: items } }));
        } catch (e) {
          console.error("loadFeed error:", e);
        }
      },

      submitNote: async (spaceId, content) => {
        const tempId = -Date.now(); // negative to avoid collision with real IDs
        const tempItem: FeedItem = {
          id: tempId,
          type: "note",
          content,
          title: null,
          goal_id: null,
          space_id: null,
          outcome: null,
          created_at: new Date().toISOString(),
        };
        
        // 1. Show immediately
        set((s) => ({ 
          feedEntries: { 
            ...s.feedEntries, 
            [spaceId]: [tempItem, ...(s.feedEntries[spaceId] ?? [])] 
          } 
        }));
        
        try {
          const apiSpaceId: number | "general" = spaceId === "general" ? "general" : parseInt(spaceId, 10);
          const item = await createSpaceNote(apiSpaceId, content);

          // 2. Replace temp with real
          set((s) => ({
            feedEntries: {
              ...s.feedEntries,
              [spaceId]: s.feedEntries[spaceId].map((e) => (e.id === tempId ? item : e)),
            },
          }));

          // 3. If general note was classified into a specific space, mirror it there too
          if (spaceId === "general" && item.space_id != null) {
            const resolvedKey = String(item.space_id);
            set((s) => ({
              feedEntries: {
                ...s.feedEntries,
                [resolvedKey]: [item, ...(s.feedEntries[resolvedKey] ?? [])],
              },
            }));
          }
        } catch {
          // 3. Rollback on failure
          set((s) => ({
            feedEntries: { 
              ...s.feedEntries, 
              [spaceId]: s.feedEntries[spaceId].filter((e) => e.id !== tempId) 
            },
          }));
        }
      },

      startConversation: async (spaceId, content) => {
        const tempId = -Date.now(); // negative to avoid collision with real IDs
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
        
        // 1. Show immediately
        set((s) => ({ 
          feedEntries: { 
            ...s.feedEntries, 
            [spaceId]: [tempItem, ...(s.feedEntries[spaceId] ?? [])] 
          },
          expandedEntryId: tempId,
        }));
        
        try {
          if (spaceId === "general") {
            // Conversations from General not yet supported — rollback and skip
            set((s) => ({
              feedEntries: {
                ...s.feedEntries,
                [spaceId]: s.feedEntries[spaceId].filter((e) => e.id !== tempId),
              },
              expandedEntryId: null,
            }));
            return null;
          }
          const item = await createSpaceConversation(parseInt(spaceId, 10), content);

          // 2. Replace temp with real
          set((s) => ({
            feedEntries: {
              ...s.feedEntries,
              [spaceId]: s.feedEntries[spaceId].map((e) => (e.id === tempId ? item : e)),
            },
            expandedEntryId: item.id,
          }));
          return item;
        } catch {
          // 3. Rollback on failure
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

      sendMessage: async (conversationId, content) => {
        try {
          const msgs = await sendConversationMessage(conversationId, content);
          set((s) => ({ messages: { ...s.messages, [conversationId]: msgs } }));
        } catch (e) {
          console.error("sendMessage error:", e);
        }
      },

      seedConversation: async (conversationId) => {
        try {
          const msgs = await apiSeedConversation(conversationId, "");
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
