import { useEffect } from "react";

// Module-singleton input state. Boat reads it from useFrame; keyboard
// and touch joystick both write into it. Single source of truth keeps
// the physics integrator simple — it never branches on "which input."
const input = {
  thrust: 0,  // -1..1, negative = reverse
  turn: 0,    // -1..1, positive = left
  reset: false,
};

export function getBoatInput() {
  return input;
}

export function setBoatAxis(axis: "thrust" | "turn", value: number) {
  input[axis] = Math.max(-1, Math.min(1, value));
}

export function fireBoatReset() {
  input.reset = true;
}

// Edge-trigger: returns true once per reset, then auto-clears so the
// Boat integrator doesn't loop on a stuck flag.
export function consumeBoatReset(): boolean {
  if (input.reset) {
    input.reset = false;
    return true;
  }
  return false;
}

// Install keyboard listeners + drive the input axes. Call once from
// the top of the scene — multiple installs would double-fire.
export function useBoatKeyboard() {
  useEffect(() => {
    const held = { w: false, a: false, s: false, d: false };

    function syncAxes() {
      setBoatAxis("thrust", (held.w ? 1 : 0) - (held.s ? 1 : 0));
      setBoatAxis("turn", (held.a ? 1 : 0) - (held.d ? 1 : 0));
    }

    function onKey(e: KeyboardEvent, down: boolean) {
      switch (e.code) {
        case "KeyW":
        case "ArrowUp":
          held.w = down;
          break;
        case "KeyS":
        case "ArrowDown":
          held.s = down;
          break;
        case "KeyA":
        case "ArrowLeft":
          held.a = down;
          break;
        case "KeyD":
        case "ArrowRight":
          held.d = down;
          break;
        case "KeyR":
          if (down) fireBoatReset();
          return;
        default:
          return;
      }
      syncAxes();
    }

    const onDown = (e: KeyboardEvent) => onKey(e, true);
    const onUp = (e: KeyboardEvent) => onKey(e, false);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      // Release axes on unmount so a stale value doesn't survive HMR.
      setBoatAxis("thrust", 0);
      setBoatAxis("turn", 0);
    };
  }, []);
}
