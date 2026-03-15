import { create } from "zustand";
import {
  fetchGoals,
  createGoal as apiCreateGoal,
  updateGoal as apiUpdateGoal,
  deleteGoal as apiDeleteGoal,
  type ApiGoal,
} from "../services/api";

export interface AppGoal {
  id: number;
  title: string;
  goal_type: "achieve" | "avoid";
  status: "active" | "completed" | "paused" | "abandoned";
  motivation: string | null;
  blocker: string | null;
  milestones: { id: string; text: string; done: boolean }[];
}

interface GoalsStore {
  goals: AppGoal[];
  selectedGoalId: number | null;
  fetch: () => Promise<void>;
  selectGoal: (id: number | null) => void;
  create: (title: string) => Promise<AppGoal | null>;
  update: (id: number, patch: Partial<AppGoal>) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

function fromApi(g: ApiGoal): AppGoal {
  return {
    id: g.id,
    title: g.title,
    goal_type: g.goal_type,
    status: g.status,
    motivation: g.motivation,
    blocker: g.blocker,
    milestones: g.milestones,
  };
}

export const useGoalsStore = create<GoalsStore>((set) => ({
  goals: [],
  selectedGoalId: null,

  fetch: async () => {
    try {
      const fetched: ApiGoal[] = await fetchGoals();
      set({ goals: fetched.map(fromApi) });
    } catch (e) {
      console.error("fetchGoals error:", e);
    }
  },

  selectGoal: (id: number | null) => {
    set({ selectedGoalId: id });
  },

  create: async (title: string) => {
    try {
      const g: ApiGoal = await apiCreateGoal(title);
      const goal = fromApi(g);
      set((s) => ({ goals: [...s.goals, goal] }));
      return goal;
    } catch (e) {
      console.error("createGoal error:", e);
      return null;
    }
  },

  update: async (id: number, patch: Partial<AppGoal>) => {
    try {
      const g: ApiGoal = await apiUpdateGoal(id, patch);
      const updated = fromApi(g);
      set((s) => ({
        goals: s.goals.map((goal) => (goal.id === id ? updated : goal)),
      }));
    } catch (e) {
      console.error("updateGoal error:", e);
    }
  },

  remove: async (id: number) => {
    try {
      await apiDeleteGoal(id);
      set((s) => ({
        goals: s.goals.filter((g) => g.id !== id),
        selectedGoalId: s.selectedGoalId === id ? null : s.selectedGoalId,
      }));
    } catch (e) {
      console.error("deleteGoal error:", e);
    }
  },
}));
