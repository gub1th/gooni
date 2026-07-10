import { useCallback, useEffect, useRef, useState } from "react";
import { FONT } from "../../ui";
import { WaveformScene, useTabHidden } from "./WaveformScene";
import { LimboCards } from "./LimboCards";
import { SummonedNav } from "./SummonedNav";
import {
  createConversation,
  dismissMessageGlow,
  fetchMessageLog,
  promoteMessage,
  sendConversationMessage,
  type LogMessage,
} from "../../services/api";

// Ambient-loop v2 "presence" home. The waveform is the only resident thing;
// everything else is summoned:
//   • hover the hero zone (or press "/") → the capture input fades in
//   • focus it → the wave expands (activeRef), it "becomes the only thing"
//   • submit → the thought is captured into the log (glow extraction runs);
//     we discard the chatty reply so the home stays calm
//   • pending "limbo" glow-items float over the wave as frosted cards, and the
//     count feeds energyRef so the wave itself glows green when something waits
// All ranking/surfacing stays deterministic — the LLM only parses on capture.

const POLL_MS = 15_000;

function isGlowing(m: LogMessage): boolean {
  return Boolean(m.has_actionable_signal) && (m.signal_preview?.status ?? "pending") === "pending";
}

// energy target from how much is pending: a floor so the wave is never fully
// dead, climbing with each waiting item, capped at 1.
function energyFor(count: number): number {
  return Math.min(1, 0.14 + count * 0.28);
}

export function AmbientHome() {
  const energyRef = useRef(0);
  const activeRef = useRef(0);
  const hidden = useTabHidden();

  const [limbo, setLimbo] = useState<LogMessage[]>([]);
  const [inputShown, setInputShown] = useState(false);
  const [value, setValue] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [flash, setFlash] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const hideTimer = useRef<number | null>(null);
  const flashTimer = useRef<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const rows = await fetchMessageLog({ limit: 40 });
      const glowing = rows.filter(isGlowing);
      setLimbo(glowing);
      // don't let the capture flash get stomped by the poll
      if (!flashTimer.current) energyRef.current = energyFor(glowing.length);
    } catch {
      /* ambient surface — never throw at the user */
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(t);
  }, [reload]);

  // "/" anywhere summons the input (unless already typing in a field)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        revealInput();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearHideTimer() {
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }

  function revealInput() {
    clearHideTimer();
    setInputShown(true);
    activeRef.current = 1;
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // pointer entered the central hero zone → wake up
  function onHeroEnter() {
    clearHideTimer();
    setInputShown(true);
    activeRef.current = 1;
  }

  // pointer left → if not focused + empty, retreat to calm after a grace
  function onHeroLeave() {
    if (document.activeElement === inputRef.current) return;
    activeRef.current = 0;
    if (value.trim()) return; // keep a drafted-but-unfocused thought visible
    clearHideTimer();
    hideTimer.current = window.setTimeout(() => setInputShown(false), 600);
  }

  async function capture() {
    const text = value.trim();
    if (!text || capturing) return;
    setCapturing(true);
    try {
      const conv = await createConversation();
      // fire the turn; we intentionally ignore the assistant reply — the
      // thought is now logged and the extractor has annotated any glow.
      await sendConversationMessage(conv.id, text);
      setValue("");
      // brief "captured" pulse on the waveform
      setFlash(true);
      energyRef.current = 0.95;
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => {
        setFlash(false);
        flashTimer.current = null;
        void reload();
      }, 1100);
      void reload();
      inputRef.current?.focus();
    } catch {
      /* keep the text so the user can retry */
    } finally {
      setCapturing(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void capture();
    }
    if (e.key === "Escape") {
      (e.target as HTMLTextAreaElement).blur();
      activeRef.current = 0;
      if (!value.trim()) setInputShown(false);
    }
  }

  async function onPromote(m: LogMessage) {
    // optimistic — drop the card immediately, then confirm
    setLimbo((prev) => prev.filter((x) => x.id !== m.id));
    try { await promoteMessage(m.id); } finally { void reload(); }
  }
  async function onDismiss(m: LogMessage) {
    setLimbo((prev) => prev.filter((x) => x.id !== m.id));
    try { await dismissMessageGlow(m.id); } finally { void reload(); }
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "#000000",
        overflow: "hidden", fontFamily: FONT,
      }}
    >
      <WaveformScene energyRef={energyRef} activeRef={activeRef} paused={hidden} />

      <LimboCards items={limbo} onPromote={onPromote} onDismiss={onDismiss} />
      <SummonedNav />

      {/* Central hero zone — hovering wakes the input; the waveform lives here */}
      <div
        onMouseEnter={onHeroEnter}
        onMouseLeave={onHeroLeave}
        style={{
          position: "absolute", left: "50%", top: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(620px, 88vw)", height: 320,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "flex-end",
          zIndex: 2, gap: 18, paddingBottom: 4,
        }}
      >
        <div
          style={{
            width: "100%",
            opacity: inputShown ? 1 : 0,
            transform: inputShown ? "translateY(0)" : "translateY(10px)",
            transition: "opacity 260ms ease, transform 260ms ease",
            pointerEvents: inputShown ? "auto" : "none",
          }}
        >
          <textarea
            ref={inputRef}
            value={value}
            rows={1}
            disabled={capturing}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => { activeRef.current = 1; }}
            onBlur={onHeroLeave}
            placeholder={flash ? "captured." : "what's on your mind?"}
            spellCheck={false}
            style={{
              width: "100%", resize: "none", outline: "none",
              fontFamily: FONT, fontSize: 16, lineHeight: 1.5,
              padding: "14px 18px", borderRadius: 16,
              color: "#F4F5F4", caretColor: "#4ADE80",
              border: `1px solid ${flash ? "rgba(74,222,128,0.5)" : "rgba(255,255,255,0.14)"}`,
              background: "color-mix(in srgb, #0b0f0d 55%, transparent)",
              backdropFilter: "blur(var(--gooni-overlay-blur, 18px))",
              WebkitBackdropFilter: "blur(var(--gooni-overlay-blur, 18px))",
              boxShadow: flash
                ? "0 0 0 3px rgba(74,222,128,0.12), 0 10px 40px rgba(0,0,0,0.5)"
                : "0 10px 40px rgba(0,0,0,0.5)",
              transition: "border-color 200ms ease, box-shadow 200ms ease",
            }}
          />
        </div>
      </div>

      {/* faint affordance so the empty screen tells you how to start */}
      <div
        style={{
          position: "fixed", bottom: 22, left: 0, right: 0,
          textAlign: "center", zIndex: 1, pointerEvents: "none",
          fontSize: 11.5, letterSpacing: 0.4,
          color: "rgba(244,245,244,0.28)",
          opacity: inputShown ? 0 : 1, transition: "opacity 300ms ease",
        }}
      >
        press <kbd style={{
          fontFamily: FONT, fontWeight: 700, color: "rgba(244,245,244,0.5)",
          padding: "1px 6px", borderRadius: 5, border: "1px solid rgba(255,255,255,0.12)",
        }}>/</kbd> or hover to capture a thought
      </div>
    </div>
  );
}
