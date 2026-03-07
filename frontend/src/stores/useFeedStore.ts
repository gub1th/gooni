import { create } from "zustand";
import { ApiFeedItem, fetchGeneralFeed } from "../services/api";

interface FeedStore {
  entries: ApiFeedItem[];
  loading: boolean;
  fetch: () => Promise<void>;
}

export const useFeedStore = create<FeedStore>((set) => ({
  entries: [],
  loading: false,
  fetch: async () => {
    set({ loading: true });
    try {
      const entries = await fetchGeneralFeed();
      set({ entries });
    } catch (e) {
      console.error("fetchFeed error:", e);
    } finally {
      set({ loading: false });
    }
  },
}));
