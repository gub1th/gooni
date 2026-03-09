import { create } from "zustand";
import { persist } from "zustand/middleware";
import { sendJarvisMessage } from "../services/api";

interface JarvisMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

interface JarvisState {
  messages: JarvisMessage[];
  sending: boolean;
  isOpen: boolean;
  width: number;
  toggle: () => void;
  setWidth: (w: number) => void;
  send: (content: string, noteContent?: string) => Promise<void>;
}

export const useJarvisStore = create<JarvisState>()(
  persist(
    (set) => ({
      messages: [],
      sending: false,
      isOpen: false,
      width: 300,

      toggle: () => set((s) => ({ isOpen: !s.isOpen })),
      setWidth: (w: number) => set({ width: Math.min(600, Math.max(220, w)) }),

      send: async (content: string, noteContent?: string) => {
        const userMsg: JarvisMessage = {
          id: Date.now(),
          role: "user",
          content,
        };
        set((s) => ({ messages: [...s.messages, userMsg], sending: true }));
        try {
          const res = await sendJarvisMessage(content, noteContent);
          const assistantMsg: JarvisMessage = {
            id: Date.now() + 1,
            role: "assistant",
            content: res.content,
          };
          set((s) => ({ messages: [...s.messages, assistantMsg] }));
        } catch (e) {
          console.error("Jarvis send error:", e);
        } finally {
          set({ sending: false });
        }
      },
    }),
    {
      name: "gooni-jarvis-v2",
      partialize: (s) => ({ isOpen: s.isOpen, width: s.width }),
    }
  )
);
