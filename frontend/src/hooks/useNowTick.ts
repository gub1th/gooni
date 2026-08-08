import { useEffect, useState } from "react";

// A clock that re-renders its consumer. Any "x ago" label reads `Date.now()`
// during render, so without a tick it freezes at whatever the last render
// stamped — an age that cannot grow can never cross a staleness threshold, and
// a freshness signal that never goes stale while you watch it is only half a
// signal. Ages render at minute/hour granularity, so the default is coarse.
export function useNowTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
