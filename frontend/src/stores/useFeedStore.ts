import { create } from "zustand";
import { FeedEntry, fetchFeed } from "../services/api";

interface FeedStore {
  entries: FeedEntry[];
  loading: boolean;
  fetch: () => Promise<void>;
}

export const useFeedStore = create<FeedStore>((set) => ({
  entries: [],
  loading: false,
  fetch: async () => {
    set({ loading: true });
    try {
      const entries = await fetchFeed();
      set({ entries });
    } finally {
      set({ loading: false });
    }
  },
}));
