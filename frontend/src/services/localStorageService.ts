// Tiny typed wrapper around localStorage for reading/writing user preferences.
// JSON-serialized values; silent fallback when storage is unavailable (SSR, privacy mode, etc.).

export const LocalStorageService = {
  get<T = unknown>(key: string, fallback?: T): T | undefined {
    if (typeof window === "undefined") return fallback;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },

  set<T = unknown>(key: string, value: T): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Silent — storage can be full, blocked, or unavailable.
    }
  },
};
