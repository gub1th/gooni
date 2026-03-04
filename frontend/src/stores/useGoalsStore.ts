import { create } from "zustand";
import { Goal, fetchGoals } from "../services/api";

interface GoalsStore {
  goals: Goal[];
  loading: boolean;
  fetch: () => Promise<void>;
}

export const useGoalsStore = create<GoalsStore>((set) => ({
  goals: [],
  loading: false,
  fetch: async () => {
    set({ loading: true });
    try {
      const goals = await fetchGoals();
      set({ goals });
    } finally {
      set({ loading: false });
    }
  },
}));
