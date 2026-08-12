// A short, soft completion tone — the optional half of pass 9's item 2.
//
// Deliberately its own module with ONE export and no state, so removing it is
// deleting a file and one call. Synthesised with WebAudio rather than shipped as
// an asset for the same reason: nothing to host, nothing to preload, and no
// silent 404 if the file goes missing.
//
// Best-effort by contract. Audio is blocked until the page has had a user
// gesture, and the browser may refuse for reasons we neither know nor care
// about — a completion must never fail because a sound could not play.

const A5 = 880;
const E6 = 1318.5;

export function ding(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const now = ctx.currentTime;

    // Two soft sine partials a fifth apart, ~0.35s. A single tone reads as a
    // notification; the interval reads as "done".
    for (const [freq, delay, peak] of [[A5, 0, 0.05], [E6, 0.07, 0.035]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      // exponential decay, never to exactly 0 (WebAudio forbids it)
      gain.gain.setValueAtTime(0.0001, now + delay);
      gain.gain.exponentialRampToValueAtTime(peak, now + delay + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.34);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + delay);
      osc.stop(now + delay + 0.36);
    }

    // Release the hardware once it has rung out — a context left open per
    // completion eventually hits the browser's per-page context limit.
    window.setTimeout(() => void ctx.close().catch(() => {}), 700);
  } catch {
    /* no audio, blocked, or no gesture yet — a completion is not worth an error */
  }
}
