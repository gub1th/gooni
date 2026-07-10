import { useCallback, useEffect, useRef, useState } from "react";
import { FONT } from "../../ui";
import { WaveMark } from "./WaveMark";
import { TracedOutline } from "./TracedOutline";
import { LimboCards } from "./LimboCards";
import { SummonedNav } from "./SummonedNav";
import { GREEN } from "./wavePath";
import {
  createConversation,
  dismissMessageGlow,
  fetchMessageLog,
  promoteMessage,
  sendConversationMessage,
  type LogMessage,
} from "../../services/api";

// Line-art "presence" home. One breathing SVG stroke (WaveMark) is the only
// resident thing. Everything else is the line reshaping: summoned surfaces
// trace a rounded-rect outline on (TracedOutline) then fade content in.
//   • hover center (or "/") → the capture input traces itself out, taller
//   • submit → thought logged (glow runs; reply discarded), green pulse
//   • pending glow-items surface as traced green cards; count → wave energy
// Deterministic surfacing; the LLM only parses on capture.

const POLL_MS = 15_000;

function isGlowing(m: LogMessage): boolean {
  return Boolean(m.has_actionable_signal) && (m.signal_preview?.status ?? "pending") === "pending";
}

function energyFor(count: number): number {
  return Math.min(1, 0.14 + count * 0.28);
}

export function AmbientHome() {
  const energyRef = useRef(0);
  const activeRef = useRef(0);

  const [limbo, setLimbo] = useState<LogMessage[]>([]);
  const [inputShown, setInputShown] = useState(false);
  const [focused, setFocused] = useState(false);
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

  function onHeroEnter() {
    clearHideTimer();
    setInputShown(true);
    activeRef.current = 1;
  }

  function onHeroLeave() {
    if (document.activeElement === inputRef.current) return;
    activeRef.current = 0;
    if (value.trim()) return;
    clearHideTimer();
    hideTimer.current = window.setTimeout(() => setInputShown(false), 600);
  }

  async function capture() {
    const text = value.trim();
    if (!text || capturing) return;
    setCapturing(true);
    try {
      const conv = await createConversation();
      // fire the turn; the reply is intentionally discarded — the thought is
      // logged and the extractor has annotated any glow.
      await sendConversationMessage(conv.id, text);
      setValue("");
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
      /* keep the text for a retry */
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
    setLimbo((prev) => prev.filter((x) => x.id !== m.id));
    try { await promoteMessage(m.id); } finally { void reload(); }
  }
  async function onDismiss(m: LogMessage) {
    setLimbo((prev) => prev.filter((x) => x.id !== m.id));
    try { await dismissMessageGlow(m.id); } finally { void reload(); }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000", overflow: "hidden", fontFamily: FONT }}>
      {/* the mark — slightly above center so summoned surfaces have room below */}
      <div style={{ position: "absolute", left: "50%", top: "43%", transform: "translate(-50%, -50%)", zIndex: 1 }}>
        <WaveMark energyRef={energyRef} activeRef={activeRef} />
      </div>

      <LimboCards items={limbo} onPromote={onPromote} onDismiss={onDismiss} />
      <SummonedNav />

      {/* hero zone under the mark — hover wakes the capture input */}
      <div
        onMouseEnter={onHeroEnter}
        onMouseLeave={onHeroLeave}
        style={{
          position: "absolute", left: "50%", top: "58%", transform: "translateX(-50%)",
          width: "min(560px, 88vw)", zIndex: 3,
          display: "flex", justifyContent: "center",
        }}
      >
        <TracedOutline
          show={inputShown}
          radius={16}
          color={flash ? GREEN : "rgba(244,245,244,0.5)"}
          strokeWidth={1.5}
          glow={flash ? 0.5 : 0.18}
          style={{ width: "100%", pointerEvents: inputShown ? "auto" : "none" }}
        >
          <textarea
            ref={inputRef}
            value={value}
            rows={1}
            disabled={capturing}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => { setFocused(true); activeRef.current = 1; }}
            onBlur={() => { setFocused(false); onHeroLeave(); }}
            placeholder={flash ? "captured." : "what's on your mind?"}
            spellCheck={false}
            style={{
              width: "100%", resize: "none", outline: "none", border: "none",
              fontFamily: FONT, fontSize: 16, lineHeight: 1.5,
              padding: "14px 18px",
              // taller when focused (his ask) — the box grows once you commit
              minHeight: focused ? 92 : 50,
              transition: "min-height 220ms cubic-bezier(0.4,0,0.1,1)",
              borderRadius: 16, color: "#F4F5F4", caretColor: GREEN,
              background: "color-mix(in srgb, #0b0f0d 55%, transparent)",
              backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
            }}
          />
        </TracedOutline>
      </div>

      {/* faint affordance so the empty screen tells you how to start */}
      <div
        style={{
          position: "fixed", bottom: 22, left: 0, right: 0, textAlign: "center",
          zIndex: 1, pointerEvents: "none", fontSize: 11.5, letterSpacing: 0.4,
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
