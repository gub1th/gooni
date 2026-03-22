import { create } from "zustand";
import { type ApiSpace, fetchSpaces } from "../services/api";

export type SpaceId = number | "general";

export interface AppSpace {
  id: SpaceId;
  name: string;
  emoji: string | null;
  goal_id: number | null;
}

const GENERAL_SPACE: AppSpace = {
  id: "general",
  name: "General",
  emoji: null,
  goal_id: null,
};

interface SpacesStore {
  spaces: AppSpace[];
  loading: boolean;
  fetch: () => Promise<void>;
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
}));
