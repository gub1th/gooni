import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, StickyNote } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { FONT, frostInk } from "../../ui";
import { speakText, isVoiceMode, setVoiceMode, stopSpeaking, primeAudio } from "../../services/speech";
import { MorphLine, type MorphRect } from "./MorphLine";
import { LimboCards, MAX_CARDS } from "./LimboCards";
import { LogDots, hasLoggedToday } from "./LogDots";
import { dismissFill, isFillDismissed } from "./dailyFill";
import { NotePeek } from "./NotePeek";
import { StickyLayer, type StickyHandle } from "./StickyLayer";
import { TodayList, type SessionRow, type TodayRow } from "./TodayList";
import { useHomeChromeStore } from "../../stores/useHomeChromeStore";
import { LogSheet } from "./LogSheet";
import { CurrentActivityLine } from "./CurrentActivityLine";
import { ProactiveLine } from "./ProactiveLine";
import { CaptureEditor } from "./CaptureEditor";
import { captureState, homeInteractive, homeOpacity } from "./captureStates";
import { hasRichContent, textToParagraphs } from "../notes/quickNote";
import { ink } from "./ambientInk";
import { emptyRetained, mergeTodayRows, retainTicked } from "./todayRows";
import {
  endFocusSession,
  fetchFocusTotals,
  switchFocusSession,
  type FocusTotals,
} from "../../services/focusTime";
import { ding } from "../../services/ding";
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
  fetchGlowingMessages,
  promoteMessage,
  sendConversationMessage,
  updateFocusReminder,
  SHORT_BUCKETS,
  type ApiNote,
  type CalendarEvent,
  type FocusReminder,
  type LogMessage,
  fetchTrackables,
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
// The proactive remark, above the mirror. The pair reads as one sentence —
// what Gooni noticed, then what you're actually on — and the remark goes first
// because it's the one worth reading first. Its own fraction rather than a
// stacked sibling, for the same reason everything else here has one: a group
// that grows in flow pushes the wave off centre, and the wave is the anchor.
const OBSERVATION_Y = 0.345;
const ACTIVITY_Y = 0.40; // "currently doing" line, above the wave
const WAVE_Y = 0.47;
const TODAY_Y = 0.66;
// What the ROWS may claim before they scroll instead of growing. Without a cap
// a ten-task day walks off the bottom and takes `+ add`, `N later` and the
// capture hint with it. Reserve is: `+ add` + `N later` + the streak row + the
// hint, all of which have to stay on screen at any list length.
//
// The FLOOR is what makes it survive a resized desktop window. This is a
// fraction of the viewport minus a fixed reserve, so a short window drives it
// toward zero and then past it: at 700px tall it is 86px, at 500 it is 18 —
// TODAY, the primary content, clipped to a sliver by the same expression that
// protects it at full height. The floor holds ~3 rows, which is enough for the
// list to still be a list; the shell's own minimum window height (see
// desktop/src/main.js) keeps the two ends of this from ever meeting.
const ROWS_MIN_H = 108;
const ROWS_MAX = `max(${ROWS_MIN_H}px, calc(${(1 - TODAY_Y) * 100}vh - 152px))`;
// The stage's column width. It is centred on the viewport (the wave is the
// anchor and Momentum centres on the window), so a plain viewport fraction
// slides under the rail lane once the window is narrow enough — 84vw reaches
// x=58 at a 720px window, and the rail owns everything up to 68. Subtracting a
// fixed clearance instead keeps the same 80px gap at every width, and at the
// default window size resolves to the identical 560px.
const RAIL_CLEARANCE = 80;
const STAGE_W = `min(560px, calc(100vw - ${RAIL_CLEARANCE * 2}px))`;
// The expanded note editor. Wider and much taller than the box, but on the same
// centre — it is the box grown, not a panel summoned somewhere else.
const EDITOR_MAX_W = 720;
const EDITOR_MAX_H = 560;
// Never let the grown box run under the sticky header or off the bottom. It is
// centred on the wave (which sits at 47% of the viewport), so the room above is
// the smaller half and decides the height.
const EDITOR_MARGIN_TOP = 76;
const EDITOR_MARGIN_BOTTOM = 40;
const EDITOR_MIN_H = 260;
// The subtitle + live transcript run wider than the stage on purpose; they get
// the same clearance rule for the same reason.
const SUBTITLE_W = `min(600px, calc(100vw - ${RAIL_CLEARANCE * 2}px))`;


// Evaluated at MODULE scope, once per page load. It cannot go in a useState
// initializer: this check consumes the day's one showing as a side effect, and
// StrictMode double-invokes initializers in dev — the second call would find
// the key already written and answer false, so the phrase never appeared.

function isGlowing(m: LogMessage): boolean {
  return Boolean(m.has_actionable_signal) && (m.signal_preview?.status ?? "pending") === "pending";
}

function energyFor(count: number): number {
  return Math.min(1, 0.14 + Math.min(count, MAX_CARDS) * 0.28);
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
  covered: coveredBySurface = false,
}: {
  /** a surface panel is sliding over the home — stand every affordance down */
  covered?: boolean;
} = {}) {
  const energyRef = useRef(0);
  const activeRef = useRef(0);

  const [vp, setVp] = useState({ w: 1200, h: 800 });
  const [limbo, setLimbo] = useState<LogMessage[]>([]);
  const [limboTotal, setLimboTotal] = useState(0);
  const [boxMode, setBoxMode] = useState(false);
  const [logSheet, setLogSheet] = useState(false);
  // The daily fill, offered in TODAY until it is put away for the day. The
  // matrix (the RECORD) is a different door — the rail's — and the two share one
  // component, so the fill writes entries and the matrix reads them with no
  // second copy of the day's state.
  const [fillOpen, setFillOpen] = useState(false);
  const [fillDismissed, setFillDismissed] = useState(isFillDismissed);
  // Has anything been logged today — the daily-fill row reads done at a glance.
  // One request (`/trackables?today=1`), refreshed when the fill closes, which
  // is the only moment the answer can have changed from this surface.
  const [loggedToday, setLoggedToday] = useState(false);
  const refreshLogged = useCallback(() => {
    fetchTrackables(true).then((all) => setLoggedToday(hasLoggedToday(all))).catch(() => {});
  }, []);
  useEffect(() => { refreshLogged(); }, [refreshLogged]);
  const [value, setValue] = useState("");
  // The box's other size. `editorMounted` latches on first open and never
  // clears: TipTap is too heavy to mount on the home's first paint, and once it
  // exists, keeping it is what makes a collapse non-destructive — the draft is
  // still in the editor when you come back to it.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMounted, setEditorMounted] = useState(false);
  const [editorSeed, setEditorSeed] = useState("");
  const [editorHasDraft, setEditorHasDraft] = useState(false);
  const editorRef = useRef<Editor | null>(null);
  const [boxH, setBoxH] = useState(PEEK_H);
  const [thinking, setThinking] = useState(false);
  const [replyText, setReplyText] = useState<string | null>(null);
  const [replyShown, setReplyShown] = useState(false);
  const [peekNote, setPeekNote] = useState<ApiNote | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const stickyRef = useRef<StickyHandle>(null);
  const focusedRef = useRef(false);
  const boxModeRef = useRef(false);
  // Read by the hover handlers, which are plain functions closing over a stale
  // render — the same reason `boxModeRef` exists.
  const editorOpenRef = useRef(false);
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
  // ATTACHED means the session is holding the wave's slot. Detached, it lives
  // in the band and the wave comes back — the session runs either way.
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

  boxModeRef.current = boxMode;

  const cx = vp.w / 2;
  const cy = vp.h * WAVE_Y;
  const boxW = Math.min(WAVE_WIDTH + 40, vp.w * 0.9);
  const editorW = Math.min(EDITOR_MAX_W, Math.max(320, vp.w - RAIL_CLEARANCE * 2));
  // Symmetric about the wave's centre, so growing the box never shifts it. The
  // room above the centre is the binding constraint at every window size.
  const editorH = Math.max(
    EDITOR_MIN_H,
    Math.min(
      EDITOR_MAX_H,
      2 * Math.min(cy - EDITOR_MARGIN_TOP, vp.h - EDITOR_MARGIN_BOTTOM - cy),
    ),
  );
  // ONE rect drives the stroke: the box's while capturing, the editor's once it
  // expands. MorphLine eases both dimensions toward it, so the line grows into
  // the editor's outline rather than the editor arriving over a stale box.
  const rect: MorphRect = editorOpen
    ? { cx, cy, w: editorW, h: editorH, r: 22 }
    : { cx, cy, w: boxW, h: boxH, r: 20 };
  const waveW = Math.min(WAVE_WIDTH, boxW - 40); // wave sits just inside the box

  const reload = useCallback(async () => {
    try {
      // Pendingness, not recency: this used to scrape the newest 40 log rows
      // and filter them here, so a pending glow that fell past the tail of a
      // busy day's chatter vanished from the home for good — never promoted,
      // never dismissed. The server now answers the actual question; the
      // client-side `isGlowing` stays as the belt-and-braces check.
      const { items, total } = await fetchGlowingMessages({ limit: 50 });
      const glowing = items.filter(isGlowing);
      setLimbo(glowing);
      setLimboTotal(Math.max(total, glowing.length));
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

  // Stable by contract: NoteEditor re-runs its hand-up effect whenever this
  // identity changes, and an inline arrow would hand the editor over on every
  // render of the home — which polls twice a minute.
  const onEditorReady = useCallback((ed: Editor | null) => {
    editorRef.current = ed;
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
      events,
      logOpen: logSheet,
      toggleVoice: toggleVoiceMode,
      toggleLog: () => setLogSheet((o) => !o),
      openNote,
    });
  }, [publishChrome, voiceMode, listening, events, logSheet, toggleVoiceMode, openNote]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      // `isContentEditable` is not optional here: the note editor is a
      // contenteditable div, so an input/textarea-only check let this swallow
      // every "/" typed into it — the slash MENU could never open, and the key
      // re-summoned the capture box instead.
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (e.key === "/" && !typing && !editorOpenRef.current) {
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
    if (editorOpenRef.current) return;
    clearHideTimer();
    clearEnterTimer();
    enterTimer.current = window.setTimeout(() => {
      setBoxMode(true);
      activeRef.current = 1;
    }, 160);
  }

  function onHeroLeave() {
    clearEnterTimer();
    // The editor lives OUTSIDE the hero rect, so reaching into it fires the
    // box's leave. Nothing about hover may close a surface you are writing in.
    if (editorOpenRef.current) return;
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

  // ── the box's second size ──────────────────────────────────────────────────
  //
  // ONE composer in two sizes, so exactly one of them holds the draft at a time.
  // Expanding hands the box's text to the editor and empties the box; collapsing
  // mirrors the editor's text back. The rule that keeps them from disagreeing:
  // the box's text WINS whenever it differs from the editor's, because it is the
  // one you were last typing into. That is also what stops a stale rich draft
  // resurrecting over something you typed after collapsing.
  function openEditor() {
    clearHideTimer();
    clearEnterTimer();
    const seed = textToParagraphs(value);
    const ed = editorRef.current;
    if (ed) {
      if (value.trim() && value.trim() !== ed.getText().trim()) {
        ed.commands.setContent(seed);
      }
    } else {
      // First open — the editor mounts with this as its document.
      setEditorSeed(seed);
      setEditorMounted(true);
    }
    setValue("");
    setBoxMode(true);
    setEditorOpen(true);
    editorOpenRef.current = true;
    activeRef.current = 1;
    inputRef.current?.blur();
    // Two frames: the editor may be mounting this tick, and TipTap needs its
    // view in the document before focus lands anywhere.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      editorRef.current?.commands.focus("end");
    }));
  }

  // Escape (or a click on the void). NEVER destructive: the editor stays mounted
  // holding whatever was written, and its plain text comes back into the box so
  // the thought is still ON SCREEN rather than filed away behind a pill.
  function collapseEditor({ focusBox = true }: { focusBox?: boolean } = {}) {
    const ed = editorRef.current;
    const text = ed ? ed.getText().trim() : "";
    setEditorOpen(false);
    editorOpenRef.current = false;
    // The pill only claims a draft when the collapse was LOSSY — a heading, a
    // list, an image. Plain prose comes back into the box intact, so flagging
    // it there too would be a badge on something already on screen.
    setEditorHasDraft(!!text && !!ed && hasRichContent(ed.getHTML()));
    if (!text) {
      closeBox();
      idleActive();
      return;
    }
    setValue(ed?.getText() ?? "");
    setBoxMode(true);
    // NOT when a surface caused the collapse: the box is behind that panel, and
    // focusing it there is the same theft this collapse exists to prevent, just
    // pointing the other way.
    if (focusBox) requestAnimationFrame(() => inputRef.current?.focus());
  }

  function onEditorSubmitted(note: ApiNote | null) {
    setEditorOpen(false);
    editorOpenRef.current = false;
    setEditorHasDraft(false);
    closeBox();
    idleActive();
    flash(note ? "saved as a note" : "couldn't save that note");
  }

  // The box just consumed its text, and after a collapse that text IS the
  // editor's draft mirrored back. Leaving it behind would keep the pill
  // advertising a draft that has already been sent, and reopening would show
  // it again as if it were unsaved.
  function clearEditorDraft() {
    editorRef.current?.commands.clearContent();
    setEditorHasDraft(false);
  }

  // Typed capture (voice off, or optional typing while voice on) — silent reply.
  function capture() {
    const text = value.trim();
    if (!text) return;
    closeBox();
    clearEditorDraft();
    void runTurn(text, false);
  }

  // ⌘/Ctrl+Enter — the same box, the other exit. First line becomes the title,
  // the rest the body: the shape a quick capture takes everywhere else in Gooni.
  async function captureAsNote() {
    const text = value.trim();
    if (!text) return;
    closeBox();
    clearEditorDraft();
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

  function dropFromLimbo(id: number) {
    setLimbo((prev) => prev.filter((x) => x.id !== id));
    setLimboTotal((t) => Math.max(0, t - 1));
  }

  async function onPromote(m: LogMessage) {
    dropFromLimbo(m.id);
    try { await promoteMessage(m.id); } finally { void reload(); void loadCommitments(); }
  }
  async function onDismiss(m: LogMessage) {
    dropFromLimbo(m.id);
    try { await dismissMessageGlow(m.id); } finally { void reload(); }
  }

  // ── the list's three writes ────────────────────────────────────────────────

  // Ticking is OPTIMISTIC and in place: the row must not jump out from under
  // the pointer, and it must not wait on a round trip to show it registered.
  async function onTick(item: FocusReminder) {
    const next = item.state === "kept" ? "active" : "kept";
    const updated: FocusReminder = { ...item, state: next, done: next === "kept" };
    const undoRetention = retainTicked(retained.current, updated);
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
      return;
    } finally {
      void loadCommitments();
    }
    // TICKING A RUNNING TASK ALSO ENDS ITS SESSION (pass 9) — one gesture,
    // finished and stopped. Written as a normal session end, so the entry and
    // its attribution are identical to pressing stop.
    //
    // Only AFTER the completion write landed: ending is the irreversible half
    // (it writes the trackable entry and drops the session), and doing it first
    // would mean a failed tick left the work stopped but the task open, with no
    // running session left to try again from.
    if (onRunningTask && next === "kept") {
      try {
        await endFocusSession();
        void loadTotals();
        ding();
      } catch {
        // endFocusSession leaves the session PAUSED and retryable on a failed
        // write rather than destroying it — say so, and leave it be.
        flash("couldn't save that session — it's paused, not lost");
      }
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
  const covered = coveredBySurface || fillOpen || !!peekNote || needsWake;

  // A surface panel (notes, memories, the log matrix, a note peek) taking the
  // screen has to fold the composer with it. Not cosmetic: the editor keeps
  // FOCUS, so an unfolded one sits invisible behind an opaque panel eating every
  // keystroke meant for the surface on top. Collapsing is the right verb rather
  // than closing — it is non-destructive, so the draft is waiting when you come
  // back to the home.
  useEffect(() => {
    if (covered && editorOpenRef.current) collapseEditor({ focusBox: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [covered]);

  // Capturing DIMS the home, it no longer deletes it. The ladder (and the reason
  // a covering surface is the only zero) lives in captureStates.ts.
  const captureMode = captureState({ boxOpen: boxMode, editorOpen });
  const stageOpacity = homeOpacity(captureMode, covered);
  const stageLive = homeInteractive(captureMode, covered);

  function onRootDoubleClick(e: React.MouseEvent) {
    if (boxMode || editorOpen || covered || logSheet) return;
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
        // The editor is the box at another size, so the stroke stays a rect for
        // it — it eases out to the bigger outline instead of snapping back to a
        // wave under a panel.
        boxMode={boxMode || editorOpen}
        rect={rect}
        thinking={thinking}
        dimmed={fillOpen}
        waveWidth={waveW}
        // THE WAVE STAYS A WAVE (pass 9). It used to be REPLACED by the running
        // session, which meant the notch, the task row and the wave were three
        // timers showing the same number. Now it only glows the focus hue, and
        // that glow is the entire focus indication in this slot.
        focus={hasSession}
        energyRef={energyRef}
        activeRef={activeRef}
      />

      {/* Both take the same dim as the stage: they are home furniture, and a
          sticky note at full brightness beside a dimmed TODAY would read as the
          one thing being pointed at. */}
      <StickyLayer
        ref={stickyRef}
        vp={vp}
        center={{ cx: rect.cx, cy: rect.cy, w: boxW }}
        hidden={covered || logSheet}
        dim={stageOpacity}
        inert={!stageLive}
      />

      {/* Home furniture, same as the stickies: a pending-commitment card has
          nothing to do with notes/memories/calendar/the log sheet, and the
          panel slides in over a home that stays mounted. */}
      {!covered && !logSheet && (
        <LimboCards
          items={limbo}
          total={limboTotal}
          onPromote={onPromote}
          onDismiss={onDismiss}
          dim={stageOpacity}
        />
      )}


      {/* hero zone = the wave's bounding rectangle. Box the wave morphs into +
          the hover target. Focusing it PAUSES the mic (so voice doesn't hear you
          type); blurring resumes listening. */}
      <div
        onMouseEnter={onHeroEnter}
        onMouseLeave={onHeroLeave}
        style={{
          position: "absolute",
          // The hero stays the INPUT's rect even while the editor is open — the
          // editor is its own element, so the box's height sync and the panel's
          // grow animation never fight over the same node.
          left: cx - boxW / 2,
          top: cy - boxH / 2,
          width: boxW,
          height: boxH,
          zIndex: 2,
          // Nothing to hover while the editor has the centre.
          pointerEvents: editorOpen ? "none" : "auto",
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
            borderRadius: 20, color: "rgb(var(--gooni-ink, 244 245 244))", caretColor: frostInk.accent,
            background: boxMode ? "color-mix(in srgb, rgb(var(--gooni-surf, 11 15 13)) 52%, transparent)" : "transparent",
            backdropFilter: boxMode ? "blur(16px)" : "none",
            WebkitBackdropFilter: boxMode ? "blur(16px)" : "none",
            // Hands the centre over during the morph: the box fades out as the
            // editor fades in, which is also what hides the two frost tints
            // differing.
            opacity: boxMode && !editorOpen ? 1 : 0,
            pointerEvents: boxMode && !editorOpen ? "auto" : "none",
            transition: "opacity 200ms ease, background 220ms ease",
          }}
        />
        {/* The box's other door. It used to be the `⌘↵ note` HINT — a label for
            a shortcut, which is the least useful thing a corner can hold: it
            told you about the fast path and offered nothing to anyone who
            wanted room to write. The shortcut is unchanged (⌘↵ in the box still
            writes the note straight off), and the pill now buys the editor. */}
        {boxMode && !editorOpen && (
          <button
            onClick={openEditor}
            title={editorHasDraft
              ? "Back to the note editor — it still holds formatting the box can't show"
              : "Open the note editor — ⌘↵ saves straight away"}
            aria-label="Open the note editor"
            aria-expanded={editorOpen}
            style={{
              position: "absolute", right: 12, bottom: 10, zIndex: 1,
              display: "inline-flex", alignItems: "center", gap: 5,
              borderRadius: 999, cursor: "pointer",
              border: `1px solid ${editorHasDraft ? frostInk.accent : ink(0.14)}`,
              // A pill, not a chip: it is the only control ON the box, and the
              // box is not the centre's anchor — the wave is. Tint only, no
              // fill, no shadow.
              background: editorHasDraft ? "transparent" : ink(0.05),
              padding: "3px 9px",
              fontFamily: FONT, fontSize: 10.5, letterSpacing: 0.2,
              color: editorHasDraft ? frostInk.accent : ink(0.42),
              transition: "color 160ms ease, border-color 160ms ease, background 160ms ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = frostInk.accent; }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = editorHasDraft ? frostInk.accent : ink(0.42);
            }}
          >
            <StickyNote size={11} strokeWidth={1.8} />
            {editorHasDraft ? "note · draft" : "note"}
          </button>
        )}
      </div>

      {/* The box at its other size. Outside the hero on purpose — see its own
          file for why it is one object with the box rather than a summoned panel. */}
      <CaptureEditor
        open={editorOpen}
        mounted={editorMounted}
        left={cx - (editorOpen ? editorW : boxW) / 2}
        top={cy - (editorOpen ? editorH : boxH) / 2}
        width={editorOpen ? editorW : boxW}
        height={editorOpen ? editorH : boxH}
        radius={editorOpen ? 22 : 20}
        initialContent={editorSeed}
        onReady={onEditorReady}
        onEscape={collapseEditor}
        onSubmitted={onEditorSubmitted}
      />

      {/* ── the stage: line · TODAY · streaks, each pinned to its own % ─────── */}
      <div
        style={{
          // pointerEvents NONE on the full-bleed layer, auto on the children
          // that need it. The stage spans inset:0, so a hit-testable one
          // swallowed the mouseenter that summons the capture box — hovering
          // the wave did nothing at all.
          //
          // UNDER the capture box (z1, not z3) since the box stopped hiding it:
          // a dimmed-but-present TODAY at z3 painted straight THROUGH the box
          // and the note editor, which is text over text on the one surface
          // that exists to be written in.
          position: "absolute", inset: 0, zIndex: 1, pointerEvents: "none",
          opacity: stageOpacity, transition: "opacity 260ms ease",
        }}
      >
        {/* Inside the stage, so it inherits the two rules every ambient
            affordance needs: it dims with the stage while a surface covers
            the home or the capture box is open, and it is
            pointer-transparent until it has something to be clicked. */}
        <div
          style={{
            position: "absolute", top: `${OBSERVATION_Y * 100}%`, left: "50%", transform: "translate(-50%, -50%)",
            width: SUBTITLE_W,
            pointerEvents: stageLive ? "auto" : "none",
          }}
        >
          <ProactiveLine />
        </div>

        <div
          style={{
            position: "absolute", top: `${ACTIVITY_Y * 100}%`, left: "50%", transform: "translate(-50%, -50%)",
            width: STAGE_W,
            // the line wears a pill now, so it is an INLINE element that has to
            // be centred by its slot — it can no longer centre itself by being
            // a full-width block with centred text
            display: "flex", justifyContent: "center",
          }}
        >
          <CurrentActivityLine />
        </div>

        <div
          style={{
            position: "absolute", top: `${TODAY_Y * 100}%`, left: "50%", transform: "translateX(-50%)",
            width: STAGE_W,
            pointerEvents: stageLive ? "auto" : "none",
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
            fill={
              fillDismissed
                ? null
                : {
                    onOpen: () => setFillOpen(true),
                    onDismiss: () => { dismissFill(); setFillDismissed(true); },
                    logged: loggedToday,
                  }
            }
          />
        </div>
      </div>

      {/* the RECORD is now its own route view (`?trackables=1`, the Trackables
          tab) — see routes/index.tsx — so the home no longer renders it. */}
      {/* the daily FILL — opened from its row in TODAY */}
      {fillOpen && (
        <LogDots mode="fill" onClose={() => { setFillOpen(false); refreshLogged(); }} />
      )}


      {peekNote && <NotePeek note={peekNote} onClose={() => setPeekNote(null)} />}

      <LogSheet open={logSheet && !covered} onClose={() => setLogSheet(false)} events={events} />

      {/* live transcript — what the mic is hearing right now (ephemeral) */}
      {liveTranscript && (
        <div
          style={{
            position: "absolute",
            left: "50%", top: rect.cy + PEEK_H / 2 + 20, transform: "translateX(-50%)",
            width: SUBTITLE_W, textAlign: "center", zIndex: 5, pointerEvents: "none",
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
            width: SUBTITLE_W, textAlign: "center", zIndex: 5,
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
