import { create } from "zustand";
import {
  fetchFocuses as apiFetchFocuses,
  fetchStaleFocuses as apiFetchStale,
  createFocus as apiCreateFocus,
  updateFocus as apiUpdateFocus,
  deleteFocus as apiDeleteFocus,
  heartbeatFocus as apiHeartbeat,
  type ApiFocus,
  type FocusStatus,
} from "../services/api";

interface FocusesStore {
  focuses: ApiFocus[];
  staleFocuses: ApiFocus[];
  loaded: boolean;

  fetch: () => Promise<void>;
  fetchStale: (days?: number) => Promise<void>;
  create: (body: { name: string; endgoal: string; status?: FocusStatus; due_date?: string | null }) => Promise<ApiFocus>;
  update: (id: number, patch: { name?: string; endgoal?: string; status?: FocusStatus; due_date?: string | null }) => Promise<void>;
  remove: (id: number) => Promise<void>;
  heartbeat: (id: number) => Promise<void>;
}

export const useFocusesStore = create<FocusesStore>((set, get) => ({
  focuses: [],
  staleFocuses: [],
  loaded: false,

  fetch: async () => {
    try {
      const list = await apiFetchFocuses({ include_someday: true });
      set({ focuses: list, loaded: true });
    } catch (e) {
      console.error(e);
    }
  },

  fetchStale: async (days = 5) => {
    try {
      const stale = await apiFetchStale(days);
      set({ staleFocuses: stale });
    } catch (e) {
      console.error(e);
    }
  },

  create: async (body) => {
    const focus = await apiCreateFocus(body);
    set({ focuses: [...get().focuses, focus] });
    return focus;
  },

  update: async (id, patch) => {
    const updated = await apiUpdateFocus(id, patch);
    set({
      focuses: get().focuses.map((f) => (f.id === id ? updated : f)),
    });
  },

  remove: async (id) => {
    await apiDeleteFocus(id);
    set({
      focuses: get().focuses.filter((f) => f.id !== id),
      staleFocuses: get().staleFocuses.filter((f) => f.id !== id),
    });
  },

  heartbeat: async (id) => {
    const updated = await apiHeartbeat(id);
    set({
      focuses: get().focuses.map((f) => (f.id === id ? updated : f)),
      staleFocuses: get().staleFocuses.filter((f) => f.id !== id),
    });
  },
}));
