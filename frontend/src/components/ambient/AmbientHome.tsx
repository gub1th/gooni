import { useCallback, useEffect, useRef, useState } from "react";
import { FONT } from "../../ui";
import { MorphLine, type MorphRect } from "./MorphLine";
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

// Line-art "presence" home. ONE stroke (MorphLine) is the only resident thing:
// a tall breathing waveform at rest that BENDS into the capture input's outline
// when summoned (the line becomes the box), then back. Pending glow-items and
// the nav are their own summoned strokes over the black.
//   • hover center (or "/") → the wave morphs into the input box; text fades in
//   • submit → thought logged (glow runs; reply discarded), green pulse
//   • pending glow-items → traced green cards; count → wave energy (white→green)

const POLL_MS = 15_000;

function isGlowing(m: LogMessage): boolean {
  return Boolean(m.has_actionable_signal) && (m.signal_preview?.status ?? "pending") === "pending";
}

function energyFor(count: number): number {
  return Math.min(1, 0.14 + count * 0.28);
}

// px geometry of the morph target (the input box). Centered, a touch above
// the middle. The wave lives here too, so it collapses into the box in place.
function computeRect(vw: number, vh: number): MorphRect {
  const w = Math.min(560, vw * 0.86);
  return { cx: vw / 2, cy: vh * 0.44, w, h: 96, r: 18 };
}

export function AmbientHome() {
  const energyRef = useRef(0);
  const activeRef = useRef(0);

  const [vp, setVp] = useState({ w: 1200, h: 800 });
  const [limbo, setLimbo] = useState<LogMessage[]>([]);
  const [boxMode, setBoxMode] = useState(false);
  const [value, setValue] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [flash, setFlash] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const hideTimer = useRef<number | null>(null);
  const flashTimer = useRef<number | null>(null);

  useEffect(() => {
    function onResize() { setVp({ w: window.innerWidth, h: window.innerHeight }); }
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const rect = computeRect(vp.w, vp.h);

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
        openBox();
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

  function openBox() {
    clearHideTimer();
    setBoxMode(true);
    activeRef.current = 1;
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function onHeroEnter() {
    clearHideTimer();
    setBoxMode(true);
    activeRef.current = 1;
  }

  function onHeroLeave() {
    if (document.activeElement === inputRef.current) return;
    if (value.trim()) return; // keep a drafted-but-unfocused thought
    activeRef.current = 0;
    clearHideTimer();
    hideTimer.current = window.setTimeout(() => setBoxMode(false), 500);
  }

  async function capture() {
    const text = value.trim();
    if (!text || capturing) return;
    setCapturing(true);
    try {
      const conv = await createConversation();
      await sendConversationMessage(conv.id, text); // reply discarded; glow runs
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

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000", overflow: "hidden", fontFamily: FONT }}>
      {/* the one line — waveform ⇄ input box */}
      <MorphLine boxMode={boxMode} rect={rect} energyRef={energyRef} activeRef={activeRef} />

      <LimboCards items={limbo} onPromote={onPromote} onDismiss={onDismiss} />
      <SummonedNav />

      {/* hero zone around the mark — hover wakes the box; generous target */}
      <div
        onMouseEnter={onHeroEnter}
        onMouseLeave={onHeroLeave}
        style={{
          position: "absolute",
          left: rect.cx - Math.max(rect.w, 620) / 2,
          top: rect.cy - 120,
          width: Math.max(rect.w, 620),
          height: 240,
          zIndex: 2,
        }}
      >
        {/* textarea overlaid exactly on the morph target; it IS the box the
            line becomes. Border is transparent — the morphed stroke draws it. */}
        <textarea
          ref={inputRef}
          value={value}
          disabled={capturing}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => { activeRef.current = 1; }}
          onBlur={onHeroLeave}
          placeholder={flash ? "captured." : "what's on your mind?"}
          spellCheck={false}
          style={{
            position: "absolute",
            left: "50%", top: 120, transform: "translate(-50%, -50%)",
            width: rect.w, height: rect.h, boxSizing: "border-box",
            resize: "none", outline: "none", border: "none",
            fontFamily: FONT, fontSize: 16, lineHeight: 1.5, padding: "16px 20px",
            borderRadius: rect.r, color: "#F4F5F4", caretColor: "#4ADE80",
            background: boxMode ? "color-mix(in srgb, #0b0f0d 55%, transparent)" : "transparent",
            backdropFilter: boxMode ? "blur(14px)" : "none",
            WebkitBackdropFilter: boxMode ? "blur(14px)" : "none",
            opacity: boxMode ? 1 : 0,
            pointerEvents: boxMode ? "auto" : "none",
            transition: "opacity 260ms ease 120ms, background 260ms ease",
          }}
        />
      </div>

      {/* faint affordance so the empty screen tells you how to start */}
      <div
        style={{
          position: "fixed", bottom: 22, left: 0, right: 0, textAlign: "center",
          zIndex: 1, pointerEvents: "none", fontSize: 11.5, letterSpacing: 0.4,
          color: "rgba(244,245,244,0.28)",
          opacity: boxMode ? 0 : 1, transition: "opacity 300ms ease",
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
