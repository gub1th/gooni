import { create } from "zustand";
import { persist } from "zustand/middleware";
import { sendJarvisMessage } from "../services/api";

interface JarvisState {
  messages: { id: number; role: "user" | "assistant"; content: string }[];
  sending: boolean;
  isOpen: boolean;
  toggle: () => void;
  send: (content: string, noteContent?: string) => Promise<void>;
}

export const useJarvisStore = create<JarvisState>()(
  persist(
    (set) => ({
      messages: [],
      sending: false,
      isOpen: false,

      toggle: () => {
        set((s) => ({ isOpen: !s.isOpen }));
      },

      send: async (content: string, noteContent?: string) => {
        set({ sending: true });

        try {
          const response = await sendJarvisMessage(content, noteContent);
          set((s) => ({
            messages: [
              ...s.messages,
              {
                id: Date.now(),
                role: "user",
                content,
              },
              {
                id: Date.now() + 1,
                role: "assistant",
                content: response.content,
              },
            ],
            sending: false,
          }));
        } catch (e) {
          console.error("Jarvis send error:", e);
          set({ sending: false });
        }
      },
    }),
    {
      name: "gooni-jarvis-v1",
      partialize: (s) => ({
        isOpen: s.isOpen,
      }),
    }
  )
);
