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
// when summoned (the line becomes the box), then back. Hover → short peek box;
// focus → it grows tall and expands with your lines; Enter → captured instantly
// (optimistic — the LLM turn runs in the background) and the box melts back to
// the wave with a green "got it" pulse. Pending glow-items + nav are their own
// summoned strokes over the black.

const POLL_MS = 15_000;
const PEEK_H = 60;
const FOCUS_MIN_H = 120;
const MAX_H = 340;

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
  const [value, setValue] = useState("");
  const [boxH, setBoxH] = useState(PEEK_H);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const focusedRef = useRef(false);
  const hideTimer = useRef<number | null>(null);
  const pulseTimer = useRef<number | null>(null);

  useEffect(() => {
    function onResize() { setVp({ w: window.innerWidth, h: window.innerHeight }); }
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const boxW = Math.min(560, vp.w * 0.86);
  const rect: MorphRect = { cx: vp.w / 2, cy: vp.h * 0.44, w: boxW, h: boxH, r: 18 };

  const reload = useCallback(async () => {
    try {
      const rows = await fetchMessageLog({ limit: 40 });
      const glowing = rows.filter(isGlowing);
      setLimbo(glowing);
      if (!pulseTimer.current) energyRef.current = energyFor(glowing.length);
    } catch {
      /* ambient surface — never throw at the user */
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(t);
  }, [reload]);

  // grow the box to fit the content (min depends on focus). Owns textarea
  // height imperatively so scrollHeight reads true, and mirrors it to the
  // morph target via boxH.
  const syncHeight = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    if (!focusedRef.current) { setBoxH(PEEK_H); return; }
    el.style.height = "auto";
    const h = Math.max(FOCUS_MIN_H, Math.min(MAX_H, el.scrollHeight));
    el.style.height = `${h}px`;
    setBoxH(h);
  }, []);

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
    if (hideTimer.current) { window.clearTimeout(hideTimer.current); hideTimer.current = null; }
  }

  // "/" → open + focus straight into the tall box
  function openBox() {
    clearHideTimer();
    setBoxMode(true);
    activeRef.current = 1;
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // hover → short peek box (no focus yet); click the box to commit + go tall
  function onHeroEnter() {
    clearHideTimer();
    setBoxMode(true);
    activeRef.current = 1;
  }

  function onHeroLeave() {
    if (focusedRef.current) return;
    if (value.trim()) return; // keep a drafted-but-unfocused thought
    activeRef.current = 0;
    clearHideTimer();
    hideTimer.current = window.setTimeout(() => setBoxMode(false), 450);
  }

  function capture() {
    const text = value.trim();
    if (!text) return;
    // optimistic: clear + melt back to the wave immediately; the LLM turn
    // runs in the background so capture feels instant.
    setValue("");
    focusedRef.current = false;
    setBoxMode(false);
    setBoxH(PEEK_H);
    inputRef.current?.blur();
    activeRef.current = 0;
    energyRef.current = 0.95; // green "got it" pulse on the wave
    if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
    pulseTimer.current = window.setTimeout(() => { pulseTimer.current = null; void reload(); }, 1200);
    void (async () => {
      try {
        const conv = await createConversation();
        await sendConversationMessage(conv.id, text); // reply discarded; glow runs
      } catch {
        /* dropped — could add a retry/toast later */
      }
      void reload();
    })();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      capture();
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
          top: rect.cy - 160,
          width: Math.max(rect.w, 620),
          height: 320,
          zIndex: 2,
        }}
      >
        {/* textarea overlaid exactly on the morph target; the morphed stroke
            IS its border (transparent here). Height owned by syncHeight. */}
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => { setValue(e.target.value); syncHeight(); }}
          onKeyDown={onKeyDown}
          onFocus={() => { focusedRef.current = true; activeRef.current = 1; syncHeight(); }}
          onBlur={() => { focusedRef.current = false; syncHeight(); onHeroLeave(); }}
          placeholder="what's on your mind?"
          spellCheck={false}
          style={{
            position: "absolute",
            left: "50%", top: 160, transform: "translate(-50%, -50%)",
            width: rect.w, minHeight: PEEK_H, boxSizing: "border-box",
            resize: "none", outline: "none", border: "none", overflow: "hidden",
            fontFamily: FONT, fontSize: 16, lineHeight: 1.5, padding: "17px 20px",
            borderRadius: rect.r, color: "#F4F5F4", caretColor: "#4ADE80",
            background: boxMode ? "color-mix(in srgb, #0b0f0d 52%, transparent)" : "transparent",
            backdropFilter: boxMode ? "blur(16px)" : "none",
            WebkitBackdropFilter: boxMode ? "blur(16px)" : "none",
            opacity: boxMode ? 1 : 0,
            pointerEvents: boxMode ? "auto" : "none",
            transition: "opacity 260ms ease 100ms, background 260ms ease",
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
