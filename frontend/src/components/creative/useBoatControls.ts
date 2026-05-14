import { useEffect, useRef } from "react";

export type BoatKeys = {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
};

// Keyboard → boolean key state, kept in a ref so per-frame reads in
// useFrame don't trigger React re-renders. WASD + arrow keys both work.
export function useBoatControls() {
  const keys = useRef<BoatKeys>({ forward: false, back: false, left: false, right: false });

  useEffect(() => {
    function set(code: string, down: boolean) {
      switch (code) {
        case "KeyW":
        case "ArrowUp":
          keys.current.forward = down;
          break;
        case "KeyS":
        case "ArrowDown":
          keys.current.back = down;
          break;
        case "KeyA":
        case "ArrowLeft":
          keys.current.left = down;
          break;
        case "KeyD":
        case "ArrowRight":
          keys.current.right = down;
          break;
      }
    }
    const onDown = (e: KeyboardEvent) => set(e.code, true);
    const onUp = (e: KeyboardEvent) => set(e.code, false);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  return keys;
}
