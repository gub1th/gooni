import { useEffect, useState } from "react";

// True when the user has prefers-reduced-motion enabled. Subscribers
// should kill loops, bobs, and intro swoops — keep state changes, lose
// the eye-candy.

const QUERY = "(prefers-reduced-motion: reduce)";

export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(QUERY);
    function onChange() { setReduce(mq.matches); }
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    // Safari < 14 fallback
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);

  return reduce;
}
