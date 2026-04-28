import { create } from "zustand";
import {
  fetchFocuses as apiFetchFocuses,
  createFocus as apiCreateFocus,
  updateFocus as apiUpdateFocus,
  deleteFocus as apiDeleteFocus,
  heartbeatFocus as apiHeartbeat,
  type ApiFocus,
  type FocusStatus,
} from "../services/api";

interface FocusesStore {
  focuses: ApiFocus[];
  loaded: boolean;

  fetch: () => Promise<void>;
  create: (body: { name: string; endgoal: string; status?: FocusStatus; due_date?: string | null }) => Promise<ApiFocus>;
  update: (id: number, patch: { name?: string; endgoal?: string; status?: FocusStatus; due_date?: string | null }) => Promise<void>;
  remove: (id: number) => Promise<void>;
  heartbeat: (id: number) => Promise<void>;
}

export const useFocusesStore = create<FocusesStore>((set, get) => ({
  focuses: [],
  loaded: false,

  fetch: async () => {
    try {
      const list = await apiFetchFocuses({ include_someday: true });
      set({ focuses: list, loaded: true });
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
    });
  },

  heartbeat: async (id) => {
    const updated = await apiHeartbeat(id);
    set({
      focuses: get().focuses.map((f) => (f.id === id ? updated : f)),
    });
  },
}));
