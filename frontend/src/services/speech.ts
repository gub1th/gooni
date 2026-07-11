import { BASE, getStoredToken } from "./api";

// Gooni's spoken voice + the voice-mode switch.
//
// voiceMode = the master "talk to me" toggle (default ON, persisted). The
// ambient home reads it to decide whether to listen + speak. TTS itself is
// best-effort and NEVER load-bearing: any failure (network, autoplay block,
// unsupported browser) just leaves the reply silent — the text subtitle is
// always the source of truth.
//
// One utterance plays at a time; speakText RESOLVES when playback finishes
// (or immediately on any failure) so the caller can resume listening the
// instant Gooni stops talking — never hangs the loop.

const VOICE_KEY = "gooni_voice_mode";

let current: HTMLAudioElement | null = null;
// Resolver for the in-flight speakText promise. stopSpeaking() calls it so a
// mid-sentence cut (mute / voice-off) settles the awaited loop instead of
// hanging forever (pause() fires no 'ended' event).
let currentResolve: (() => void) | null = null;

// Default ON: first-ever visit gets voice; after that we honor the last toggle.
export function isVoiceMode(): boolean {
  const v = localStorage.getItem(VOICE_KEY);
  return v === null ? true : v === "1";
}

export function setVoiceMode(on: boolean): void {
  localStorage.setItem(VOICE_KEY, on ? "1" : "0");
  if (!on) stopSpeaking();
}

export function stopSpeaking(): void {
  if (current) {
    try { current.pause(); } catch { /* ignore */ }
    current = null;
  }
  if (currentResolve) {
    const r = currentResolve;
    currentResolve = null;
    r(); // settle a mid-sentence cut so the awaiting loop continues
  }
}

// Unlock audio autoplay from within a user gesture (the tap-to-wake). Plays a
// fraction-of-a-second silent WAV built in-memory so the document gains sticky
// activation and later programmatic blob-plays aren't blocked. Best-effort.
export function primeAudio(): void {
  try {
    const sr = 8000;
    const n = 800; // ~0.1s
    const buf = new ArrayBuffer(44 + n);
    const dv = new DataView(buf);
    const ws = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); dv.setUint32(4, 36 + n, true); ws(8, "WAVE"); ws(12, "fmt ");
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
    ws(36, "data"); dv.setUint32(40, n, true);
    for (let i = 0; i < n; i++) dv.setUint8(44 + i, 128); // 8-bit silence = 128
    const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    const a = new Audio(url);
    a.onended = () => URL.revokeObjectURL(url);
    void a.play().catch(() => URL.revokeObjectURL(url));
  } catch {
    /* best effort — sticky activation from the gesture usually covers it */
  }
}

// Speak `text` and resolve when playback ENDS. Never rejects: on any failure
// (fetch error, non-ok, autoplay block) it resolves immediately so the voice
// loop resumes listening instead of stalling.
export function speakText(text: string): Promise<void> {
  const clean = text.trim();
  if (!clean) return Promise.resolve();
  stopSpeaking();
  const token = getStoredToken();
  return fetch(`${BASE}/tts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ text: clean }),
  })
    .then((res) => (res.ok ? res.blob() : Promise.reject(new Error("tts http"))))
    .then(
      (blob) =>
        new Promise<void>((resolve) => {
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          current = audio;
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            URL.revokeObjectURL(url);
            if (current === audio) current = null;
            currentResolve = null;
            resolve();
          };
          currentResolve = done; // let stopSpeaking cut in cleanly
          audio.onended = done;
          audio.onerror = done;
          audio.play().catch(done); // autoplay blocked → resolve, don't hang the loop
        }),
    )
    .catch(() => {
      currentResolve = null;
      /* voice is best-effort — stay silent, resume the loop */
    });
}
