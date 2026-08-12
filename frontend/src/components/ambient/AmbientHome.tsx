import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, StickyNote } from "lucide-react";
import { FONT, frostInk } from "../../ui";
import { speakText, isVoiceMode, setVoiceMode, stopSpeaking, primeAudio } from "../../services/speech";
import { MorphLine, type MorphRect } from "./MorphLine";
import { LimboCards } from "./LimboCards";
import { LogDots } from "./LogDots";
import { NotePeek } from "./NotePeek";
import { StickyLayer, type StickyHandle } from "./StickyLayer";
import { TodayList, type SessionRow, type TodayRow } from "./TodayList";
import { useHomeChromeStore } from "../../stores/useHomeChromeStore";
import { LogSheet } from "./LogSheet";
import { SessionInWave } from "./SessionInWave";
import { useSessionAttachStore } from "../../stores/useSessionAttachStore";
import { MarkKeptOffer } from "../focus/MarkKeptOffer";
import { ink } from "./ambientInk";
import { emptyRetained, mergeTodayRows, retainTicked } from "./todayRows";
import {
  endFocusSession,
  fetchFocusTotals,
  switchFocusSession,
  type FocusTotals,
} from "../../services/focusTime";
import {
  useFocusSessionStore,
  elapsedMs,
  isAccruingFocus,
} from "../../stores/useFocusSessionStore";
import {
  createConversation,
  createFocusReminder,
  createNote,
  dismissMessageGlow,
  fetchCalendarEvents,
  fetchFocusDashboard,
  fetchMessageLog,
  promoteMessage,
  sendConversationMessage,
  updateFocusReminder,
  SHORT_BUCKETS,
  type ApiNote,
  type CalendarEvent,
  type FocusReminder,
  type LogMessage,
} from "../../services/api";

// THE home. One surface, Momentum's layout, in Gooni's palette on the void.
//
// Every group is pinned to its own vertical PERCENTAGE rather than stacked in
// flow: that is what keeps the wave at true centre no matter how long the line
// runs or how many tasks are on today. Stacking would drift the wave down as
// the list grows, and the wave is the anchor.
//
// The treatment rule that governs everything here: the screen reads as spacious
// because everything that is not the wave is dim, bare, at an edge, or
// summoned — plain text on the void, no frost, brightening on hover. Nothing at
// the CENTRE of the screen gets a frosted pill, a filled container, or a card;
// chrome at centre reads as a second anchor and competes with the wave. No drop
// shadows anywhere (the deliberate 2026-08-02 pass).
//
// VOICE-FIRST (default): the wave is always listening. Tap once to wake (a
// browser gesture is unavoidable — it unlocks the mic + audio autoplay), then
// it's hands-free. The mic toggle is a bare corner glyph now, not a pill.
//
// SEARCH LIVES ELSEWHERE — `QuickFind` (⌘K, invisible at rest). The capture box
// only captures.

const POLL_MS = 15_000;
const DASH_POLL_MS = 30_000;
const WAVE_WIDTH = 440;
const PEEK_H = 104; // rest box height ≈ the wave's full amplitude span (+margin)
const FOCUS_MIN_H = 104; // never shrink below the resting bounds when focused
const MAX_H = 340;
const IDLE_LISTEN_AMP = 0.4; // gentle live wave while listening at rest
const MIN_UTTERANCE = 2; // ignore stray one-char finals / noise

// Momentum's vertical rhythm, as fractions of the viewport. Pinning each group
// to its own fraction (rather than stacking them in flow under the wave) is
// what keeps the wave at true centre however long the line or the list runs.
const WAVE_Y = 0.47;
const QUIP_Y = 0.57;
const TODAY_Y = 0.66;
// What the ROWS may claim before they scroll instead of growing. Without a cap
// a ten-task day walks off the bottom and takes `+ add`, `N later` and the
// capture hint with it. Reserve is: `+ add` + `N later` + the streak row + the
// hint, all of which have to stay on screen at any list length.
const ROWS_MAX = `calc(${(1 - TODAY_Y) * 100}vh - 152px)`;

// Deliberately a fixed string and deliberately a SLOT: this is the one thing on
// the screen that could know something Daniel doesn't (what he kept, what's
// slipping, what the sensors saw), and Gooni will write it later. No generator
// and no quotes file in the meantime — a random quote would occupy the slot
// while teaching nobody anything.
const QUIP = "Another day of keeping the nose to the grindstone.";

// It is a MOMENT, not furniture (pass 3). As a permanent fixture it was the
// largest thing on the screen and never changed, which is the definition of
// loud and saying nothing. It shows on the first load of the day and after
// finishing something, then goes.
//
// The slot is absolutely positioned, so its absence collapses nothing — the
// wave simply keeps the space, which is what was asked for.
const QUIP_SEEN_KEY = "gooni_quip_day";
const QUIP_MS = 12_000;

function firstLoadToday(): boolean {
  try {
    const today = new Date().toDateString();
    if (localStorage.getItem(QUIP_SEEN_KEY) === today) return false;
    localStorage.setItem(QUIP_SEEN_KEY, today);
    return true;
  } catch {
    return false; // private mode — better silent than shouting every load
  }
}

// Evaluated at MODULE scope, once per page load. It cannot go in a useState
// initializer: this check consumes the day's one showing as a side effect, and
// StrictMode double-invokes initializers in dev — the second call would find
// the key already written and answer false, so the phrase never appeared.
const FIRST_LOAD_TODAY = firstLoadToday();

function isGlowing(m: LogMessage): boolean {
  return Boolean(m.has_actionable_signal) && (m.signal_preview?.status ?? "pending") === "pending";
}

function energyFor(count: number): number {
  return Math.min(1, 0.14 + count * 0.28);
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function todayWindowISO(): { startISO: string; endISO: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  return { startISO: start.toISOString(), endISO: new Date(start.getTime() + 86_400_000).toISOString() };
}

export function AmbientHome({
  trackablesOpen = false,
  onCloseTrackables,
  covered: coveredBySurface = false,
}: {
  /** the log matrix, opened from the rail (URL-driven) or the streak row */
  trackablesOpen?: boolean;
  onCloseTrackables?: () => void;
  /** a surface panel is sliding over the home — stand every affordance down */
  covered?: boolean;
} = {}) {
  const energyRef = useRef(0);
  const activeRef = useRef(0);

  const [vp, setVp] = useState({ w: 1200, h: 800 });
  const [limbo, setLimbo] = useState<LogMessage[]>([]);
  const [boxMode, setBoxMode] = useState(false);
  const [logSheet, setLogSheet] = useState(false);
  const [value, setValue] = useState("");
  const [boxH, setBoxH] = useState(PEEK_H);
  const [thinking, setThinking] = useState(false);
  const [replyText, setReplyText] = useState<string | null>(null);
  const [replyShown, setReplyShown] = useState(false);
  const [peekNote, setPeekNote] = useState<ApiNote | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [quipShown, setQuipShown] = useState(FIRST_LOAD_TODAY);
  const quipTimer = useRef<number | null>(null);

  const showQuip = useCallback(() => {
    setQuipShown(true);
    if (quipTimer.current) window.clearTimeout(quipTimer.current);
    quipTimer.current = window.setTimeout(() => setQuipShown(false), QUIP_MS);
  }, []);

  useEffect(() => {
    if (!quipShown) return;
    if (quipTimer.current) window.clearTimeout(quipTimer.current);
    quipTimer.current = window.setTimeout(() => setQuipShown(false), QUIP_MS);
    return () => { if (quipTimer.current) window.clearTimeout(quipTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const stickyRef = useRef<StickyHandle>(null);
  const focusedRef = useRef(false);
  const sessionInSlotRef = useRef(false);
  const boxModeRef = useRef(false);
  const hideTimer = useRef<number | null>(null);
  const enterTimer = useRef<number | null>(null);
  const replyTimer = useRef<number | null>(null);
  const replyHideTimer = useRef<number | null>(null);

  // ── today's commitments + accrued focus ────────────────────────────────────
  const [shortTerm, setShortTerm] = useState<FocusReminder[]>([]);
  const [longTerm, setLongTerm] = useState<FocusReminder[]>([]);
  const [totals, setTotals] = useState<FocusTotals>({ today: 0, byPromise: {} });
  const [events, setEvents] = useState<CalendarEvent[]>([]);

  const session = useFocusSessionStore((s) => s.session);
  const hasSession = session != null;
  const attached = useSessionAttachStore((s) => s.attached);
  const setAttached = useSessionAttachStore((s) => s.setAttached);
  // ATTACHED means the session is holding the wave's slot. Detached, it lives
  // in the band and the wave comes back — the session runs either way.
  const sessionInSlot = hasSession && attached;
  const accruing = isAccruingFocus(session);
  const [nowTick, setNowTick] = useState(() => Date.now());
  // The per-second cadence belongs to the ONE state that moves a number on this
  // screen: live focus. On a break or a pause nothing here advances (the row
  // stops claiming a clock, and the day-fold drops break segments), but the tick
  // must stay alive at a lazy rate — the corner stat asks which local day it is,
  // and a frozen tick keeps answering "yesterday" past midnight, crediting today
  // with minutes earned yesterday.
  useEffect(() => {
    if (!hasSession) return;
    setNowTick(Date.now());
    const iv = window.setInterval(() => setNowTick(Date.now()), accruing ? 1000 : 60_000);
    return () => window.clearInterval(iv);
  }, [hasSession, accruing]);

  useEffect(() => {
    function onResize() { setVp({ w: window.innerWidth, h: window.innerHeight }); }
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  sessionInSlotRef.current = sessionInSlot;
  boxModeRef.current = boxMode;

  const boxW = Math.min(WAVE_WIDTH + 40, vp.w * 0.9);
  const rect: MorphRect = { cx: vp.w / 2, cy: vp.h * WAVE_Y, w: boxW, h: boxH, r: 20 };
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

  // What the server serves is not on its own the list: a row ticked in this
  // sitting and a row with a running session on it both have to survive the
  // dashboard dropping them from its ACTIVE set. The rule (and why) lives in
  // `todayRows.ts`; this ref is the sitting's memory of it.
  const retained = useRef(emptyRetained());

  const mergeShortTerm = useCallback((serverRows: FocusReminder[]): FocusReminder[] => {
    const live = useFocusSessionStore.getState().session;
    return mergeTodayRows(
      serverRows,
      retained.current,
      live ? { promiseId: live.promiseId, title: live.title, kept: live.kept } : null,
    );
  }, []);

  // The short-term/longer-term split is the BACKEND's (focus_service's due
  // distance), not a client guess — `+ add` defaults everything to today's EOD,
  // so "later" has to mean what the server says it means or TODAY silently
  // becomes a dumping ground.
  const loadCommitments = useCallback(async () => {
    try {
      const d = await fetchFocusDashboard();
      setShortTerm(mergeShortTerm(SHORT_BUCKETS.flatMap((b) => d.short_term[b] ?? [])));
      setLongTerm(d.long_term ?? []);
    } catch {
      /* ambient */
    }
  }, [mergeShortTerm]);

  const loadTotals = useCallback(async () => {
    try {
      setTotals(await fetchFocusTotals());
    } catch {
      /* the focus trackable may not exist yet — zero is honest here */
    }
  }, []);

  useEffect(() => {
    void loadCommitments();
    void loadTotals();
    const iv = window.setInterval(() => { void loadCommitments(); void loadTotals(); }, DASH_POLL_MS);
    return () => window.clearInterval(iv);
  }, [loadCommitments, loadTotals]);

  // A finished session writes its entry and then bumps `focused today` — reload
  // whenever the store drops back to null.
  useEffect(() => {
    if (session == null) void loadTotals();
  }, [session, loadTotals]);

  useEffect(() => {
    const { startISO, endISO } = todayWindowISO();
    fetchCalendarEvents(startISO, endISO).then(setEvents).catch(() => setEvents([]));
  }, []);

  const rows: TodayRow[] = useMemo(
    () => shortTerm.map((item) => ({ item, minutes: totals.byPromise[item.id] ?? 0 })),
    [shortTerm, totals],
  );

  // The row indicator, derived ONCE from the state that already exists. Three
  // cases, not two: only live FOCUS is accruing — break segments are dropped by
  // `splitSegmentsByDay` (so `focused today` never moves and no entry is ever
  // written for them) and a paused session accrues nothing at all.
  const sessionRow: SessionRow | null = useMemo(() => {
    if (!session) return null;
    // Two states now, not three — break is gone. Still ONE derivation
    // (`isAccruingFocus`) rather than a per-state test at this call site.
    const elapsed = elapsedMs(session, "focus", nowTick);
    return {
      promiseId: session.promiseId,
      state: isAccruingFocus(session) ? "focus" : "paused",
      // mirrors the session bar exactly: a timer counts DOWN, so the row must
      // not sit next to it counting up and disagreeing about the same session
      label: mmss(session.style === "timer" ? Math.max(0, session.targetMs - elapsed) : elapsed),
    };
  }, [session, nowTick]);

  // ── Voice engine ──────────────────────────────────────────────────────────
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
    void loadCommitments(); // a promoted/kept promise should land on TODAY
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

  const openNote = useCallback((n: ApiNote) => {
    setPeekNote(n);
    inputRef.current?.blur();
  }, []);

  // Publish the two HOME functions the sticky header renders buttons for, plus
  // the state those buttons display. The header is mounted in AppShell and this
  // component is portaled to the body, so there is no shared provider — and the
  // mic's recogniser reads live refs that cannot move out of here. See
  // stores/useHomeChromeStore.ts for why the seam is a store.
  const publishChrome = useHomeChromeStore((s) => s.publish);
  useEffect(() => {
    publishChrome({
      voiceOn: voiceMode,
      listening,
      hasEventToday: events.length > 0,
      logOpen: logSheet,
      toggleVoice: toggleVoiceMode,
      toggleLog: () => setLogSheet((o) => !o),
      openNote,
    });
  }, [publishChrome, voiceMode, listening, events.length, logSheet, toggleVoiceMode, openNote]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      // Esc is the keyboard way out of the slot — it detaches rather than
      // stopping, because wanting your wave back is not wanting to end the
      // session. It only fires when the session is actually in the slot and
      // the box is closed, so it never steals Esc from the capture box.
      if (e.key === "Escape" && sessionInSlotRef.current && !typing && !boxModeRef.current) {
        setAttached(false);
        return;
      }
      if (e.key === "/" && !typing) {
        e.preventDefault();
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
    // While the session holds this slot, hover does NOT summon the box. The
    // wave was the only cue that hovering here would do anything, and the
    // session replaced it — so hovering became an ambush that swept the
    // session away with nothing having advertised it. `/` still works, and it
    // visibly displaces the session so the box has an origin.
    if (sessionInSlotRef.current) return;
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

  function closeBox() {
    setValue("");
    focusedRef.current = false;
    setBoxMode(false);
    setBoxH(PEEK_H);
    inputRef.current?.blur();
  }

  // Typed capture (voice off, or optional typing while voice on) — silent reply.
  function capture() {
    const text = value.trim();
    if (!text) return;
    closeBox();
    void runTurn(text, false);
  }

  // ⌘/Ctrl+Enter — the same box, the other exit. First line becomes the title,
  // the rest the body: the shape a quick capture takes everywhere else in Gooni.
  async function captureAsNote() {
    const text = value.trim();
    if (!text) return;
    closeBox();
    const [first, ...restLines] = text.split("\n");
    try {
      await createNote("general", { title: first.slice(0, 120), content: restLines.join("\n") });
      flash("saved as a note");
    } catch {
      flash("couldn't save that note");
    }
  }

  function flash(msg: string) {
    setSavedFlash(msg);
    window.setTimeout(() => setSavedFlash((m) => (m === msg ? null : m)), 2400);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void captureAsNote();
      return;
    }
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
    try { await promoteMessage(m.id); } finally { void reload(); void loadCommitments(); }
  }
  async function onDismiss(m: LogMessage) {
    setLimbo((prev) => prev.filter((x) => x.id !== m.id));
    try { await dismissMessageGlow(m.id); } finally { void reload(); }
  }

  // ── the list's three writes ────────────────────────────────────────────────

  // Ticking is OPTIMISTIC and in place: the row must not jump out from under
  // the pointer, and it must not wait on a round trip to show it registered.
  async function onTick(item: FocusReminder) {
    const next = item.state === "kept" ? "active" : "kept";
    const updated: FocusReminder = { ...item, state: next, done: next === "kept" };
    const undoRetention = retainTicked(retained.current, updated);
    if (next === "kept") showQuip(); // finishing something is the other moment
    setShortTerm((prev) => prev.map((r) => (r.id === item.id ? updated : r)));
    // If a session is running on this task, both surfaces have to agree about
    // it — the session store is where they meet.
    const onRunningTask = useFocusSessionStore.getState().session?.promiseId === item.id;
    if (onRunningTask) useFocusSessionStore.getState().setKept(next === "kept");
    try {
      await updateFocusReminder(item.id, { state: next });
    } catch {
      // The write never landed, so roll back to exactly the pre-click state —
      // both directions. A failed UN-tick that dropped the retention entry
      // would take the row off TODAY for good.
      undoRetention();
      setShortTerm((prev) => prev.map((r) => (r.id === item.id ? item : r)));
      if (onRunningTask) useFocusSessionStore.getState().setKept(item.state === "kept");
    } finally {
      void loadCommitments();
    }
  }

  // A title alone. `cadence=once` and a due defaulted to today's local EOD with
  // `due_is_default` set — the shape `set_reminder` uses, so `auto_mark_overdue`
  // never breaks a deadline Gooni invented. Omitting `due_hint` is what asks the
  // backend for that default.
  async function onAdd(title: string) {
    try {
      await createFocusReminder({ content: title });
    } catch {
      // The field closes either way, so silence would read as "added" — and the
      // rejection would escape the list's `void submit()` unhandled.
      flash("couldn't add that");
    } finally {
      void loadCommitments();
    }
  }

  // Focus has exactly ONE door and it is a task. Starting one ENDS whatever was
  // running — silently, but only once that session's entry has landed: a switch
  // that swapped the store would delete minutes nothing had recorded yet.
  // The row's stop is the same write-then-clear path the bar and the overlay
  // use — there is one place that decides a session may only be dropped once
  // its entry has landed, and this is not a second one.
  async function stopSession() {
    try {
      await endFocusSession();
    } catch {
      flash("couldn't save that session — it's paused, not lost");
      return;
    }
    void loadTotals();
    void loadCommitments();
  }

  async function startFocus(item: FocusReminder) {
    try {
      await switchFocusSession(item.id, item.content);
    } catch {
      // `endFocusSession` sealed before it wrote, so the old session is PAUSED
      // and unswitched — saying "still on it" would claim a clock that stopped.
      flash("couldn't save that session — it's paused, not switched");
      return;
    }
    // The outgoing session's entry just landed, and the new session's live
    // contribution is zero — without this the corner drops the minutes it has
    // this instant recorded and stays wrong until the 30s poll. The store went
    // A → B in one batch, so the null-transition effect never sees it.
    void loadTotals();
    // Deliberately NO navigate. Focus is a STATE, not a place: starting it must
    // leave you exactly where you were working, with the banner picking the
    // session up. Sending you to /focus is what the last cut did, and being
    // moved to a page you then had to navigate back from is the whole reason
    // this was reworked.
  }

  const needsWake = voiceMode && !armed; // show the tap-to-wake veil

  // Any full-screen surface owns the void; the stage stands down under it.
  const covered = coveredBySurface || trackablesOpen || !!peekNote || needsWake;
  // The stage yields to the capture box the moment it opens. It used to wait
  // for the box to GROW past its resting bounds, which read as the box and the
  // line briefly sharing the screen.
  const stageHidden = covered || boxMode;

  function onRootDoubleClick(e: React.MouseEvent) {
    if (boxMode || covered || logSheet) return;
    if ((e.target as HTMLElement).closest("button, textarea, input, a, [data-sticky], [data-chat-ribbon], [data-quickfind], [data-log-sheet]")) return;
    stickyRef.current?.createAt(e.clientX, e.clientY);
  }

  return (
    <div
      onDoubleClick={onRootDoubleClick}
      // Full-bleed from the very top: the sticky header floats OVER the void
      // rather than pushing it down, and the session band it used to clear is
      // gone — the notch in the header carries the session now.
      style={{
        position: "fixed", inset: 0,
        background: "var(--gooni-void, #000000)", overflow: "hidden", fontFamily: FONT,
      }}
    >
      {/* While a session holds the slot the resting stroke stands down, but
          MorphLine STAYS MOUNTED: it still owns the box the capture input
          morphs into, so `/` and hover work exactly as before during a
          session. The session display fades out as the box opens. */}
      <MorphLine
        boxMode={boxMode}
        rect={rect}
        thinking={thinking}
        dimmed={trackablesOpen || (sessionInSlot && !boxMode)}
        waveWidth={waveW}
        energyRef={energyRef}
        activeRef={activeRef}
      />

      {sessionInSlot && !covered && (
        <SessionInWave
          cx={rect.cx}
          cy={rect.cy}
          hidden={boxMode}
          energyRef={energyRef}
          onStop={() => void stopSession()}
          onDetach={() => setAttached(false)}
        />
      )}
      <StickyLayer ref={stickyRef} vp={vp} center={{ cx: rect.cx, cy: rect.cy, w: boxW }} hidden={covered || logSheet} />

      <LimboCards items={limbo} onPromote={onPromote} onDismiss={onDismiss} />


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
            borderRadius: rect.r, color: "rgb(var(--gooni-ink, 244 245 244))", caretColor: frostInk.accent,
            background: boxMode ? "color-mix(in srgb, rgb(var(--gooni-surf, 11 15 13)) 52%, transparent)" : "transparent",
            backdropFilter: boxMode ? "blur(16px)" : "none",
            WebkitBackdropFilter: boxMode ? "blur(16px)" : "none",
            opacity: boxMode ? 1 : 0,
            pointerEvents: boxMode ? "auto" : "none",
            transition: "opacity 200ms ease, background 220ms ease",
          }}
        />
        {/* the note exit, discoverable but quiet — the box's other door */}
        {boxMode && (
          <button
            onClick={() => void captureAsNote()}
            title="⌘↵ — save as a note instead"
            aria-label="Save as a note"
            style={{
              position: "absolute", right: 12, bottom: 10, zIndex: 1,
              display: "inline-flex", alignItems: "center", gap: 5,
              border: "none", background: "transparent", padding: "2px 4px", cursor: "pointer",
              fontFamily: FONT, fontSize: 10.5, color: ink(0.34),
            }}
          >
            <StickyNote size={11} strokeWidth={1.8} />
            ⌘↵ note
          </button>
        )}
      </div>

      {/* stopping OFFERS completion — right where you stopped, under the slot */}
      {!covered && (
        <div
          style={{
            position: "absolute", left: rect.cx, top: rect.cy + PEEK_H / 2 + 26,
            transform: "translateX(-50%)", zIndex: 4,
          }}
        >
          <MarkKeptOffer
            onKept={(offer) => {
              // Taking the offer completes the task, and `/focus/dashboard`
              // serves ACTIVE rows only — so without retention the row would
              // VANISH on the next poll instead of staying struck through in
              // place, which is the rule everywhere else a task is completed.
              const seen = retained.current.seen.get(offer.promiseId);
              retainTicked(
                retained.current,
                seen
                  ? { ...seen, state: "kept", done: true }
                  : {
                      id: offer.promiseId, type: "promise", content: offer.title,
                      owed_to: null, due_at: null, due_is_default: true,
                      done: true, state: "kept", resolved_at: null,
                      age_days: 0, lasted_days: 0, thought_id: null,
                    },
              );
              void loadCommitments();
            }}
          />
        </div>
      )}

      {/* ── the stage: line · TODAY · streaks, each pinned to its own % ─────── */}
      <div
        style={{
          // pointerEvents NONE on the full-bleed layer, auto on the children
          // that need it. The stage spans inset:0 ABOVE the hero zone, so a
          // hit-testable stage swallowed the mouseenter that summons the
          // capture box — hovering the wave did nothing at all.
          position: "absolute", inset: 0, zIndex: 3, pointerEvents: "none",
          opacity: stageHidden ? 0 : 1, transition: "opacity 220ms ease",
        }}
      >
        <div
          style={{
            // CENTRE-anchored on its fraction, not top-anchored: the line is a
            // slot Gooni will write into, so it has to grow both ways from its
            // mark rather than only downward into the list.
            position: "absolute", top: `${QUIP_Y * 100}%`, left: "50%", transform: "translate(-50%, -50%)",
            width: "min(19ch, 86vw)", textAlign: "center",
            fontSize: 33, fontWeight: 600, letterSpacing: "-0.022em", lineHeight: 1.18,
            color: ink(0.92), pointerEvents: "none",
            opacity: quipShown ? 1 : 0,
            transition: "opacity 600ms ease",
          }}
        >
          {QUIP}
        </div>

        <div
          style={{
            position: "absolute", top: `${TODAY_Y * 100}%`, left: "50%", transform: "translateX(-50%)",
            width: "min(560px, 84vw)",
            pointerEvents: stageHidden ? "none" : "auto",
          }}
        >
          <TodayList
            rowsMaxHeight={ROWS_MAX}
            rows={rows}
            laterCount={longTerm.length}
            laterRows={longTerm}
            sessionRow={sessionRow}
            onTick={(item) => void onTick(item)}
            onAdd={onAdd}
            onFocus={(item) => void startFocus(item)}
            onTogglePause={() => {
              const st = useFocusSessionStore.getState();
              if (st.session?.running) st.pause();
              else st.resume();
            }}
            onStop={() => void stopSession()}
          />
        </div>
      </div>

      {trackablesOpen && <LogDots onClose={() => onCloseTrackables?.()} />}


      {peekNote && <NotePeek note={peekNote} onClose={() => setPeekNote(null)} />}

      <LogSheet open={logSheet && !covered} onClose={() => setLogSheet(false)} events={events} />

      {/* live transcript — what the mic is hearing right now (ephemeral) */}
      {liveTranscript && (
        <div
          style={{
            position: "absolute",
            left: "50%", top: rect.cy + PEEK_H / 2 + 20, transform: "translateX(-50%)",
            width: "min(600px, 86vw)", textAlign: "center", zIndex: 5, pointerEvents: "none",
            fontFamily: FONT, fontSize: 15.5, lineHeight: 1.55, fontStyle: "italic",
            color: ink(0.5),
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
            left: "50%", top: rect.cy + PEEK_H / 2 + 20, transform: "translateX(-50%)",
            width: "min(600px, 86vw)", textAlign: "center", zIndex: 5,
            pointerEvents: "none", fontFamily: FONT, fontSize: 15.5, lineHeight: 1.55,
            color: ink(0.86),
            opacity: replyShown ? 1 : 0, transition: "opacity 420ms ease",
          }}
        >
          {replyText}
        </div>
      )}

      {/* The capture hint is GONE (pass 3). `/` and hover both still work —
          only the line advertising them was removed. `savedFlash` keeps the
          slot for the one thing that genuinely needs saying: whether a ⌘↵ note
          landed. */}
      {savedFlash && (
        <div
          style={{
            position: "fixed", bottom: 20, left: 0, right: 0, textAlign: "center",
            zIndex: 1, pointerEvents: "none", fontSize: 11, letterSpacing: 0.4,
            color: ink(0.38),
          }}
        >
          {savedFlash}
        </div>
      )}

      {/* tap-to-wake veil — the one required gesture (unlocks mic + audio). */}
      {needsWake && (
        <div
          onClick={arm}
          style={{
            position: "fixed", inset: 0, zIndex: 30, cursor: "pointer",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: 14, background: "rgb(var(--gooni-surf, 11 15 13) / 0.62)", backdropFilter: "blur(2px)",
          }}
        >
          <div style={{
            width: 64, height: 64, borderRadius: "50%",
            display: "flex", alignItems: "center", justifyContent: "center",
            border: `1px solid ${frostInk.accent}`, background: frostInk.accentDim,
            color: frostInk.accent,
          }}>
            <Mic size={26} />
          </div>
          <div style={{ fontFamily: FONT, fontSize: 16, color: ink(1), letterSpacing: 0.3 }}>
            tap to wake
          </div>
          <div style={{ fontFamily: FONT, fontSize: 12.5, color: ink(0.45) }}>
            then just talk — Gooni listens + speaks back
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); disableVoice(); }}
            style={{
              marginTop: 6, padding: "4px 12px", borderRadius: 999, cursor: "pointer",
              fontFamily: FONT, fontSize: 11.5, color: ink(0.4),
              background: "transparent", border: `1px solid ${ink(0.14)}`,
            }}
          >
            type instead
          </button>
        </div>
      )}
    </div>
  );
}
