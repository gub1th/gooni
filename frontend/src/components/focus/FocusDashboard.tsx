import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Maximize2, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { FONT } from "../../ui";
import {
  createFocusReminder,
  createNote,
  deleteFocusReminder,
  fetchCalendarEvents,
  fetchFocusDashboard,
  fetchLeetcodeToday,
  fetchTrackableDays,
  fetchTrackables,
  fetchWhoopToday,
  updateFocusReminder,
  SHORT_BUCKETS,
  type CalendarEvent,
  type FocusDashboard as FocusDashboardData,
  type FocusReminder,
  type FocusRollup,
  type LeetcodeToday,
  type ShortBucket,
  type Trackable,
  type TrackableDay,
  type WhoopToday,
} from "../../services/api";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { useWidgetOverlayStore } from "../../stores/useWidgetOverlayStore";
import { LogTable } from "../ambient/LogTable";
import { FOCUS_PALETTES, type FocusPalette } from "./focusPalette";
import { FocusRunner } from "./FocusRunner";
import { fmtPromiseMeta, fmtTime, fmtWeekday } from "./notchMerge";

// The dashboard (whiteboard, 2026-07-28). What replaced the arcs canvas.
//
// The old centre was a chronological stream of every event — the thing Daniel
// called "all this data": a log you have to read and total in your head. Nothing
// here renders a raw event row. Device telemetry arrives pre-aggregated
// (`instagram open · 12`), which is the analysis, done deterministically by the
// backend rather than narrated by a model.
//
// Two columns, matching the sketch:
//   LEFT   short-term promises — the actionable now, bucketed by due day, each
//          row startable as a focus session.
//   RIGHT  trackables · longer-term promises · today's roll-ups · feeds
// Above both, the notes chips: capture first, browse second.
//
// Poll to stay live; the display IS the proactivity.

const REFRESH_MS = 25_000;
const STREAK_TRAIL = 5; // trailing days shown per streak column
const STREAK_PER_PAGE = 4; // columns visible before the ‹ › pager

// The board is capped and centred rather than filling the monitor.
//
// The failure it fixes is a sparse one, not a spacing one: this layout was
// tuned for a full board, and the normal state is one overdue promise and three
// longer-term ones. Stretched edge-to-edge on a wide monitor that reads as a
// page that failed to load — a 1500px column holding a 185px sentence, with the
// whole right third structurally unreachable. Symmetric margin around a slab
// reads as deliberate; the same emptiness pushed into the corners doesn't.
//
// `92vw` keeps it honest on a laptop, where capping would just add margin to a
// board that already fits.
const BOARD_MAX = "min(1440px, 92vw)";

// Human labels for the backend's bucket keys.
const BUCKET_LABEL: Record<ShortBucket, string> = {
  overdue: "overdue",
  today: "today",
  tomorrow: "tomorrow",
  this_week: "this week",
};

interface StreakCol {
  t: Trackable;
  days: TrackableDay[]; // newest-first, gap-filled; days[0] = today
}

// Mirror LogDots.isDaily: the daily-glance set — boolean habits + key numbers,
// minus the json feeds (whoop/leetcode), device telemetry (shortcuts),
// walled-off focus-cam, and the freeform "note".
function isStreak(t: Trackable): boolean {
  if (t.kind === "json") return false;
  if (t.source === "whoop" || t.source === "leetcode") return false;
  if (t.source === "shortcuts" || t.source === "focus_cam") return false;
  if (t.name === "note") return false;
  return true;
}

function todayWindowISO(): { startISO: string; endISO: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

export function FocusDashboard() {
  const theme = useGooniThemeStore((s) => s.theme);
  const pal = FOCUS_PALETTES[theme];
  const openWidget = useWidgetOverlayStore((s) => s.open);

  const [data, setData] = useState<FocusDashboardData | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [streaks, setStreaks] = useState<StreakCol[]>([]);
  const [whoop, setWhoop] = useState<WhoopToday | null>(null);
  const [lc, setLc] = useState<LeetcodeToday | null>(null);
  const [matrixOpen, setMatrixOpen] = useState(false);
  // The promise a focus session is running for. Owned HERE rather than by the
  // kiosk shell so `/` (a plain browser tab, no state machine) can focus too.
  const [focusTarget, setFocusTarget] = useState<FocusReminder | null>(null);
  const streakDefsRef = useRef<Trackable[] | null>(null);

  const loadStreaks = useCallback(async () => {
    try {
      if (!streakDefsRef.current) {
        const all = (await fetchTrackables()).filter(isStreak);
        all.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "boolean" ? -1 : 1;
          if (a.is_important !== b.is_important) return a.is_important ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        streakDefsRef.current = all;
      }
      const defs = streakDefsRef.current;
      const cols = await Promise.all(
        defs.map(async (t) => ({ t, days: (await fetchTrackableDays(t.id, 1 + STREAK_TRAIL)).days })),
      );
      setStreaks(cols);
    } catch {
      /* panel stays quiet on error */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      setData(await fetchFocusDashboard());
    } catch {
      /* keep the last good frame */
    }
    try {
      const { startISO, endISO } = todayWindowISO();
      setEvents(await fetchCalendarEvents(startISO, endISO));
    } catch {
      setEvents([]); // 401 / not connected → Gooni items only, never an error
    }
    void fetchWhoopToday().then(setWhoop).catch(() => setWhoop(null));
    void fetchLeetcodeToday().then(setLc).catch(() => setLc(null));
    void loadStreaks();
  }, [loadStreaks]);

  // Lighter than load(): a mutation (add/edit/delete) only needs the dashboard
  // payload refreshed, not the calendar / whoop / streak fan-out.
  const reloadDashboard = useCallback(async () => {
    try {
      setData(await fetchFocusDashboard());
    } catch {
      /* keep the last good frame */
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  // Full-bleed kiosk — own the page ground (theme-aware) while mounted.
  useEffect(() => {
    const prev = {
      bg: document.body.style.background,
      margin: document.body.style.margin,
      overflow: document.body.style.overflow,
    };
    document.body.style.background = pal.paper;
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.background = prev.bg;
      document.body.style.margin = prev.margin;
      document.body.style.overflow = prev.overflow;
    };
  }, [pal.paper]);

  const shortTerm = data?.short_term;
  const longTerm = data?.long_term ?? [];
  const rollups = data?.rollups ?? [];
  const sortedEvents = useMemo(
    () => [...events].sort((a, b) => (a.start || "").localeCompare(b.start || "")),
    [events],
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: pal.paper,
        color: pal.ink,
        fontFamily: FONT,
        fontSize: 12,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      {/* The capped board — chips ride inside it so they share the columns'
          left edge. */}
      <div
        style={{
          width: "100%",
          maxWidth: BOARD_MAX,
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          // Float the WHOLE board — chips included. Centring only the grid
          // strands the chips against the top bezel with a dead gap beneath
          // them, which looks more broken than the corner-jam it replaced.
          //
          // `safe` is load-bearing, not decoration. Plain `center` on a
          // scrolling box pushes the first rows ABOVE the scroll origin once
          // content outgrows the viewport, where no scrollbar can reach them.
          // `safe` falls back to `start` exactly then — so a full board
          // top-anchors and scrolls normally, and only a sparse one centres.
          justifyContent: "safe center",
        }}
      >
        <NoteChips pal={pal} />

        <div
          style={{
            // Sized by content so the board above can float it, but free to
            // shrink (and scroll) the moment content outgrows the screen.
            flex: "0 1 auto",
            minHeight: 0,
            display: "grid",
            // Equal halves. The old 1.45fr gave the MOST width to short-term on
            // the grounds that it's the column you act on — true, but a promise
            // is one line of text. It earns vertical room, not horizontal, and
            // the narrow half was carrying five stacked panels against the wide
            // half's one list. Equal also survives the busy case, which a split
            // tuned for either extreme does not.
            gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
            // Columns share a top edge rather than stretching to match the
            // taller one — the two section labels must sit on the same line.
            alignItems: "start",
            gap: 34,
            padding: "10px 34px 30px",
            // The board scrolls as one. Two independent scrollers on a glance
            // surface means the wheel does different things depending on which
            // half the pointer happens to be over.
            overflowY: "auto",
          }}
        >
          <ShortTermPanel
            buckets={shortTerm}
            pal={pal}
            onMutate={reloadDashboard}
            onFocus={setFocusTarget}
          />

          <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
            <Panel label="trackables" pal={pal} onExpand={() => setMatrixOpen(true)}>
              <StreakStrip cols={streaks} pal={pal} />
            </Panel>

            <LongTermPanel promises={longTerm} pal={pal} onMutate={reloadDashboard} />

            {sortedEvents.length > 0 && (
              <Panel label="schedule" pal={pal} onExpand={() => openWidget("calendar", "agenda")}>
                {sortedEvents.map((e) => (
                  <Row
                    key={`e${e.id}`}
                    title={e.summary || "(untitled)"}
                    meta={e.all_day ? fmtWeekday(e.start) : fmtTime(e.start)}
                    pal={pal}
                  />
                ))}
              </Panel>
            )}

            <RollupPanel rollups={rollups} pal={pal} />

            <FeedLine whoop={whoop} lc={lc} pal={pal} />
          </div>
        </div>
      </div>

      {/* the full editable log, "as the main page does" */}
      {matrixOpen && <MatrixOverlay onClose={() => setMatrixOpen(false)} />}

      {focusTarget && (
        <FocusRunner
          target={focusTarget}
          pal={pal}
          onClose={() => {
            setFocusTarget(null);
            void reloadDashboard();
          }}
        />
      )}
    </div>
  );
}

// ── notes chips ───────────────────────────────────────────────────────────────
// The whiteboard's two chips. `new` is the CAPTURE path — the ambient home's
// wave (the only other way to write from a screen) is going away, and a
// notebook you can't write to is just a report. `all` hands off to the notes
// browser.

function NoteChips({ pal }: { pal: FocusPalette }) {
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function submit() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      // First line becomes the title, the rest the body — the same shape a
      // quick capture takes everywhere else in Gooni.
      const [first, ...rest] = body.split("\n");
      await createNote("general", { title: first.slice(0, 120), content: rest.join("\n") });
      setText("");
      setComposing(false);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2200);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: "22px 34px 4px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Chip pal={pal} active={composing} onClick={() => setComposing((c) => !c)}>
          <Plus size={12} strokeWidth={2.2} />
          new note
        </Chip>
        <Chip pal={pal} onClick={() => { window.location.href = "/?view=notes"; }}>
          all notes
        </Chip>
        {saved && (
          <span style={{ fontSize: 10.5, color: pal.accent, letterSpacing: "0.04em" }}>saved</span>
        )}
      </div>

      {composing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 620 }}>
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter commits, shift+Enter newlines — capture should cost one key.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              } else if (e.key === "Escape") {
                setComposing(false);
              }
            }}
            rows={3}
            placeholder="what's on your mind"
            style={{ ...fieldStyle(pal), resize: "vertical", lineHeight: 1.5 }}
          />
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <PrimaryBtn pal={pal} disabled={busy || !text.trim()} onClick={() => void submit()}>
              save
            </PrimaryBtn>
            <GhostBtn pal={pal} onClick={() => setComposing(false)}>
              cancel
            </GhostBtn>
            <span style={{ fontSize: 10, color: pal.ink3 }}>enter saves · shift+enter newline</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({
  children,
  pal,
  active,
  onClick,
}: {
  children: React.ReactNode;
  pal: FocusPalette;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontFamily: FONT,
        fontSize: 11.5,
        padding: "5px 12px",
        borderRadius: 999,
        cursor: "pointer",
        border: `1px solid ${active ? pal.accent : pal.rule}`,
        background: "transparent",
        color: active ? pal.accent : pal.ink2,
      }}
    >
      {children}
    </button>
  );
}

// ── panels ────────────────────────────────────────────────────────────────────

function SectionLabel({
  children,
  pal,
  onExpand,
  onAdd,
  addActive,
}: {
  children: React.ReactNode;
  pal: FocusPalette;
  onExpand?: () => void;
  onAdd?: () => void;
  addActive?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 10,
        color: pal.ink3,
        fontSize: 10.5,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}
    >
      <span>{children}</span>
      <div style={{ display: "flex", gap: 2 }}>
        {onAdd && (
          <IconBtn pal={pal} label={addActive ? "Cancel" : "Add"} onClick={onAdd}>
            {addActive ? <X size={12} strokeWidth={2} /> : <Plus size={13} strokeWidth={2} />}
          </IconBtn>
        )}
        {onExpand && (
          <IconBtn pal={pal} label="Expand" onClick={onExpand}>
            <Maximize2 size={12} strokeWidth={2} />
          </IconBtn>
        )}
      </div>
    </div>
  );
}

// Small square ghost button — the shared control (add / expand / edit / delete /
// confirm). Brightens ink3 → ink (or warn when `danger`) on hover.
function IconBtn({
  children,
  pal,
  label,
  onClick,
  danger,
  disabled,
}: {
  children: React.ReactNode;
  pal: FocusPalette;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  const base = danger ? pal.warn : pal.ink3;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{
        width: 20,
        height: 20,
        borderRadius: 6,
        border: "none",
        background: "transparent",
        cursor: disabled ? "default" : "pointer",
        color: base,
        opacity: disabled ? 0.4 : 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        flexShrink: 0,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = danger ? pal.warn : pal.ink)}
      onMouseLeave={(e) => (e.currentTarget.style.color = base)}
    >
      {children}
    </button>
  );
}

function Panel({
  label,
  pal,
  onExpand,
  onAdd,
  addActive,
  children,
}: {
  label: string;
  pal: FocusPalette;
  onExpand?: () => void;
  onAdd?: () => void;
  addActive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <SectionLabel pal={pal} onExpand={onExpand} onAdd={onAdd} addActive={addActive}>
        {label}
      </SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>{children}</div>
    </div>
  );
}

// A line: title takes the FULL width and wraps to two lines; the time / meta
// rides UNDERNEATH as small print. No right-hand column, so nothing gets
// clipped mid-word.
function Row({
  title,
  meta,
  pal,
  tone = "normal",
  metaWarn = false,
}: {
  title: string;
  meta?: string;
  pal: FocusPalette;
  tone?: "normal" | "warn";
  metaWarn?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span
        style={{
          fontSize: 12.5,
          lineHeight: 1.35,
          color: tone === "warn" ? pal.warn : pal.ink,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {title}
      </span>
      {meta && (
        <span
          style={{
            fontSize: 11,
            color: metaWarn ? pal.warn : pal.ink3,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {meta}
        </span>
      )}
    </div>
  );
}

// ── short-term panel ──────────────────────────────────────────────────────────
// "Short-term things. Promises that are more to-do based ± can do them soon and
// 'focus' on them." Bucketed by due day, most urgent first. Empty buckets don't
// render — a panel of empty headers is noise.

function ShortTermPanel({
  buckets,
  pal,
  onMutate,
  onFocus,
}: {
  buckets: Record<ShortBucket, FocusReminder[]> | undefined;
  pal: FocusPalette;
  onMutate: () => void;
  onFocus: (r: FocusReminder) => void;
}) {
  const [adding, setAdding] = useState(false);
  const total = buckets ? Object.values(buckets).reduce((n, rows) => n + rows.length, 0) : 0;

  return (
    // Sizes to its content — the board above owns the scrolling now.
    <div style={{ display: "flex", flexDirection: "column" }}>
      <SectionLabel pal={pal} onAdd={() => setAdding((a) => !a)} addActive={adding}>
        short term
      </SectionLabel>

      {adding && (
        <div style={{ marginBottom: 16 }}>
          <Editor
            kind="reminder"
            pal={pal}
            submitLabel="add"
            onCancel={() => setAdding(false)}
            onSubmit={async ({ content, secondary }) => {
              await createFocusReminder({ content, due_hint: secondary || null });
              setAdding(false);
              onMutate();
            }}
          />
        </div>
      )}

      {total === 0 && !adding && <EmptyHint pal={pal}>nothing due — add something</EmptyHint>}

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {SHORT_BUCKETS.map((b) => {
          const rows = buckets?.[b] ?? [];
          if (rows.length === 0) return null;
          return (
            <div key={b}>
              <div
                style={{
                  fontSize: 10,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: b === "overdue" ? pal.warn : pal.ink2,
                  marginBottom: 9,
                }}
              >
                {BUCKET_LABEL[b]}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
                {rows.map((r) => (
                  <Item
                    key={`${r.type}${r.id}`}
                    item={r}
                    kind={r.type}
                    pal={pal}
                    overdue={b === "overdue"}
                    onMutate={onMutate}
                    onFocus={() => onFocus(r)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── longer-term panel ─────────────────────────────────────────────────────────

function LongTermPanel({
  promises,
  pal,
  onMutate,
}: {
  promises: FocusReminder[];
  pal: FocusPalette;
  onMutate: () => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <Panel label="longer term" pal={pal} onAdd={() => setAdding((a) => !a)} addActive={adding}>
      {adding && (
        <Editor
          kind="promise"
          pal={pal}
          submitLabel="add"
          onCancel={() => setAdding(false)}
          onSubmit={async ({ content, secondary }) => {
            await createFocusReminder({
              content,
              is_promise: true,
              // No hint → today EOD, which is short-term. A longer-term item
              // needs a real horizon, so default it out a month.
              due_hint: secondary || "in 1 month",
            });
            setAdding(false);
            onMutate();
          }}
        />
      )}
      {promises.map((p) => (
        <Item key={`l${p.id}`} item={p} kind={p.type} pal={pal} onMutate={onMutate} />
      ))}
      {promises.length === 0 && !adding && <EmptyHint pal={pal}>none</EmptyHint>}
    </Panel>
  );
}

// ── roll-ups ──────────────────────────────────────────────────────────────────
// The replacement for the event stream. Counts, not rows.

function RollupPanel({ rollups, pal }: { rollups: FocusRollup[]; pal: FocusPalette }) {
  if (rollups.length === 0) return null;
  return (
    <Panel label="today" pal={pal}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "7px 16px" }}>
        {rollups.map((r) => (
          <span
            key={r.label}
            style={{ fontSize: 11.5, color: pal.ink2, fontVariantNumeric: "tabular-nums" }}
          >
            {r.label} <span style={{ color: pal.ink, fontWeight: 600 }}>{r.count}</span>
          </span>
        ))}
      </div>
    </Panel>
  );
}

// ── a single promise/reminder row + its controls ─────────────────────────────
// Three modes: view, edit (inline Editor), confirmDelete (a two-step guard so a
// stray click on a glance surface can't nuke a promise). Controls are
// hover-revealed → the kiosk stays glanceable at rest.

type RailKind = "promise" | "reminder";

function Item({
  item,
  kind,
  pal,
  overdue,
  onMutate,
  onFocus,
}: {
  item: FocusReminder;
  kind: RailKind;
  pal: FocusPalette;
  overdue?: boolean;
  onMutate: () => void;
  onFocus?: () => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);

  if (mode === "edit") {
    return (
      <Editor
        kind={kind}
        pal={pal}
        submitLabel="save"
        initialContent={item.content}
        initialSecondary={kind === "promise" ? item.owed_to ?? "" : ""}
        onCancel={() => setMode("view")}
        onSubmit={async ({ content, secondary }) => {
          const patch: Parameters<typeof updateFocusReminder>[1] = {};
          if (content !== item.content) patch.content = content;
          if (kind === "promise") {
            if (secondary) patch.owed_to = secondary;
            else if (item.owed_to) patch.clear_owed = true;
          } else if (secondary) {
            patch.due_hint = secondary;
          }
          if (Object.keys(patch).length > 0) await updateFocusReminder(item.id, patch);
          setMode("view");
          onMutate();
        }}
      />
    );
  }

  const controlsVisible = hover || mode === "confirm";
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: "flex", alignItems: "flex-start", gap: 6 }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <Row
          title={item.content}
          meta={itemMeta(item, kind)}
          pal={pal}
          tone={item.state === "broken" ? "warn" : "normal"}
          metaWarn={item.state === "broken" || overdue}
        />
      </div>
      <div
        style={{
          display: "flex",
          gap: 3,
          alignItems: "center",
          flexShrink: 0,
          opacity: controlsVisible ? 1 : 0,
          pointerEvents: controlsVisible ? "auto" : "none",
          transition: "opacity 120ms",
        }}
      >
        {mode === "confirm" ? (
          <>
            <span style={{ fontSize: 10, color: pal.warn, letterSpacing: "0.04em" }}>delete?</span>
            <IconBtn
              pal={pal}
              danger
              disabled={busy}
              label="Confirm delete"
              onClick={async () => {
                setBusy(true);
                try {
                  await deleteFocusReminder(item.id);
                  onMutate();
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Check size={12} strokeWidth={2.2} />
            </IconBtn>
            <IconBtn pal={pal} label="Cancel delete" onClick={() => setMode("view")}>
              <X size={12} strokeWidth={2} />
            </IconBtn>
          </>
        ) : (
          <>
            <IconBtn
              pal={pal}
              label="Mark done"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await updateFocusReminder(item.id, { state: "kept" });
                  onMutate();
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Check size={12} strokeWidth={2.2} />
            </IconBtn>
            {onFocus && (
              <IconBtn pal={pal} label="Focus on this" onClick={onFocus}>
                <Play size={11} strokeWidth={2.2} />
              </IconBtn>
            )}
            <IconBtn pal={pal} label="Edit" onClick={() => setMode("edit")}>
              <Pencil size={11} strokeWidth={2} />
            </IconBtn>
            <IconBtn pal={pal} label="Delete" onClick={() => setMode("confirm")}>
              <Trash2 size={11} strokeWidth={2} />
            </IconBtn>
          </>
        )}
      </div>
    </div>
  );
}

// The meta line under a row. A broken promise renders the GAP ("lasted 4d")
// instead of a due time — the failure is the information. An owed-to promise
// keeps its age, which is what makes an old debt feel old.
function itemMeta(item: FocusReminder, kind: RailKind): string | undefined {
  if (item.state === "broken") return `broke · lasted ${item.lasted_days}d`;
  if (kind === "promise" && item.owed_to) return fmtPromiseMeta(item.owed_to, item.age_days);
  // A defaulted due is placement, not a deadline — showing "11:59 PM" for it
  // would be inventing precision Daniel never asked for.
  if (item.due_is_default) return undefined;
  return fmtTime(item.due_at);
}

// ── shared inline editor ──────────────────────────────────────────────────────
// Emits content + a kind-specific secondary (promise → owed-to person;
// reminder → a due hint like "friday").

function Editor({
  kind,
  pal,
  submitLabel,
  initialContent = "",
  initialSecondary = "",
  onSubmit,
  onCancel,
}: {
  kind: RailKind;
  pal: FocusPalette;
  submitLabel: string;
  initialContent?: string;
  initialSecondary?: string;
  onSubmit: (v: { content: string; secondary: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [content, setContent] = useState(initialContent);
  const [secondary, setSecondary] = useState(initialSecondary);
  const [busy, setBusy] = useState(false);
  const secondaryPlaceholder =
    kind === "promise" ? "owed to — blank = yourself" : "when — e.g. friday (blank = today)";

  async function submit() {
    const c = content.trim();
    if (!c || busy) return;
    setBusy(true);
    try {
      await onSubmit({ content: c, secondary: secondary.trim() });
    } finally {
      setBusy(false);
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      onCancel();
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <input
        autoFocus
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={onKey}
        placeholder="what"
        style={fieldStyle(pal)}
      />
      <input
        value={secondary}
        onChange={(e) => setSecondary(e.target.value)}
        onKeyDown={onKey}
        placeholder={secondaryPlaceholder}
        style={fieldStyle(pal)}
      />
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <PrimaryBtn pal={pal} disabled={busy || !content.trim()} onClick={() => void submit()}>
          {submitLabel}
        </PrimaryBtn>
        <GhostBtn pal={pal} onClick={onCancel}>
          cancel
        </GhostBtn>
      </div>
    </div>
  );
}

function PrimaryBtn({
  children,
  pal,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  pal: FocusPalette;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        fontFamily: FONT,
        fontSize: 11,
        padding: "4px 12px",
        borderRadius: 7,
        border: "none",
        cursor: disabled ? "default" : "pointer",
        background: pal.accent,
        color: pal.paper,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function GhostBtn({
  children,
  pal,
  onClick,
}: {
  children: React.ReactNode;
  pal: FocusPalette;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: FONT,
        fontSize: 11,
        padding: "4px 10px",
        borderRadius: 7,
        border: `1px solid ${pal.rule}`,
        cursor: "pointer",
        background: "transparent",
        color: pal.ink3,
      }}
    >
      {children}
    </button>
  );
}

function EmptyHint({ children, pal }: { children: React.ReactNode; pal: FocusPalette }) {
  return <div style={{ fontSize: 11, color: pal.ink3, opacity: 0.55 }}>{children}</div>;
}

function fieldStyle(pal: FocusPalette): React.CSSProperties {
  return {
    width: "100%",
    boxSizing: "border-box",
    background: "transparent",
    border: `1px solid ${pal.rule}`,
    borderRadius: 7,
    padding: "6px 8px",
    color: pal.ink,
    fontFamily: FONT,
    fontSize: 12,
    outline: "none",
  };
}

// ── streak strip (paged) ──────────────────────────────────────────────────────

function StreakStrip({ cols, pal }: { cols: StreakCol[]; pal: FocusPalette }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(cols.length / STREAK_PER_PAGE));
  const clamped = Math.min(page, pages - 1);
  const slice = cols.slice(clamped * STREAK_PER_PAGE, clamped * STREAK_PER_PAGE + STREAK_PER_PAGE);

  if (cols.length === 0) {
    return <div style={{ color: pal.ink3, fontSize: 11 }}>nothing tracked yet</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-around", alignItems: "flex-end", minHeight: 96 }}>
        {slice.map((c) => (
          <StreakColumn key={c.t.id} col={c} pal={pal} />
        ))}
      </div>
      {pages > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14, marginTop: 10 }}>
          <PagerBtn dir="left" pal={pal} disabled={clamped === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} />
          <span style={{ color: pal.ink3, fontSize: 10, letterSpacing: 1 }}>
            {clamped + 1}/{pages}
          </span>
          <PagerBtn
            dir="right"
            pal={pal}
            disabled={clamped >= pages - 1}
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
          />
        </div>
      )}
    </div>
  );
}

function PagerBtn({
  dir,
  pal,
  disabled,
  onClick,
}: {
  dir: "left" | "right";
  pal: FocusPalette;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === "left" ? "Previous trackables" : "More trackables"}
      style={{
        width: 20,
        height: 20,
        borderRadius: 6,
        border: "none",
        background: "transparent",
        cursor: disabled ? "default" : "pointer",
        color: pal.ink3,
        opacity: disabled ? 0.3 : 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
      }}
    >
      {dir === "left" ? <ChevronLeft size={15} strokeWidth={2} /> : <ChevronRight size={15} strokeWidth={2} />}
    </button>
  );
}

// One trackable as a vertical dot-trail (oldest at top) + today's marker +
// name. Booleans read as filled/empty rings; numbers show today's value.
function StreakColumn({ col, pal }: { col: StreakCol; pal: FocusPalette }) {
  const { t, days } = col;
  const todayVal = days[0]?.value;
  const trail = days.slice(1, 1 + STREAK_TRAIL).slice().reverse(); // oldest → newest
  const n = trail.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 46 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, marginBottom: 6 }}>
        {trail.map((d, i) => {
          const recency = n <= 1 ? 1 : i / (n - 1);
          const size = 4 + recency * 3;
          const did = t.kind === "boolean" ? d.value === true : d.value != null;
          return (
            <span
              key={d.date}
              title={`${d.date}: ${d.value ?? "—"}`}
              style={{
                width: size,
                height: size,
                borderRadius: 999,
                boxSizing: "border-box",
                background: did ? pal.accent : "transparent",
                opacity: did ? 0.25 + recency * 0.55 : 0.5,
                border: did ? "none" : `1px solid ${pal.ink3}`,
              }}
            />
          );
        })}
      </div>

      {/* today marker */}
      {t.kind === "boolean" ? (
        todayVal === true ? (
          <span style={{ color: pal.accent, display: "inline-flex", alignItems: "center" }}>
            <Check size={13} strokeWidth={2.4} />
          </span>
        ) : (
          <span
            style={{
              width: 13,
              height: 13,
              borderRadius: 999,
              boxSizing: "border-box",
              border: `1.5px solid ${pal.ink3}`,
            }}
          />
        )
      ) : (
        <span style={{ fontSize: 12.5, fontWeight: 600, color: typeof todayVal === "number" ? pal.ink : pal.ink3 }}>
          {typeof todayVal === "number" ? Math.round(todayVal) : "–"}
        </span>
      )}

      <span
        style={{
          fontSize: 9.5,
          color: pal.ink3,
          marginTop: 7,
          maxWidth: 46,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          letterSpacing: 0.2,
        }}
        title={t.name}
      >
        {t.name}
      </span>
    </div>
  );
}

// ── passive feeds (subtle) ────────────────────────────────────────────────────

function FeedLine({
  whoop,
  lc,
  pal,
}: {
  whoop: WhoopToday | null;
  lc: LeetcodeToday | null;
  pal: FocusPalette;
}) {
  const whoopBits: string[] = [];
  if (whoop && whoop.date) {
    if (whoop.recovery_score != null) whoopBits.push(`rec ${Math.round(whoop.recovery_score)}`);
    if (whoop.strain != null) whoopBits.push(`strain ${(Math.round(whoop.strain * 10) / 10).toFixed(1)}`);
    if (whoop.sleep_minutes != null) whoopBits.push(`${Math.round((whoop.sleep_minutes / 60) * 10) / 10}h`);
  }
  const lcBits: string[] = [];
  if (lc && lc.available) {
    if (lc.today_count != null) lcBits.push(`${lc.today_count} today`);
    if (lc.streak != null) lcBits.push(`${lc.streak} streak`);
  }
  if (whoopBits.length === 0 && lcBits.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 10.5, color: pal.ink3 }}>
      {whoopBits.length > 0 && (
        <div>
          <FeedTag pal={pal}>whoop</FeedTag> {whoopBits.join(" · ")}
          {whoop?.day_label ? <span style={{ color: pal.warn }}> · {whoop.day_label}</span> : null}
        </div>
      )}
      {lcBits.length > 0 && (
        <div>
          <FeedTag pal={pal}>leetcode</FeedTag> {lcBits.join(" · ")}
        </div>
      )}
    </div>
  );
}

function FeedTag({ children, pal }: { children: React.ReactNode; pal: FocusPalette }) {
  return (
    <span style={{ letterSpacing: "0.1em", textTransform: "uppercase", fontSize: 9, color: pal.ink3, opacity: 0.75 }}>
      {children}
    </span>
  );
}

// ── activity matrix overlay ───────────────────────────────────────────────────

function MatrixOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(3px)",
        WebkitBackdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: FONT,
      }}
    >
      <div
        style={{
          position: "relative",
          width: "min(1120px, 94vw)",
          height: "min(80vh, 640px)",
          borderRadius: 20,
          overflow: "hidden",
          background: "color-mix(in srgb, rgb(var(--gooni-surf, 11 15 13)) 62%, transparent)",
          backdropFilter: "blur(22px)",
          WebkitBackdropFilter: "blur(22px)",
          border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.10)",
          boxShadow: "0 20px 70px rgba(0,0,0,0.55)",
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute",
            top: 12,
            right: 14,
            zIndex: 3,
            width: 26,
            height: 26,
            borderRadius: 8,
            cursor: "pointer",
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.12)",
            background: "rgb(var(--gooni-surf, 11 15 13) / 0.5)",
            color: "rgb(var(--gooni-ink, 244 245 244) / 0.5)",
          }}
        >
          <X size={14} strokeWidth={1.9} />
        </button>
        <LogTable />
      </div>
    </div>
  );
}
