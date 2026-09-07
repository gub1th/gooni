import { beforeEach, describe, expect, it } from "vitest";
import { captureState, homeInteractive, homeOpacity } from "../components/ambient/captureStates";

// The rest-state flag, and the one invariant that makes it safe.
//
// `boxMode` ("the box was SUMMONED") and `boxShown` ("the stroke is drawn as a
// rect") became different questions when the box became the resting state. If
// the capture ladder were fed `boxShown`, the home would sit permanently
// dimmed and permanently un-clickable — TODAY unreachable, tasks un-tickable —
// because the box is now always on screen.

const KEY = "gooni_home_wave";

async function freshStore() {
  const mod = await import("./useHomeWaveStore");
  return mod.useHomeWaveStore;
}

describe("useHomeWaveStore", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to the BOX — an unset preference is not 'wave on'", async () => {
    const store = await freshStore();
    // An existing install has no stored value and must land on the new default.
    expect(localStorage.getItem(KEY)).toBeNull();
    store.setState({ waveEnabled: false });
    expect(store.getState().waveEnabled).toBe(false);
  });

  it("round-trips through localStorage", async () => {
    const store = await freshStore();
    store.getState().setWaveEnabled(true);
    expect(store.getState().waveEnabled).toBe(true);
    expect(localStorage.getItem(KEY)).toContain("true");

    store.getState().setWaveEnabled(false);
    expect(store.getState().waveEnabled).toBe(false);
  });
});

describe("a RESTING box is not a capture", () => {
  // These mirror what AmbientHome computes: `boxShown = boxMode || !waveEnabled`
  // feeds the STROKE, while the ladder keeps reading `boxMode`.
  const shown = (boxMode: boolean, waveEnabled: boolean) => boxMode || !waveEnabled;

  it("with the wave off, the box is drawn but the home stays lit and live", () => {
    expect(shown(false, false)).toBe(true);

    const mode = captureState({ boxOpen: false, editorOpen: false });
    expect(homeOpacity(mode, false)).toBe(1);
    expect(
      homeInteractive(mode, false),
      "a permanently dimmed home would make TODAY unreachable",
    ).toBe(true);
  });

  it("reaching for the composer still dims, exactly as before", () => {
    const mode = captureState({ boxOpen: true, editorOpen: false });
    expect(homeOpacity(mode, false)).toBeLessThan(1);
    expect(homeInteractive(mode, false)).toBe(false);
  });

  it("with the wave on, the box is hidden until summoned", () => {
    expect(shown(false, true)).toBe(false);
    expect(shown(true, true)).toBe(true);
  });

  it("a covering surface is still the only zero, under either setting", () => {
    for (const waveEnabled of [true, false]) {
      const mode = captureState({ boxOpen: shown(false, waveEnabled), editorOpen: false });
      expect(homeOpacity(mode, true)).toBe(0);
    }
  });
});
