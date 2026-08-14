import { useEffect, useState } from "react";
import { FONT } from "../../ui";
import { ink } from "./ambientInk";
import { FEED_REFRESH_MS, fetchCurrentActivity, type CurrentActivity } from "../../services/api";

// ONE calm line above the wave: what you're actually doing, mirrored back.
// Same treatment as everything else that isn't the wave — dim, bare text on
// the void, no frost, no card, no shadow, no accent, no animation on change.
// It's a mirror, not a notification: it names the frontmost app/tab and how
// long, and nothing else — no scoring, no judgement.

function fmtDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function CurrentActivityLine() {
  const [activity, setActivity] = useState<CurrentActivity | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const a = await fetchCurrentActivity();
        if (!cancelled) setActivity(a);
      } catch {
        /* ambient — stay quiet */
      }
    };
    void load();
    const id = window.setInterval(() => void load(), FEED_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Prefer the desktop app over the browser tab — frontmost app is the
  // broader context (it's what's actually on screen; a background browser
  // tab isn't necessarily what you're looking at).
  const label = activity?.app
    ? `${activity.app.name} · ${fmtDuration(activity.app.duration_sec)}`
    : activity?.browser
      ? `${activity.browser.host} · ${fmtDuration(activity.browser.duration_sec)}`
      : null;

  return (
    <div
      style={{
        fontFamily: FONT,
        fontSize: 12.5,
        letterSpacing: 0.2,
        color: ink(0.32),
        textAlign: "center",
        userSelect: "none",
      }}
    >
      {label ?? ""}
    </div>
  );
}
