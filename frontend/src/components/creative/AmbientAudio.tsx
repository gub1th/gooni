import { useEffect, useRef } from "react";

const AUDIO_URL = "/audio/pond_ambient.mp3";
const VOLUME = 0.4;

// Single-track ambient loop. Mounted only after the user clicks the
// start overlay so we don't fight Chrome's autoplay-w/-sound policy.
// Pauses when the tab is hidden so it doesn't drone in the background.
export function AmbientAudio() {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = VOLUME;
    el.play().catch(() => {
      // If the asset is missing or playback is blocked, silently no-op.
    });

    function onVis() {
      if (!el) return;
      if (document.hidden) el.pause();
      else el.play().catch(() => undefined);
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  return <audio ref={ref} src={AUDIO_URL} loop preload="auto" />;
}
