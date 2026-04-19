import { create } from "zustand";
import { type ApiSpace, fetchSpaces, createSpace as apiCreateSpace, updateSpace as apiUpdateSpace, deleteSpace as apiDeleteSpace } from "../services/api";

export type SpaceId = number | "general";

export interface AppSpace {
  id: SpaceId;
  name: string;
  emoji: string | null;
}

const GENERAL_SPACE: AppSpace = {
  id: "general",
  name: "General",
  emoji: null,
};

interface SpacesStore {
  spaces: AppSpace[];
  loading: boolean;
  fetch: () => Promise<void>;
  createSpace: (name: string, emoji?: string) => Promise<AppSpace>;
  updateSpace: (id: number, patch: { name?: string; emoji?: string | null }) => Promise<void>;
  deleteSpace: (id: number) => Promise<void>;
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

  createSpace: async (name, emoji) => {
    const created = await apiCreateSpace(name, emoji);
    const space: AppSpace = { id: created.id, name: created.name, emoji: created.emoji };
    set((s) => ({ spaces: [...s.spaces, space] }));
    return space;
  },

  updateSpace: async (id, patch) => {
    const updated = await apiUpdateSpace(id, patch);
    set((s) => ({
      spaces: s.spaces.map((sp) =>
        sp.id === id ? { ...sp, name: updated.name, emoji: updated.emoji } : sp
      ),
    }));
  },

  deleteSpace: async (id) => {
    await apiDeleteSpace(id);
    set((s) => ({ spaces: s.spaces.filter((sp) => sp.id !== id) }));
  },
}));
