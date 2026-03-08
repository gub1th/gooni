import { create } from "zustand";
import { type ApiSpace, fetchSpaces, createSpace as apiCreateSpace, deleteSpace as apiDeleteSpace, updateSpace as apiUpdateSpace } from "../services/api";

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
  create: (name: string) => Promise<AppSpace | null>;
  remove: (id: number) => Promise<void>;
  rename: (id: number, name: string) => Promise<void>;
  setEmoji: (id: number, emoji: string) => Promise<void>;
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

  remove: async (id: number) => {
    try {
      await apiDeleteSpace(id);
      set((s) => ({ spaces: s.spaces.filter((sp) => sp.id !== id) }));
    } catch (e) {
      console.error("deleteSpace error:", e);
    }
  },

  rename: async (id: number, name: string) => {
    try {
      const updated = await apiUpdateSpace(id, { name });
      set((s) => ({
        spaces: s.spaces.map((sp) => (sp.id === id ? { ...sp, name: updated.name } : sp)),
      }));
    } catch (e) {
      console.error("renameSpace error:", e);
    }
  },

  setEmoji: async (id: number, emoji: string) => {
    try {
      const updated = await apiUpdateSpace(id, { emoji });
      set((s) => ({
        spaces: s.spaces.map((sp) => (sp.id === id ? { ...sp, emoji: updated.emoji } : sp)),
      }));
    } catch (e) {
      console.error("setEmoji error:", e);
    }
  },
}));
