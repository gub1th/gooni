import { create } from "zustand";
import { LocalStorageService } from "../services/localStorageService";

/**
 * The label under the header clock, when Daniel wants a place name there.
 *
 * WHY THIS IS NOT DERIVED FROM THE TIMEZONE. The header used to print
 * `Settings.nudge_tz`'s last path segment — "America/Los_Angeles" → "Los
 * Angeles" — which is simply wrong: an IANA zone id names a REPRESENTATIVE
 * city for a set of UTC-offset rules, not where anyone is. Everyone from San
 * Diego to Seattle lives in `America/Los_Angeles`, and the captain (in SF) got
 * "Los Angeles". A tz id can never answer "what city am I in", so no amount of
 * prettifying it makes the answer true.
 *
 * WHY NOT GEOLOCATION + REVERSE GEOCODING. `navigator.geolocation` returns
 * lat/lng, not a place name; turning that into "San Francisco" means POSTing
 * the captain's precise coordinates to a third-party geocoding service (and
 * holding an API key for it). This codebase already refuses that trade in the
 * same shape elsewhere — the browser extension resolves favicons through
 * Chrome's own cache specifically so it never ships every visited host to
 * someone else. Continuous home-location coordinates are a stronger secret than
 * that, for a two-word caption.
 *
 * WHY NOT THE TZ ABBREVIATION EITHER. The interim fallback was PDT/PST —
 * honest, but the captain's verdict was it looks bad and says nothing the
 * clock beside it doesn't already. So the DEFAULT is NOTHING: the slot is
 * empty until a city name is typed here.
 *
 * Client-side (like `gooni_theme`) rather than a `Settings` column: it changes
 * nothing server-side, no route or job reads it, and adding it to the DB would
 * be a migration for a caption. The trade is that it does not follow Daniel to
 * another device — worth revisiting as a `Settings` field if that ever stings.
 */
const KEY = "gooni_display_location";

interface DisplayLocationStore {
  /** Empty string = no label; the header shows nothing in that slot. */
  displayLocation: string;
  setDisplayLocation: (value: string) => void;
}

function load(): string {
  const raw = LocalStorageService.get<string>(KEY, "");
  return typeof raw === "string" ? raw.trim() : "";
}

export const useDisplayLocationStore = create<DisplayLocationStore>((set) => ({
  displayLocation: load(),
  setDisplayLocation: (value) => {
    const next = value.trim();
    LocalStorageService.set(KEY, next);
    set({ displayLocation: next });
  },
}));
