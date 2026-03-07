import { create } from "zustand";
import { Goal, fetchGoals, createGoal } from "../services/api";

interface GoalsStore {
  goals: Goal[];
  loading: boolean;
  fetch: () => Promise<void>;
  create: (title: string) => Promise<Goal | null>;
}

export const useGoalsStore = create<GoalsStore>((set) => ({
  goals: [],
  loading: false,
  fetch: async () => {
    set({ loading: true });
    try {
      const goals = await fetchGoals();
      set({ goals });
    } catch (e) {
      console.error("fetchGoals error:", e);
    } finally {
      set({ loading: false });
    }
  },
  create: async (title: string) => {
    try {
      const goal = await createGoal(title);
      set((s) => ({ goals: [...s.goals, goal] }));
      return goal;
    } catch (e) {
      console.error("createGoal error:", e);
      return null;
    }
  },
}));
