import { create } from "zustand";
import { type ApiSpace, fetchSpaces, createSpace as apiCreateSpace, updateSpace as apiUpdateSpace, deleteSpace as apiDeleteSpace } from "../services/api";

export type SpaceId = number | "general";

export interface AppSpace {
  id: SpaceId;
  name: string;
  emoji: string | null;
  is_pinned: boolean;
  description: string | null;
  cover_image_url: string | null;
}

const GENERAL_SPACE: AppSpace = {
  id: "general",
  name: "General",
  emoji: null,
  is_pinned: false,
  description: null,
  cover_image_url: null,
};

interface SpacesStore {
  spaces: AppSpace[];
  loading: boolean;
  fetch: () => Promise<void>;
  createSpace: (name: string, emoji?: string) => Promise<AppSpace>;
  updateSpace: (id: number, patch: { name?: string; emoji?: string | null; is_pinned?: boolean; description?: string | null; cover_image_url?: string | null }) => Promise<void>;
  deleteSpace: (id: number) => Promise<void>;
}

export const useSpacesStore = create<SpacesStore>((set) => ({
  spaces: [GENERAL_SPACE],
  loading: false,

  fetch: async () => {
    set({ loading: true });
    try {
      const fetched: ApiSpace[] = await fetchSpaces();
      // Backend orders pinned-first already; preserve that here.
      const mapped: AppSpace[] = fetched.map((sp) => ({
        id: sp.id,
        name: sp.name,
        emoji: sp.emoji,
        is_pinned: sp.is_pinned,
        description: sp.description,
        cover_image_url: sp.cover_image_url,
      }));
      set({ spaces: [GENERAL_SPACE, ...mapped] });
    } catch (e) {
      console.error("fetchSpaces error:", e);
    } finally {
      set({ loading: false });
    }
  },

  createSpace: async (name, emoji) => {
    const created = await apiCreateSpace(name, emoji);
    const space: AppSpace = {
      id: created.id,
      name: created.name,
      emoji: created.emoji,
      is_pinned: created.is_pinned,
      description: created.description,
      cover_image_url: created.cover_image_url,
    };
    set((s) => ({ spaces: [...s.spaces, space] }));
    return space;
  },

  updateSpace: async (id, patch) => {
    const updated = await apiUpdateSpace(id, patch);
    set((s) => {
      // Resort so a freshly-pinned space jumps to the top without a refetch.
      const next = s.spaces.map((sp) =>
        sp.id === id
          ? {
              ...sp,
              name: updated.name,
              emoji: updated.emoji,
              is_pinned: updated.is_pinned,
              description: updated.description,
              cover_image_url: updated.cover_image_url,
            }
          : sp,
      );
      next.sort((a, b) => {
        if (a.id === "general") return -1;
        if (b.id === "general") return 1;
        if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
        return (a.id as number) - (b.id as number);
      });
      return { spaces: next };
    });
  },

  deleteSpace: async (id) => {
    await apiDeleteSpace(id);
    set((s) => ({ spaces: s.spaces.filter((sp) => sp.id !== id) }));
  },
}));
