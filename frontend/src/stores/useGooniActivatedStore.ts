import { create } from "zustand";
import { LocalStorageService } from "../services/localStorageService";

// Whether the on-screen Gooni character is mounted. Default off so a fresh
// visitor doesn't see an ambient character they didn't ask for — they
// activate from the sidebar. Persists across sessions.
interface ActivatedStore {
  activated: boolean;
  setActivated: (v: boolean) => void;
  toggle: () => void;
}

function loadInitial(): boolean {
  const stored = LocalStorageService.get<boolean>("gooni_activated", false);
  return stored === true;
}

export const useGooniActivatedStore = create<ActivatedStore>((set, get) => ({
  activated: loadInitial(),
  setActivated: (v) => {
    LocalStorageService.set("gooni_activated", v);
    set({ activated: v });
  },
  toggle: () => {
    const v = !get().activated;
    LocalStorageService.set("gooni_activated", v);
    set({ activated: v });
  },
}));
