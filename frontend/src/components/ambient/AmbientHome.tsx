import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { FONT } from "../../ui";
import { speakText, isVoiceMode, setVoiceMode, stopSpeaking, primeAudio } from "../../services/speech";
import { MorphLine, type MorphRect } from "./MorphLine";
import { LimboCards } from "./LimboCards";
import { LogDots } from "./LogDots";
import { NotePeek } from "./NotePeek";
import { StickyLayer, type StickyHandle } from "./StickyLayer";
import { WidgetHost } from "../widgets/WidgetHost";
import { ActivityRail } from "./ActivityRail";
import { QuickFind } from "./QuickFind";
import {
  createConversation,
  dismissMessageGlow,
  fetchMessageLog,
  promoteMessage,
  sendConversationMessage,
  type ApiNote,
  type LogMessage,
} from "../../services/api";

// Line-art "presence" home. ONE stroke (MorphLine) is the only resident thing:
// a tall breathing waveform at rest that BENDS into the capture input's outline
// when summoned (the line becomes the box), then back.
//
// VOICE-FIRST (default): the wave is always listening. Tap once to wake (a
// browser gesture is unavoidable — it unlocks the mic + audio autoplay), then
// it's hands-free: you talk → it auto-sends on your pause → Gooni speaks the
// reply back, then resumes listening. No button, no textbox, no Enter. The mic
// pauses while Gooni talks (no echo) and while you type. Toggle voice off (pill,
// persisted) to fall back to the typed capture box.
//
// SEARCH LIVES ELSEWHERE. The capture box used to double as an omnibox — every
// keystroke ran a note search and a suggestion dropdown hung under it. That's
// gone: the box only captures now, and recall moved to `QuickFind` (the bar at
// the top), which searches notes AND promises/reminders/memories/trackables.

const POLL_MS = 15_000;
const WAVE_WIDTH = 440;
const PEEK_H = 104; // rest box height ≈ the wave's full amplitude span (+margin)
const FOCUS_MIN_H = 104; // never shrink below the resting bounds when focused
const MAX_H = 340;
const IDLE_LISTEN_AMP = 0.4; // gentle live wave while listening at rest
const MIN_UTTERANCE = 2; // ignore stray one-char finals / noise

function isGlowing(m: LogMessage): boolean {
  return Boolean(m.has_actionable_signal) && (m.signal_preview?.status ?? "pending") === "pending";
}

function energyFor(count: number): number {
  return Math.min(1, 0.14 + count * 0.28);
}

export function AmbientHome() {
  const energyRef = useRef(0);
  const activeRef = useRef(0);

  const [vp, setVp] = useState({ w: 1200, h: 800 });
  const [limbo, setLimbo] = useState<LogMessage[]>([]);
  const [boxMode, setBoxMode] = useState(false);
  const [logMode, setLogMode] = useState(false);
  const [value, setValue] = useState("");
  const [boxH, setBoxH] = useState(PEEK_H);
  const [thinking, setThinking] = useState(false);
  const [replyText, setReplyText] = useState<string | null>(null);
  const [replyShown, setReplyShown] = useState(false);
  const [peekNote, setPeekNote] = useState<ApiNote | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const stickyRef = useRef<StickyHandle>(null);
  const focusedRef = useRef(false);
  const hideTimer = useRef<number | null>(null);
  const enterTimer = useRef<number | null>(null);
  const replyTimer = useRef<number | null>(null);
  const replyHideTimer = useRef<number | null>(null);

  // ── Voice engine ──────────────────────────────────────────────────────────
  // voiceMode = master switch (persisted, default on). armed = user has tapped
  // to wake this session (mic running + audio unlocked). listening = mic hot.
  // Refs mirror the flags for use inside SpeechRecognition callbacks (which see
  // stale closures otherwise). busyRef gates overlaps while a turn runs/speaks.
  const [voiceMode, setVoiceModeState] = useState(isVoiceMode);
  const [armed, setArmed] = useState(false);
  const [listening, setListening] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const recognitionRef = useRef<any>(null); // SpeechRecognition — not in lib.dom
  const shouldListenRef = useRef(false); // do we WANT the mic hot right now
  const busyRef = useRef(false); // a turn is thinking/speaking → don't listen/overlap
  const convIdRef = useRef<number | null>(null); // one conversation for the session
  const voiceModeRef = useRef(voiceMode);
  const armedRef = useRef(false);

  useEffect(() => {
    function onResize() { setVp({ w: window.innerWidth, h: window.innerHeight }); }
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const boxW = Math.min(WAVE_WIDTH + 40, vp.w * 0.9);
  const rect: MorphRect = { cx: vp.w / 2, cy: vp.h * 0.44, w: boxW, h: boxH, r: 20 };
  const waveW = Math.min(WAVE_WIDTH, boxW - 40); // wave sits just inside the box

  const reload = useCallback(async () => {
    try {
      const rows = await fetchMessageLog({ limit: 40 });
      const glowing = rows.filter(isGlowing);
      setLimbo(glowing);
      energyRef.current = energyFor(glowing.length);
    } catch {
      /* ambient surface — never throw at the user */
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(t);
  }, [reload]);

  // resting wave energy: a gentle live shimmer while listening, flat otherwise.
  const idleActive = useCallback(() => {
    activeRef.current = voiceModeRef.current && armedRef.current ? IDLE_LISTEN_AMP : 0;
  }, []);

  // ── SpeechRecognition lifecycle ─────────────────────────────────────────────
  const startListening = useCallback(() => {
    if (!voiceModeRef.current || !armedRef.current || busyRef.current) return;
    const w = window as any;
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;
    let rec = recognitionRef.current;
    if (!rec) {
      rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = "en-US";
      rec.onresult = onRecResult;
      rec.onend = onRecEnd;
      rec.onerror = onRecError;
      recognitionRef.current = rec;
    }
    shouldListenRef.current = true;
    try {
      rec.start();
      setListening(true);
      activeRef.current = IDLE_LISTEN_AMP;
    } catch {
      /* already started — fine */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopListening = useCallback(() => {
    shouldListenRef.current = false;
    setListening(false);
    setLiveTranscript("");
    const rec = recognitionRef.current;
    if (rec) { try { rec.stop(); } catch { /* not running */ } }
  }, []);

  function onRecResult(e: any) {
    let interim = "";
    let finalText = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const txt = r[0]?.transcript ?? "";
      if (r.isFinal) finalText += txt;
      else interim += txt;
    }
    if (interim) {
      setLiveTranscript(interim);
      activeRef.current = 1; // hearing you → wave leaps
    }
    const utt = finalText.trim();
    if (utt.length >= MIN_UTTERANCE) {
      setLiveTranscript("");
      void runTurn(utt, true);
    }
  }

  function onRecEnd() {
    setListening(false);
    // Chrome ends recognition after a silence window — restart if we still want
    // to be listening (and aren't mid-turn).
    if (shouldListenRef.current && voiceModeRef.current && armedRef.current && !busyRef.current) {
      try { recognitionRef.current?.start(); setListening(true); } catch { /* race — ignore */ }
    }
  }

  function onRecError(e: any) {
    // Mic permission denied / blocked → drop to typing rather than loop errors.
    if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
      disableVoice();
    }
    // no-speech / aborted / network → onend fires next and handles restart.
  }

  // ── Turn pipeline (shared by voice + typed) ─────────────────────────────────
  async function sendTurn(text: string): Promise<string> {
    let cid = convIdRef.current;
    if (cid == null) {
      const conv = await createConversation();
      cid = conv.id;
      convIdRef.current = cid;
    }
    const out = await sendConversationMessage(cid, text);
    const assistant = [...out.messages].reverse().find((m) => m.role === "assistant");
    return (assistant?.content || "").trim();
  }

  // One turn: pause the mic, think, show + (if spoken) SPEAK the reply, then
  // resume listening. `spoken` = came by voice → Gooni voices it back; typed
  // turns stay silent-subtitle only.
  async function runTurn(text: string, spoken: boolean) {
    if (busyRef.current) return;
    busyRef.current = true;
    stopListening(); // no echo: don't hear Gooni / ourselves mid-turn
    clearReplyTimers();
    setReplyText(null);
    setThinking(true);
    activeRef.current = 1;
    let reply = "";
    try {
      reply = await sendTurn(text);
    } catch {
      /* dropped — stay quiet */
    }
    setThinking(false);
    void reload(); // surface any glow card the turn produced
    if (reply && spoken) {
      // hold the subtitle for the WHOLE utterance — the audio, not a timer,
      // decides when it fades.
      showSubtitle(reply, true);
      activeRef.current = 1;
      await speakText(reply); // resolves exactly when playback ends (or is cut)
      hideSubtitle();
    } else if (reply) {
      showSubtitle(reply); // typed → silent, length-timed subtitle
    } else {
      idleActive();
    }
    busyRef.current = false;
    if (voiceModeRef.current && armedRef.current) startListening();
  }

  // ── Wake / toggle ───────────────────────────────────────────────────────────
  // Tap-to-wake: the one required gesture. Unlocks audio autoplay + starts the
  // mic. After this it's hands-free for the session.
  const arm = useCallback(() => {
    if (armedRef.current) return;
    primeAudio(); // unlock autoplay inside the gesture
    armedRef.current = true;
    setArmed(true);
    startListening();
  }, [startListening]);

  function toggleVoiceMode() {
    const next = !voiceMode;
    setVoiceMode(next); // persist
    setVoiceModeState(next);
    voiceModeRef.current = next;
    if (next) {
      arm(); // this click is a gesture → wake immediately, no separate tap
    } else {
      stopListening();
      stopSpeaking();
      setArmed(false);
      armedRef.current = false;
      idleActive();
    }
  }

  function disableVoice() {
    setVoiceMode(false);
    setVoiceModeState(false);
    voiceModeRef.current = false;
    stopListening();
    stopSpeaking();
    setArmed(false);
    armedRef.current = false;
    idleActive();
  }

  // cleanup on unmount
  useEffect(() => {
    return () => { stopListening(); stopSpeaking(); };
  }, [stopListening]);

  const syncHeight = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    if (!focusedRef.current) { el.style.height = ""; setBoxH(PEEK_H); return; }
    el.style.height = "auto";
    const h = Math.max(FOCUS_MIN_H, Math.min(MAX_H, el.scrollHeight));
    el.style.height = `${h}px`;
    setBoxH(h);
  }, []);

  // A QuickFind hit that resolves to a note opens it inline (same NotePeek the
  // old capture-box dropdown used) — the rest navigate or flip home-local state.
  const openNote = useCallback((n: ApiNote) => {
    setPeekNote(n);
    inputRef.current?.blur();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        // "/" = intent to type. If voice is armed but idle, that's fine — just
        // open the box (mic pauses on focus). If voice hasn't been woken yet,
        // pressing "/" means "I'd rather type" → drop out of voice mode.
        if (voiceModeRef.current && !armedRef.current) disableVoice();
        openBox();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearHideTimer() {
    if (hideTimer.current) { window.clearTimeout(hideTimer.current); hideTimer.current = null; }
  }
  function clearEnterTimer() {
    if (enterTimer.current) { window.clearTimeout(enterTimer.current); enterTimer.current = null; }
  }

  function openBox() {
    clearHideTimer();
    clearEnterTimer();
    setBoxMode(true);
    activeRef.current = 1;
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function onHeroEnter() {
    clearHideTimer();
    clearEnterTimer();
    enterTimer.current = window.setTimeout(() => {
      setBoxMode(true);
      activeRef.current = 1;
    }, 160);
  }

  function onHeroLeave() {
    clearEnterTimer();
    if (focusedRef.current) return;
    if (value.trim()) return;
    idleActive();
    clearHideTimer();
    hideTimer.current = window.setTimeout(() => setBoxMode(false), 110);
  }

  function clearReplyTimers() {
    if (replyTimer.current) { window.clearTimeout(replyTimer.current); replyTimer.current = null; }
    if (replyHideTimer.current) { window.clearTimeout(replyHideTimer.current); replyHideTimer.current = null; }
  }

  // Gooni's reply as a subtitle under the wave. `hold` = keep it up until the
  // caller hides it (spoken path syncs the hide to when the AUDIO ends, so the
  // text never fades mid-sentence). Silent (typed) path uses a length-based
  // timer since there's no audio to track.
  function showSubtitle(text: string, hold = false) {
    clearReplyTimers();
    setReplyText(text);
    requestAnimationFrame(() => setReplyShown(true));
    activeRef.current = 1;
    if (hold) return;
    const dur = Math.min(9000, Math.max(2600, text.length * 45));
    replyTimer.current = window.setTimeout(() => hideSubtitle(), dur);
  }

  function hideSubtitle() {
    clearReplyTimers();
    setReplyShown(false);
    idleActive();
    replyHideTimer.current = window.setTimeout(() => setReplyText(null), 420);
  }

  // Typed capture (voice off, or optional typing while voice on) — silent reply.
  function capture() {
    const text = value.trim();
    if (!text) return;
    setValue("");
    focusedRef.current = false;
    setBoxMode(false);
    setBoxH(PEEK_H);
    inputRef.current?.blur();
    void runTurn(text, false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      capture();
      return;
    }
    if (e.key === "Escape") {
      (e.target as HTMLTextAreaElement).blur();
      idleActive();
      if (!value.trim()) setBoxMode(false);
    }
  }

  async function onPromote(m: LogMessage) {
    setLimbo((prev) => prev.filter((x) => x.id !== m.id));
    try { await promoteMessage(m.id); } finally { void reload(); }
  }
  async function onDismiss(m: LogMessage) {
    setLimbo((prev) => prev.filter((x) => x.id !== m.id));
    try { await dismissMessageGlow(m.id); } finally { void reload(); }
  }

  const needsWake = voiceMode && !armed; // show the tap-to-wake veil

  // Double-click an empty patch of the void → spawn a sticky there. Skip while
  // another surface owns the screen, and skip clicks on interactive chrome
  // (pills, glow cards, the capture box, existing stickies) — StickyLayer's
  // createAt also refuses the forbidden centre/nav zones.
  function onRootDoubleClick(e: React.MouseEvent) {
    if (boxMode || logMode || needsWake || peekNote) return;
    if ((e.target as HTMLElement).closest("button, textarea, input, a, [data-sticky], [data-widget], [data-chat-ribbon], [data-activity-rail], [data-quickfind]")) return;
    stickyRef.current?.createAt(e.clientX, e.clientY);
  }

  return (
    <div
      onDoubleClick={onRootDoubleClick}
      style={{ position: "fixed", inset: 0, background: "var(--gooni-void, #000000)", overflow: "hidden", fontFamily: FONT }}
    >
      <MorphLine boxMode={boxMode} rect={rect} thinking={thinking} dimmed={logMode} waveWidth={waveW} energyRef={energyRef} activeRef={activeRef} />
      <StickyLayer ref={stickyRef} vp={vp} center={{ cx: rect.cx, cy: rect.cy, w: boxW }} hidden={logMode || !!peekNote || needsWake} />

      <LimboCards items={limbo} onPromote={onPromote} onDismiss={onDismiss} />

      {/* draggable home widgets (calendar, …) — enabled set lives in the
          widget layout store; toggle in Settings ▸ Widgets */}
      {!logMode && !needsWake && !peekNote && <WidgetHost />}

      {/* hero zone = the wave's bounding rectangle. Box the wave morphs into +
          the hover target. Focusing it PAUSES the mic (so voice doesn't hear you
          type); blurring resumes listening. */}
      <div
        onMouseEnter={onHeroEnter}
        onMouseLeave={onHeroLeave}
        style={{
          position: "absolute",
          left: rect.cx - rect.w / 2,
          top: rect.cy - boxH / 2,
          width: rect.w,
          height: boxH,
          zIndex: 2,
        }}
      >
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => { setValue(e.target.value); syncHeight(); }}
          onKeyDown={onKeyDown}
          onFocus={() => { focusedRef.current = true; activeRef.current = 1; stopListening(); syncHeight(); }}
          onBlur={() => {
            focusedRef.current = false;
            syncHeight();
            onHeroLeave();
            if (voiceModeRef.current && armedRef.current && !busyRef.current) startListening();
          }}
          placeholder="what's on your mind?"
          spellCheck={false}
          style={{
            position: "absolute", inset: 0, width: "100%", height: "100%", boxSizing: "border-box",
            resize: "none", outline: "none", border: "none", overflow: "hidden",
            fontFamily: FONT, fontSize: 16, lineHeight: 1.5, padding: "16px 22px",
            borderRadius: rect.r, color: "rgb(var(--gooni-ink, 244 245 244))", caretColor: "#4ADE80",
            background: boxMode ? "color-mix(in srgb, rgb(var(--gooni-surf, 11 15 13)) 52%, transparent)" : "transparent",
            backdropFilter: boxMode ? "blur(16px)" : "none",
            WebkitBackdropFilter: boxMode ? "blur(16px)" : "none",
            opacity: boxMode ? 1 : 0,
            pointerEvents: boxMode ? "auto" : "none",
            transition: "opacity 200ms ease, background 220ms ease",
          }}
        />
      </div>

      {/* quickfind — THE search surface. Top bar, its own thing, searches every
          primitive (not just notes). Hidden only under full-screen surfaces. */}
      <QuickFind
        hidden={logMode || !!peekNote || needsWake}
        onOpenNote={openNote}
        onOpenTrackables={() => setLogMode(true)}
      />

      {/* trackables + voice pills — always visible row below the wave (Daniel:
          fewer hidden hover controls). The activity log sits below this row (the
          `ActivityRail` block); this pill opens the trackables matrix. */}
      {!boxMode && !logMode && (
        <div
          style={{
            position: "absolute", left: rect.cx - rect.w / 2, top: rect.cy + PEEK_H / 2 + 18,
            width: rect.w, paddingTop: 16, zIndex: 3,
            display: "flex", justifyContent: "center", gap: 8,
          }}
        >
          <button
            onClick={() => setLogMode(true)}
            style={{
              padding: "5px 16px", borderRadius: 999, cursor: "pointer", fontFamily: FONT, fontSize: 12,
              border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.2)", background: "rgb(var(--gooni-surf, 11 15 13) / 0.5)",
              color: "rgb(var(--gooni-ink, 244 245 244) / 0.6)",
            }}
          >
            trackables ▾
          </button>
          {/* voice mode switch — default on, persisted. Off = typed-only home. */}
          <button
            onClick={toggleVoiceMode}
            aria-label={voiceMode ? "Turn voice off" : "Turn voice on"}
            title={voiceMode ? "Voice on — Gooni listens + speaks. Click to go silent." : "Voice off — click to talk to Gooni."}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "5px 14px", borderRadius: 999, cursor: "pointer", fontFamily: FONT, fontSize: 12,
              border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.2)",
              background: voiceMode ? "rgba(74,222,128,0.12)" : "rgb(var(--gooni-surf, 11 15 13) / 0.5)",
              color: voiceMode ? "rgba(74,222,128,0.9)" : "rgb(var(--gooni-ink, 244 245 244) / 0.5)",
            }}
          >
            {voiceMode ? <Mic size={13} /> : <MicOff size={13} />}
            {voiceMode ? "voice" : "silent"}
          </button>
        </div>
      )}

      {logMode && <LogDots onClose={() => setLogMode(false)} />}

      {peekNote && <NotePeek note={peekNote} onClose={() => setPeekNote(null)} />}

      {/* activity log — the always-on unified stream (chats + notes + promise
          events + trackables), a compact DIMMED block under the wave + pills that
          brightens on hover and scrolls back into history. Hidden only under
          full-screen surfaces. */}
      <ActivityRail
        hidden={needsWake || !!peekNote || logMode}
        anchor={{ cx: rect.cx, top: rect.cy + PEEK_H / 2 + 96, width: rect.w }}
      />

      {/* live transcript — what the mic is hearing right now (ephemeral) */}
      {liveTranscript && (
        <div
          style={{
            position: "absolute",
            left: "50%", top: rect.cy + PEEK_H / 2 + 44, transform: "translateX(-50%)",
            width: "min(600px, 86vw)", textAlign: "center", zIndex: 5, pointerEvents: "none",
            fontFamily: FONT, fontSize: 15.5, lineHeight: 1.55, fontStyle: "italic",
            color: "rgb(var(--gooni-ink, 244 245 244) / 0.5)", textShadow: "0 1px 14px rgba(0,0,0,0.7)",
          }}
        >
          {liveTranscript}
        </div>
      )}

      {/* Gooni's reply subtitle (hidden while a fresh transcript is showing) */}
      {replyText && !liveTranscript && (
        <div
          style={{
            position: "absolute",
            left: "50%", top: rect.cy + PEEK_H / 2 + 44, transform: "translateX(-50%)",
            width: "min(600px, 86vw)", textAlign: "center", zIndex: 5,
            pointerEvents: "none", fontFamily: FONT, fontSize: 15.5, lineHeight: 1.55,
            color: "rgb(var(--gooni-ink, 244 245 244) / 0.86)", textShadow: "0 1px 14px rgba(0,0,0,0.7)",
            opacity: replyShown ? 1 : 0, transition: "opacity 420ms ease",
          }}
        >
          {replyText}
        </div>
      )}

      {/* bottom affordance — reflects the current mode */}
      <div
        style={{
          position: "fixed", bottom: 22, left: 0, right: 0, textAlign: "center",
          zIndex: 1, pointerEvents: "none", fontSize: 11.5, letterSpacing: 0.4,
          color: "rgb(var(--gooni-ink, 244 245 244) / 0.28)",
          opacity: needsWake || boxMode || logMode || thinking || replyText || liveTranscript ? 0 : 1,
          transition: "opacity 300ms ease",
        }}
      >
        {voiceMode && armed
          ? (listening ? "listening — just talk" : "…")
          : (
            <>
              press <kbd style={{
                fontFamily: FONT, fontWeight: 700, color: "rgb(var(--gooni-ink, 244 245 244) / 0.5)",
                padding: "1px 6px", borderRadius: 5, border: "1px solid rgba(255,255,255,0.12)",
              }}>/</kbd> or hover to capture a thought
            </>
          )}
      </div>

      {/* tap-to-wake veil — the one required gesture (unlocks mic + audio). One
          tap, then hands-free. "type instead" bails to the silent typed home. */}
      {needsWake && (
        <div
          onClick={arm}
          style={{
            position: "fixed", inset: 0, zIndex: 30, cursor: "pointer",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: 14, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)",
          }}
        >
          <div style={{
            width: 64, height: 64, borderRadius: "50%",
            display: "flex", alignItems: "center", justifyContent: "center",
            border: "1px solid rgba(74,222,128,0.4)", background: "rgba(74,222,128,0.08)",
            color: "rgba(74,222,128,0.9)", boxShadow: "0 0 40px rgba(74,222,128,0.18)",
          }}>
            <Mic size={26} />
          </div>
          <div style={{ fontFamily: FONT, fontSize: 16, color: "rgb(var(--gooni-ink, 244 245 244))", letterSpacing: 0.3 }}>
            tap to wake
          </div>
          <div style={{ fontFamily: FONT, fontSize: 12.5, color: "rgb(var(--gooni-ink, 244 245 244) / 0.45)" }}>
            then just talk — Gooni listens + speaks back
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); disableVoice(); }}
            style={{
              marginTop: 6, padding: "4px 12px", borderRadius: 999, cursor: "pointer",
              fontFamily: FONT, fontSize: 11.5, color: "rgb(var(--gooni-ink, 244 245 244) / 0.4)",
              background: "transparent", border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.14)",
            }}
          >
            type instead
          </button>
        </div>
      )}
    </div>
  );
}
