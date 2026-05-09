import { create } from "zustand";
import { fetchPublicProfile } from "../services/api";

// Lightweight singleton for the current user's profile so the comments
// avatar (and anywhere else that needs the user's pic) doesn't hit the API
// on every mount. Refresh on demand after a Settings save.
interface ProfileState {
  bio: string | null;
  avatarUrl: string | null;
  loaded: boolean;
  fetchOnce: () => Promise<void>;
  refresh: () => Promise<void>;
  setAvatarUrl: (url: string | null) => void;
}

export const useProfileStore = create<ProfileState>()((set, get) => ({
  bio: null,
  avatarUrl: null,
  loaded: false,

  fetchOnce: async () => {
    if (get().loaded) return;
    await get().refresh();
  },

  refresh: async () => {
    try {
      const p = await fetchPublicProfile();
      set({ bio: p.bio, avatarUrl: p.avatar_url, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  setAvatarUrl: (avatarUrl) => set({ avatarUrl }),
}));
