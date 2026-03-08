import { create } from "zustand";
import { type ApiSpace, fetchSpaces, createSpace as apiCreateSpace } from "../services/api";

export type SpaceId = number | "general";

export interface AppSpace {
  id: SpaceId;
  name: string;
  goal_id: number | null;
}

const GENERAL_SPACE: AppSpace = {
  id: "general",
  name: "General",
  goal_id: null,
};

interface SpacesStore {
  spaces: AppSpace[];
  loading: boolean;
  fetch: () => Promise<void>;
  create: (name: string) => Promise<AppSpace | null>;
}

export const useSpacesStore = create<SpacesStore>((set) => ({
  spaces: [GENERAL_SPACE],
  loading: false,

  fetch: async () => {
    set({ loading: true });
    try {
      const fetched: ApiSpace[] = await fetchSpaces();
      set({ spaces: [GENERAL_SPACE, ...fetched] });
    } catch (e) {
      console.error("fetchSpaces error:", e);
    } finally {
      set({ loading: false });
    }
  },

  create: async (name: string) => {
    try {
      const space: ApiSpace = await apiCreateSpace(name);
      set((s) => ({ spaces: [...s.spaces, space] }));
      return space;
    } catch (e) {
      console.error("createSpace error:", e);
      return null;
    }
  },
}));
