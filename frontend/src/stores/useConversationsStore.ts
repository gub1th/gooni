import { create } from "zustand";
import {
  fetchConversations as apiFetchConversations,
  createConversation as apiCreateConversation,
  sendConversationMessage as apiSendMessage,
  fetchConversationMessages as apiFetchMessages,
  fetchIntention,
  type ApiConversation,
} from "../services/api";

interface ConversationMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  intention?: string;
}

interface ConversationsStore {
  conversations: ApiConversation[];
  activeId: number | null;
  messages: ConversationMessage[];
  sending: boolean;
  pendingIntention: string | null;

  fetchConversations: () => Promise<void>;
  selectConversation: (id: number) => Promise<void>;
  newChat: () => void;
  send: (content: string) => Promise<void>;
}

export const useConversationsStore = create<ConversationsStore>((set, get) => ({
  conversations: [],
  activeId: null,
  messages: [],
  sending: false,
  pendingIntention: null,

  fetchConversations: async () => {
    try {
      const convos = await apiFetchConversations();
      set({ conversations: convos });
    } catch (e) {
      console.error(e);
    }
  },

  selectConversation: async (id) => {
    set({ activeId: id, messages: [] });
    try {
      const msgs = await apiFetchMessages(id);
      set({ messages: msgs });
    } catch (e) {
      console.error(e);
    }
  },

  newChat: () => {
    set({ activeId: null, messages: [] });
  },

  send: async (content) => {
    const optimistic: ConversationMessage = {
      id: Date.now(),
      role: "user",
      content,
      created_at: new Date().toISOString(),
    };
    set((s) => ({ messages: [...s.messages, optimistic], sending: true, pendingIntention: null }));

    let convId = get().activeId;

    try {
      if (convId === null) {
        const conv = await apiCreateConversation(content);
        convId = conv.id;
        set({ activeId: convId });
      }

      // Fire intention fetch immediately — don't await, just update state when it resolves
      fetchIntention(content, convId).then(({ intention }) => {
        if (intention && get().sending) set({ pendingIntention: intention });
      });

      const { messages: allMessages, intention: fallbackIntention } = await apiSendMessage(convId, content);
      const intentionToUse = get().pendingIntention || fallbackIntention || "";
      const messagesWithIntention = allMessages.map((m, i) =>
        i === allMessages.length - 1 && m.role === "assistant" && intentionToUse
          ? { ...m, intention: intentionToUse }
          : m
      );
      set({ messages: messagesWithIntention, sending: false, pendingIntention: null });

      const convos = await apiFetchConversations();
      set({ conversations: convos });
    } catch (e) {
      console.error(e);
      set({ sending: false, pendingIntention: null });
    }
  },
}));
