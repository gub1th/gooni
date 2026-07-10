import { useCallback, useEffect, useRef, useState } from "react";
import { FONT } from "../../ui";
import { MorphLine, type MorphRect } from "./MorphLine";
import { LimboCards } from "./LimboCards";
import { SummonedNav } from "./SummonedNav";
import { LogDots } from "./LogDots";
import { NotePeek } from "./NotePeek";
import {
  createConversation,
  dismissMessageGlow,
  fetchMessageLog,
  promoteMessage,
  searchNoteTitles,
  searchNotes,
  sendConversationMessage,
  type ApiNote,
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
// The wave's bounding box, the hover trigger zone, and the input box the wave
// morphs into are ONE rectangle: X = wave start→end (WAVE_WIDTH), Y = ±max
// amplitude (PEEK_H). So hovering anywhere on the wave is inside the box that
// forms, and leaving that rect melts it back — no edge flicker.
const WAVE_WIDTH = 440;
const PEEK_H = 104; // rest box height ≈ the wave's full amplitude span (+margin)
const FOCUS_MIN_H = 104; // never shrink below the resting bounds when focused
const MAX_H = 340;

function isGlowing(m: LogMessage): boolean {
  return Boolean(m.has_actionable_signal) && (m.signal_preview?.status ?? "pending") === "pending";
}

function energyFor(count: number): number {
  return Math.min(1, 0.14 + count * 0.28);
}

// dedupe two note lists by id (title-matches first, then semantic), capped
function mergeNotes(a: ApiNote[], b: ApiNote[], cap = 6): ApiNote[] {
  const seen = new Set<number>();
  const out: ApiNote[] = [];
  for (const n of [...a, ...b]) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    if (out.length >= cap) break;
  }
  return out;
}

export function AmbientHome() {
  const energyRef = useRef(0);
  const activeRef = useRef(0);

  const [vp, setVp] = useState({ w: 1200, h: 800 });
  const [limbo, setLimbo] = useState<LogMessage[]>([]);
  const [boxMode, setBoxMode] = useState(false);
  const [logMode, setLogMode] = useState(false);
  const [logPillHot, setLogPillHot] = useState(false);
  const [value, setValue] = useState("");
  const [boxH, setBoxH] = useState(PEEK_H);
  const [thinking, setThinking] = useState(false);
  const [replyText, setReplyText] = useState<string | null>(null);
  const [replyShown, setReplyShown] = useState(false);
  const [suggestions, setSuggestions] = useState<ApiNote[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [peekNote, setPeekNote] = useState<ApiNote | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const focusedRef = useRef(false);
  const hideTimer = useRef<number | null>(null);
  const enterTimer = useRef<number | null>(null);
  const searchTimer = useRef<number | null>(null);
  const searchSeq = useRef(0);
  const replyTimer = useRef<number | null>(null);
  const replyHideTimer = useRef<number | null>(null);

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
      // energy (green) tracks pending count; amplitude/"speaking" is activeRef,
      // kept independent so a reply landing doesn't fight the pending signal.
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

  // grow the box to fit the content (min depends on focus). Owns textarea
  // height imperatively so scrollHeight reads true, and mirrors it to the
  // morph target via boxH.
  const syncHeight = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    // unfocused → clear the explicit height so the box falls back to the
    // resting bounds (height:100% of the PEEK_H-tall hero)
    if (!focusedRef.current) { el.style.height = ""; setBoxH(PEEK_H); return; }
    el.style.height = "auto";
    const h = Math.max(FOCUS_MIN_H, Math.min(MAX_H, el.scrollHeight));
    el.style.height = `${h}px`;
    setBoxH(h);
  }, []);

  // Omnibox recall: as you type, note suggestions surface live (like a browser
  // address bar). Cheap title-substring is instant on every keystroke; semantic
  // (embedding-cosine) search fires on a short pause to also catch meaning-
  // matches. Empty box → recent notes (history). Enter never "searches harder" —
  // it commits your thought unless a suggestion is highlighted (↑/↓), which opens.
  const runRecall = useCallback((raw: string) => {
    const seq = ++searchSeq.current;
    if (searchTimer.current) { window.clearTimeout(searchTimer.current); searchTimer.current = null; }
    const q = raw.trim();
    setActiveIdx(-1);
    // nothing typed yet → no dropdown (don't greet an empty box with a list)
    if (!q) { setSuggestions([]); return; }
    void searchNoteTitles(q, 6)
      .then((r) => { if (seq === searchSeq.current) setSuggestions((prev) => mergeNotes(r, prev)); })
      .catch(() => {});
    searchTimer.current = window.setTimeout(() => {
      void searchNotes(q, 6)
        .then((sem) => { if (seq === searchSeq.current) setSuggestions((prev) => mergeNotes(prev, sem)); })
        .catch(() => {});
    }, 260);
  }, []);

  useEffect(() => {
    if (!boxMode) { setSuggestions([]); setActiveIdx(-1); return; }
    runRecall(value);
  }, [value, boxMode, runRecall]);

  function openNote(n: ApiNote) {
    setPeekNote(n);
    setSuggestions([]);
    setActiveIdx(-1);
    inputRef.current?.blur();
  }

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
  function clearEnterTimer() {
    if (enterTimer.current) { window.clearTimeout(enterTimer.current); enterTimer.current = null; }
  }

  // "/" → open + focus straight into the tall box
  function openBox() {
    clearHideTimer();
    clearEnterTimer();
    setBoxMode(true);
    activeRef.current = 1;
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // hover → short peek box, but only if you DWELL on the wave. A hover-intent
  // delay means a quick downward flick (heading for the log pill below) passes
  // through without summoning the box.
  function onHeroEnter() {
    clearHideTimer();
    clearEnterTimer();
    enterTimer.current = window.setTimeout(() => {
      setBoxMode(true);
      activeRef.current = 1;
    }, 160);
  }

  function onHeroLeave() {
    clearEnterTimer(); // cancel a pending open — the flick left before it fired
    if (focusedRef.current) return;
    if (value.trim()) return; // keep a drafted-but-unfocused thought
    activeRef.current = 0;
    clearHideTimer();
    hideTimer.current = window.setTimeout(() => setBoxMode(false), 110);
  }

  function clearReplyTimers() {
    if (replyTimer.current) { window.clearTimeout(replyTimer.current); replyTimer.current = null; }
    if (replyHideTimer.current) { window.clearTimeout(replyHideTimer.current); replyHideTimer.current = null; }
  }

  // Gooni speaks: the reply fades in as a subtitle under the wave, holds for a
  // read-time proportional to its length, then fades out → calm.
  function speak(text: string) {
    clearReplyTimers();
    setReplyText(text);
    requestAnimationFrame(() => setReplyShown(true));
    activeRef.current = 1; // wave stays lively while speaking
    const dur = Math.min(9000, Math.max(2600, text.length * 45));
    replyTimer.current = window.setTimeout(() => {
      setReplyShown(false);
      activeRef.current = 0;
      replyHideTimer.current = window.setTimeout(() => setReplyText(null), 420);
    }, dur);
  }

  function capture() {
    const text = value.trim();
    if (!text) return;
    // optimistic: clear + melt back to the wave immediately; then the wave
    // goes into "thinking", and Gooni's ack/answer speaks as a subtitle.
    setValue("");
    focusedRef.current = false;
    setBoxMode(false);
    setBoxH(PEEK_H);
    inputRef.current?.blur();
    clearReplyTimers();
    setReplyText(null);
    setThinking(true);
    activeRef.current = 1; // listening/thinking → livelier wave
    void (async () => {
      let reply = "";
      try {
        const conv = await createConversation();
        const out = await sendConversationMessage(conv.id, text);
        const assistant = [...out.messages].reverse().find((m) => m.role === "assistant");
        reply = (assistant?.content || "").trim();
      } catch {
        /* dropped — stay quiet, don't throw at the user */
      }
      setThinking(false);
      void reload(); // surface any glow card the turn produced
      if (reply) speak(reply);
      else activeRef.current = 0;
    })();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "ArrowDown" && suggestions.length) {
      e.preventDefault();
      setActiveIdx((i) => Math.min(suggestions.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp" && suggestions.length) {
      e.preventDefault();
      setActiveIdx((i) => Math.max(-1, i - 1));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // a highlighted suggestion opens; otherwise Enter commits the thought
      if (activeIdx >= 0 && suggestions[activeIdx]) { openNote(suggestions[activeIdx]); return; }
      capture();
      return;
    }
    if (e.key === "Escape") {
      if (activeIdx >= 0) { setActiveIdx(-1); return; }
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
      <MorphLine boxMode={boxMode} rect={rect} thinking={thinking} dimmed={logMode} waveWidth={waveW} energyRef={energyRef} activeRef={activeRef} />

      <LimboCards items={limbo} onPromote={onPromote} onDismiss={onDismiss} />
      <SummonedNav />

      {/* hero zone = the wave's bounding rectangle (X spans the wave, Y spans
          its max amplitude). This IS the box the wave morphs into AND the hover
          target, so hovering any part of the wave is inside the forming box and
          leaving the rect melts it back — no edge flicker. */}
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
        {/* textarea fills the box exactly; the morphed stroke IS its border
            (transparent fill here). Clicking anywhere in the rect focuses.
            Height (boxH) owned by syncHeight. */}
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
            position: "absolute", inset: 0, width: "100%", height: "100%", boxSizing: "border-box",
            resize: "none", outline: "none", border: "none", overflow: "hidden",
            fontFamily: FONT, fontSize: 16, lineHeight: 1.5, padding: "16px 22px",
            borderRadius: rect.r, color: "#F4F5F4", caretColor: "#4ADE80",
            background: boxMode ? "color-mix(in srgb, #0b0f0d 52%, transparent)" : "transparent",
            backdropFilter: boxMode ? "blur(16px)" : "none",
            WebkitBackdropFilter: boxMode ? "blur(16px)" : "none",
            opacity: boxMode ? 1 : 0,
            pointerEvents: boxMode ? "auto" : "none",
            transition: "opacity 200ms ease, background 220ms ease",
          }}
        />
      </div>

      {/* omnibox recall — live note suggestions under the box. ↑/↓ highlights,
          Enter on a highlight opens it inline; plain Enter still commits. */}
      {boxMode && suggestions.length > 0 && (
        <div
          style={{
            position: "absolute", left: "50%", top: rect.cy + boxH / 2 + 10,
            transform: "translateX(-50%)", width: rect.w, maxWidth: "86vw", zIndex: 7,
            display: "flex", flexDirection: "column", gap: 2,
            borderRadius: 14, padding: 6,
            background: "color-mix(in srgb, #0b0f0d 58%, transparent)",
            backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
            border: "1px solid rgba(244,245,244,0.10)", boxShadow: "0 16px 50px rgba(0,0,0,0.5)",
          }}
        >
          {suggestions.map((n, i) => (
            <button
              key={n.id}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => openNote(n)}
              style={{
                display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2,
                textAlign: "left", padding: "8px 12px", borderRadius: 10, cursor: "pointer",
                border: "none", fontFamily: FONT, width: "100%",
                background: i === activeIdx ? "rgba(244,245,244,0.08)" : "transparent",
              }}
            >
              <span style={{
                fontSize: 13.5, color: "#F4F5F4", fontWeight: 500,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%",
              }}>
                {n.title || "untitled"}
              </span>
              {n.excerpt && (
                <span style={{
                  fontSize: 11.5, color: "rgba(244,245,244,0.4)",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%",
                }}>
                  {n.excerpt}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* log trigger — a pill row the width of the wave box, hover-revealed just
          below it. One pill now (log); the row leaves room for more later. */}
      {!boxMode && !logMode && (
        <div
          onMouseEnter={() => setLogPillHot(true)}
          onMouseLeave={() => setLogPillHot(false)}
          style={{
            position: "absolute", left: rect.cx - rect.w / 2, top: rect.cy + PEEK_H / 2 + 18,
            width: rect.w, paddingTop: 16, zIndex: 3,
            display: "flex", justifyContent: "center", gap: 8,
            opacity: logPillHot ? 1 : 0, transition: "opacity 220ms ease",
          }}
        >
          <button
            onClick={() => setLogMode(true)}
            style={{
              padding: "5px 16px", borderRadius: 999, cursor: "pointer", fontFamily: FONT, fontSize: 12,
              border: "1px solid rgba(244,245,244,0.2)", background: "rgba(11,15,13,0.5)",
              color: "rgba(244,245,244,0.6)",
            }}
          >
            log ▾
          </button>
        </div>
      )}

      {logMode && <LogDots onClose={() => setLogMode(false)} />}

      {peekNote && <NotePeek note={peekNote} onClose={() => setPeekNote(null)} />}

      {/* Gooni's voice — thinking shows IN the wave (traveling pulse); when the
          reply lands it fades in here as a subtitle under the wave */}
      {replyText && (
        <div
          style={{
            position: "absolute",
            left: "50%", top: rect.cy + PEEK_H / 2 + 44, transform: "translateX(-50%)",
            width: "min(600px, 86vw)", textAlign: "center", zIndex: 5,
            pointerEvents: "none", fontFamily: FONT, fontSize: 15.5, lineHeight: 1.55,
            color: "rgba(244,245,244,0.86)", textShadow: "0 1px 14px rgba(0,0,0,0.7)",
            opacity: replyShown ? 1 : 0, transition: "opacity 420ms ease",
          }}
        >
          {replyText}
        </div>
      )}

      {/* faint affordance so the empty screen tells you how to start */}
      <div
        style={{
          position: "fixed", bottom: 22, left: 0, right: 0, textAlign: "center",
          zIndex: 1, pointerEvents: "none", fontSize: 11.5, letterSpacing: 0.4,
          color: "rgba(244,245,244,0.28)",
          opacity: boxMode || logMode || thinking || replyText ? 0 : 1, transition: "opacity 300ms ease",
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
