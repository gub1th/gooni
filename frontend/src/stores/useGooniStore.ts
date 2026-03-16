import { create } from "zustand";
import { persist } from "zustand/middleware";
import { sendGooniMessage } from "../services/api";

interface GooniMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

interface GooniState {
  messages: GooniMessage[];
  sending: boolean;
  isOpen: boolean;
  width: number;
  toggle: () => void;
  setWidth: (w: number) => void;
  send: (content: string, noteContent?: string) => Promise<void>;
}

export const useGooniStore = create<GooniState>()(
  persist(
    (set) => ({
      messages: [],
      sending: false,
      isOpen: false,
      width: 300,

      toggle: () => set((s) => ({ isOpen: !s.isOpen })),
      setWidth: (w: number) => set({ width: Math.min(600, Math.max(220, w)) }),

      send: async (content: string, noteContent?: string) => {
        const userMsg: GooniMessage = {
          id: Date.now(),
          role: "user",
          content,
        };
        set((s) => ({ messages: [...s.messages, userMsg], sending: true }));
        try {
          const res = await sendGooniMessage(content, noteContent);
          const assistantMsg: GooniMessage = {
            id: Date.now() + 1,
            role: "assistant",
            content: res.content,
          };
          set((s) => ({ messages: [...s.messages, assistantMsg] }));
        } catch (e) {
          console.error("Gooni send error:", e);
        } finally {
          set({ sending: false });
        }
      },
    }),
    {
      name: "gooni-v1",
      partialize: (s) => ({ isOpen: s.isOpen, width: s.width }),
    }
  )
);
