import { create } from "zustand";
import { LocalStorageService } from "../services/localStorageService";

/**
 * Whether the home's centre rests as the breathing WAVE or as the capture BOX.
 *
 * The wave was the home's anchor for a long time, and the whole treatment rule
 * ("nothing at the centre gets a card, because a second anchor competes with
 * the wave") was written around it. The captain's verdict is that it earns less
 * than the thing it hides: the box is what the surface is actually FOR, and
 * making you hover to reveal it puts a gesture in front of the primary action.
 * So the box is the default and the wave is opt-in.
 *
 * WHY A TOGGLE RATHER THAN A DELETION. The wave is not only decoration — it is
 * the voice mode's tap-to-wake affordance, it carries the pending-glow tint and
 * the focus halo, and it is the element the box morphs OUT of. Ripping it out
 * would mean rehoming all four, and the captain asked for a setting. Nothing is
 * deleted, so turning it back on is one click.
 *
 * WHAT IS NOT LOST BY DEFAULTING TO THE BOX. The wave and the box are ONE
 * stroke (see `MorphLine`) — the same line bent into a different shape. So the
 * focus glow and the pending-energy tint ride the box's outline unchanged; they
 * were never properties of the wave shape. That is why this is a rest-state
 * flag and not a second rendering path.
 *
 * Client-side (the `gooni_theme` / `gooni_display_location` pattern) rather
 * than a `Settings` column: nothing server-side reads it, and a rendering
 * preference does not earn a migration. The cost is that it does not follow
 * Daniel to another device.
 */
const KEY = "gooni_home_wave";

interface HomeWaveStore {
  /** true = the centre rests as the wave; false (DEFAULT) = it rests as the box. */
  waveEnabled: boolean;
  setWaveEnabled: (value: boolean) => void;
}

function load(): boolean {
  // Default FALSE. A value that has never been set is not "wave on" — the box
  // is the new resting state, and an existing install should land on it too.
  return LocalStorageService.get<boolean>(KEY, false) === true;
}

export const useHomeWaveStore = create<HomeWaveStore>((set) => ({
  waveEnabled: load(),
  setWaveEnabled: (value) => {
    const next = value === true;
    LocalStorageService.set(KEY, next);
    set({ waveEnabled: next });
  },
}));
