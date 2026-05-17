import { useEffect, useRef } from "react";

// Web-Audio-synthesized chill bossa-jazz loop. The real Nintendo Mii
// Channel theme is copyrighted — this is an in-family homage written
// entirely in code. No external asset, no licensing risk.

const BPM = 94;
const MASTER_VOL = 0.34;
const FADE_IN_S = 2.2;

type Note = string | null;
type ChordVoicing = { name: string; bass: string; notes: string[] };

const PROGRESSION: ChordVoicing[] = [
  { name: "Cmaj7",  bass: "C2", notes: ["E3", "G3", "B3"] },
  { name: "Am7",    bass: "A2", notes: ["C3", "E3", "G3"] },
  { name: "Dm7",    bass: "D2", notes: ["F3", "A3", "C4"] },
  { name: "G7",     bass: "G2", notes: ["B2", "D3", "F3"] },
];

const LEAD_PER_CHORD: Note[][] = [
  ["E4", null, "G4", null, "E4", null, "D4", null,    "C4", null, "E4", null, null, null, "G4", null],
  ["C4", null, "E4", null, "G4", null, "E4", null,    "A3", null, "C4", null, null, null, "E4", null],
  ["F4", null, "A4", null, "F4", null, "E4", null,    "D4", null, "F4", null, null, null, "A4", null],
  ["D4", null, "F4", null, "D4", null, "B3", null,    "G3", null, "B3", null, null, null, "D4", null],
];

const STAB_PATTERN: boolean[] = [false, false, true, false, false, true, false, true];

const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function noteFreq(note: string): number {
  const m = note.match(/^([A-G])([#b]?)(\d)$/);
  if (!m) return 440;
  const [, letter, acc, octave] = m;
  let n = SEMITONES[letter];
  if (acc === "#") n += 1;
  if (acc === "b") n -= 1;
  const midi = n + (parseInt(octave) + 1) * 12;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

type PlaybackHandle = {
  stop: () => void;
  setMuted: (m: boolean) => void;
};

function startMusic(): PlaybackHandle {
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const master = ctx.createGain();
  master.gain.value = 0;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 3800;
  lp.Q.value = 0.7;
  master.connect(lp);

  const delay = ctx.createDelay();
  delay.delayTime.value = 0.21;
  const fb = ctx.createGain();
  fb.gain.value = 0.28;
  const wet = ctx.createGain();
  wet.gain.value = 0.22;
  lp.connect(delay);
  delay.connect(fb);
  fb.connect(delay);
  delay.connect(wet);
  wet.connect(ctx.destination);
  lp.connect(ctx.destination);

  const t0 = ctx.currentTime;
  master.gain.linearRampToValueAtTime(MASTER_VOL, t0 + FADE_IN_S);

  let muted = false;

  function pluck(freq: number, t: number, dur: number, vol: number, type: OscillatorType = "triangle") {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function pad(freq: number, t: number, dur: number, vol: number) {
    pluck(freq, t, dur, vol, "sine");
    pluck(freq * 1.005, t, dur, vol * 0.55, "sine");
  }

  const eighthSec = 60 / BPM / 2;
  let nextEighthTime = t0 + 0.05;
  let eighthIdx = 0;
  const EIGHTHS_PER_CHORD = 16;
  const TOTAL_EIGHTHS = EIGHTHS_PER_CHORD * PROGRESSION.length;

  function scheduleEighth(idx: number, when: number) {
    const localIdx = idx % TOTAL_EIGHTHS;
    const chordIdx = Math.floor(localIdx / EIGHTHS_PER_CHORD);
    const inChord = localIdx % EIGHTHS_PER_CHORD;
    const chord = PROGRESSION[chordIdx];

    if (inChord === 0 || inChord === 8) {
      pluck(noteFreq(chord.bass), when, 0.55, 0.22, "sine");
      pluck(noteFreq(chord.bass) * 2, when, 0.45, 0.06, "triangle");
    } else if (inChord === 4 || inChord === 12) {
      const bm = chord.bass.match(/^([A-G])([#b]?)(\d)$/);
      if (bm) {
        const [, letter, acc, oct] = bm;
        let semi = SEMITONES[letter];
        if (acc === "#") semi += 1;
        if (acc === "b") semi -= 1;
        semi += 7;
        let octNum = parseInt(oct);
        if (semi >= 12) { semi -= 12; octNum += 1; }
        const fifthName = Object.keys(SEMITONES).find(k => SEMITONES[k] === semi) ?? "G";
        pluck(noteFreq(fifthName + octNum), when, 0.45, 0.18, "sine");
      }
    }

    if (STAB_PATTERN[inChord % 8]) {
      chord.notes.forEach((n) => pluck(noteFreq(n), when, 0.40, 0.075));
    }

    const lead = LEAD_PER_CHORD[chordIdx][inChord];
    if (lead) {
      pad(noteFreq(lead), when, 0.55, 0.085);
    }
  }

  function lookAhead() {
    const ahead = ctx.currentTime + 0.45;
    while (nextEighthTime < ahead) {
      scheduleEighth(eighthIdx, nextEighthTime);
      eighthIdx += 1;
      nextEighthTime += eighthSec;
    }
  }
  const interval = window.setInterval(lookAhead, 100);
  lookAhead();

  function setMuted(m: boolean) {
    if (muted === m) return;
    muted = m;
    const tNow = ctx.currentTime;
    master.gain.cancelScheduledValues(tNow);
    master.gain.setValueAtTime(master.gain.value, tNow);
    master.gain.linearRampToValueAtTime(m ? 0 : MASTER_VOL, tNow + 0.35);
  }

  function stop() {
    window.clearInterval(interval);
    const tNow = ctx.currentTime;
    master.gain.cancelScheduledValues(tNow);
    master.gain.setValueAtTime(master.gain.value, tNow);
    master.gain.linearRampToValueAtTime(0, tNow + 0.7);
    setTimeout(() => ctx.close(), 900);
  }

  return { stop, setMuted };
}

type Props = { muted: boolean };

export function AmbientAudio({ muted }: Props) {
  const handleRef = useRef<PlaybackHandle | null>(null);

  useEffect(() => {
    try {
      handleRef.current = startMusic();
    } catch (e) {
      console.warn("[plaza] audio failed to start:", e);
    }

    function onVis() {
      const h = handleRef.current;
      if (!h) return;
      if (document.hidden) {
        h.stop();
        handleRef.current = null;
      } else if (!handleRef.current) {
        try {
          handleRef.current = startMusic();
          handleRef.current.setMuted(muted);
        } catch {
          // ignored
        }
      }
    }
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      handleRef.current?.stop();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply mute changes after-the-fact
  useEffect(() => {
    handleRef.current?.setMuted(muted);
  }, [muted]);

  return null;
}
