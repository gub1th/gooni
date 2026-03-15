import { create } from "zustand";
import {
  fetchConversations as apiFetchConversations,
  createConversation as apiCreateConversation,
  sendConversationMessage as apiSendMessage,
  fetchConversationMessages as apiFetchMessages,
  type ApiConversation,
} from "../services/api";

interface ConversationMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

interface ConversationsStore {
  conversations: ApiConversation[];
  activeId: number | null;
  messages: ConversationMessage[];
  sending: boolean;

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
    set((s) => ({ messages: [...s.messages, optimistic], sending: true }));

    let convId = get().activeId;

    try {
      if (convId === null) {
        const conv = await apiCreateConversation();
        convId = conv.id;
        set({ activeId: convId });
      }

      const allMessages = await apiSendMessage(convId, content);
      set({ messages: allMessages, sending: false });

      const convos = await apiFetchConversations();
      set({ conversations: convos });
    } catch (e) {
      console.error(e);
      set({ sending: false });
    }
  },
}));
