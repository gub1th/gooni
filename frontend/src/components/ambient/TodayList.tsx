import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, ListChecks, Pause, Play, Square, Target, X } from "lucide-react";
import { FONT, frostInk } from "../../ui";
import { ink } from "./ambientInk";
import { fmtMinutes } from "../../services/focusTime";
import type { FocusReminder } from "../../services/api";

// TODAY — the list, in Momentum's slot under the line.
//
// Treatment rules the first attempt broke, restated because they're the whole
// look: nothing here gets a frosted pill, a filled container, or a card. Chrome
// at the centre of the screen reads as a second anchor and competes with the
// wave. What carries this list is type size and ink alpha, nothing else.
//
// Ticking strikes the row through IN PLACE. It does not move to a completed
// section: the list is short enough that reordering on tick is just the row
// you were looking at jumping out from under the pointer.
//
// LEFT-ALIGNED, and smaller (pass 3). Momentum centres because it shows exactly
// ONE task; centring a LIST breaks scanning, because the eye needs a fixed left
// edge to run down. We show several, so it left-aligns on a shared edge.

export interface TodayRow {
  item: FocusReminder;
  /** focus minutes accrued against this promise, all-time in the window */
  minutes: number;
}

/**
 * What the session on this row is DOING — the whole indicator, derived once.
 *
 * Only `focus` is accruing: `splitSegmentsByDay` drops break segments, so break
 * minutes never reach `focused today` and no entry is ever written for them, and
 * a paused session accrues nothing at all. A pulsing dot and a ticking clock
 * both claim "accruing right now", so only `focus` may render them.
 */
// break was removed in pass 3; the row derives over two states now
export type SessionRowState = "focus" | "paused";

export interface SessionRow {
  promiseId: number;
  state: SessionRowState;
  /** live mm:ss — shown for `focus` only */
  label: string;
}

/**
 * Whether the longer-term bucket shows rows that carry NO due date.
 *
 * Off since the 2026-08-15 captain review: the bucket had filled with ~19
 * dateless commitments from weeks back and rendered as `UNDATED (19)` under
 * every day's list — "i dont see much value in undated tbh for now". A bucket
 * nobody opens is the log dot again: a permanent signal you stop reading.
 *
 * It HIDES, it does not delete. Every one of those promises is still active in
 * the database and still reachable through quickfind, `/promises` and the MCP
 * surface; this is a render rule on one surface, which is why it is a flag here
 * rather than a filter at the fetch or a state change on the rows.
 *
 * DATED longer-term rows are untouched. That bucket is load-bearing — `+ add`
 * defaults every new task to today, so without a visible `Later` the day's list
 * quietly becomes a dumping ground and stops meaning today.
 */
export const SHOW_UNDATED_LATER = false;

/** `Sep 1` for a dated longer-term row; empty when the stamp will not parse. */
function laterDueLabel(dueAt: string): string {
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TodayList({
  rows,
  laterCount,
  laterRows,
  sessionRow,
  onTick,
  onAdd,
  onFocus,
  onTogglePause,
  onStop,
  rowsMaxHeight,
  fill,
}: {
  rows: TodayRow[];
  laterCount: number;
  laterRows: FocusReminder[];
  /** the session on screen — focus, break or paused — or null */
  sessionRow: SessionRow | null;
  onTick: (item: FocusReminder) => void;
  onAdd: (title: string) => Promise<void> | void;
  onFocus: (item: FocusReminder) => void;
  /** pause or resume the session on the running row */
  onTogglePause: () => void;
  /** end the session on the running row (writes its entry) */
  onStop: () => void;
  /** cap for the ROWS region before it scrolls (the controls below never do) */
  rowsMaxHeight?: number | string;
  /** the daily trackable fill, offered as a task row until it is put away */
  fill?: { onOpen: () => void; onDismiss: () => void; logged: boolean } | null;
}) {
  const [adding, setAdding] = useState(false);
  const [laterOpen, setLaterOpen] = useState(false);
  const [completedOpen, setCompletedOpen] = useState(false);

  // Completed tasks LEAVE the active list and collect in their own section
  // (pass 9). They used to stay struck through in place, which was the right
  // answer only while there was nowhere else to put them. Retention still does
  // its job — `/focus/dashboard` serves ACTIVE rows only, so without it a ticked
  // row would vanish from the day entirely rather than move down here.
  const active = rows.filter((r) => r.item.state !== "kept");
  const completed = rows.filter((r) => r.item.state === "kept");

  // The task a session is RUNNING on pins to the top of TODAY, above even the
  // daily-fill row. It is the one thing on this surface you are doing right
  // now, and hunting for it down a ten-task list to pause or tick it is the
  // whole reason it earns the position. Everything else keeps server order.
  const runningId = sessionRow?.promiseId ?? null;
  const ordered = runningId == null
    ? active
    : [
        ...active.filter((r) => r.item.id === runningId),
        ...active.filter((r) => r.item.id !== runningId),
      ];
  const runningIsPinned = runningId != null && ordered[0]?.item.id === runningId;

  // The longer-term bucket, minus the dateless rows when they are hidden. The
  // COUNT is derived from what is actually shown rather than taken from the
  // prop: `(19)` beside three visible rows is a claim about the section that
  // opening it disproves.
  const laterShown = SHOW_UNDATED_LATER ? laterRows : laterRows.filter((r) => r.due_at);
  const laterShownCount = SHOW_UNDATED_LATER ? laterCount : laterShown.length;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        textAlign: "left",
        fontFamily: FONT,
      }}
    >
      <style>{RUN_PULSE_CSS}</style>
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.14em",
          color: ink(0.38),
          marginBottom: 12,
        }}
      >
        TODAY
      </span>

      {/* ONLY the rows scroll. `+ add` and `N later` are the two controls that
          must survive a long day — putting them inside the scroller is how a
          ten-task list quietly hides the way to add an eleventh, and hides the
          "later" bucket that stops TODAY becoming a dumping ground. */}
      <div
        style={{
          maxHeight: rowsMaxHeight,
          overflowY: "auto",
          overflowX: "hidden",
          // full width so the scrollbar gutter can't shift the centred rows
          alignSelf: "stretch",
          display: "flex", flexDirection: "column", alignItems: "stretch",
          // the focus-glow ring on the running task's checkbox sits at
          // inset:-3 past the checkbox box — without this padding (offset
          // by the matching negative margin below, so layout is unchanged)
          // this scroller's own overflow:hidden/auto edges clip the ring.
          padding: 3,
          margin: -3,
        }}
      >
        {/* the running task, above the fill row */}
        {runningIsPinned && ordered[0] && (
          <TaskRow
            key={ordered[0].item.id}
            item={ordered[0].item}
            minutes={ordered[0].minutes}
            session={sessionRow}
            onTick={() => onTick(ordered[0].item)}
            onFocus={() => onFocus(ordered[0].item)}
            onTogglePause={onTogglePause}
            onStop={onStop}
          />
        )}

        {fill && <DailyFillRow onOpen={fill.onOpen} onDismiss={fill.onDismiss} logged={fill.logged} />}

        {(runningIsPinned ? ordered.slice(1) : ordered).map(({ item, minutes }) => (
          <TaskRow
            key={item.id}
            item={item}
            minutes={minutes}
            session={sessionRow?.promiseId === item.id ? sessionRow : null}
            onTick={() => onTick(item)}
            onFocus={() => onFocus(item)}
            onTogglePause={onTogglePause}
            onStop={onStop}
          />
        ))}

        {ordered.length === 0 && !fill && !adding && (
          <span style={{ fontSize: 14, color: ink(0.3), padding: "5px 0" }}>nothing today</span>
        )}
      </div>

      {/* ALWAYS VISIBLE. It was revealed on hover, which is wrong for the one
          primary action on the surface — and worse on a list you are meant to
          add to daily, where a control you have to discover by sweeping the
          mouse is a control most days do not get used. */}
      <div style={{ marginTop: 10 }}>
        {adding ? (
          <AddField
            onCancel={() => setAdding(false)}
            onSubmit={async (title) => {
              await onAdd(title);
              setAdding(false);
            }}
          />
        ) : (
          <BareButton onClick={() => setAdding(true)}>+ add</BareButton>
        )}
      </div>

      {/* This bucket is load-bearing, not decoration: `+ add` defaults every new
          task to today, so without a visible longer-term bucket TODAY quietly
          becomes a dumping ground and stops meaning today.
          The LABEL IS DERIVED, not hardcoded. Pass 8 asked for `undated` on the
          grounds that these rows carry no due date — true of some data, but not
          of this database, where all three are explicit deadlines about three
          weeks out (`due_is_default: false`). Hardcoding either word makes the
          label a lie half the time, which is the exact failure the rename was
          meant to fix, so it reads the rows instead. Each row shows its own due
          date when it has one, so the bucket explains itself either way.
          The derivation STAYS while `SHOW_UNDATED_LATER` is off, even though
          only the `Later` branch is reachable: the flag is the thing that is
          expected to move, and a label hardcoded to match today's flag value is
          a lie waiting for it to flip back. */}
      {laterShownCount > 0 && (
        <ListSection
          label={laterShown.every((r) => !r.due_at) ? "Undated" : "Later"}
          count={laterShownCount}
          open={laterOpen}
          onToggle={() => setLaterOpen((o) => !o)}
        >
          {laterShown.map((r) => (
            <span key={r.id} style={{ fontSize: 14.5, color: ink(0.5), lineHeight: 1.35 }}>
              {r.content}
              {r.due_at && (
                <span style={{ fontSize: 12, color: ink(0.32), marginLeft: 8 }}>
                  {laterDueLabel(r.due_at)}
                </span>
              )}
            </span>
          ))}
        </ListSection>
      )}

      {completed.length > 0 && (
        <ListSection
          label="Completed"
          count={completed.length}
          open={completedOpen}
          onToggle={() => setCompletedOpen((o) => !o)}
        >
          {completed.map(({ item, minutes }) => (
            <button
              key={item.id}
              onClick={() => onTick(item)}
              title="Move back to today"
              style={{
                display: "flex", alignItems: "baseline", gap: 8,
                border: "none", background: "transparent", padding: 0, cursor: "pointer",
                fontFamily: FONT, fontSize: 14.5, lineHeight: 1.35, textAlign: "left",
                color: ink(0.42), textDecoration: "line-through",
              }}
            >
              {item.content}
              {minutes > 0 && (
                <span style={{ fontSize: 12, color: ink(0.3), textDecoration: "none" }}>
                  {fmtMinutes(minutes)}
                </span>
              )}
            </button>
          ))}
        </ListSection>
      )}
    </div>
  );
}

/**
 * `Later` and `Completed` are the SAME KIND OF THING — a collapsible group with
 * a count, below the day's list. Before pass 9 `3 later` floated as a lone grey
 * line and read as debris, and completed tasks had no home at all. One component
 * for both is what makes today / later / completed read as one language rather
 * than a list plus two stray labels.
 */
function ListSection({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div style={{ alignSelf: "stretch", marginTop: 14 }}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          border: "none", background: "transparent", padding: 0, cursor: "pointer",
          fontFamily: FONT, fontSize: 11, fontWeight: 700, letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: hover ? ink(0.7) : ink(0.38),
          transition: "color 140ms ease",
        }}
      >
        <ChevronRight
          size={12}
          strokeWidth={2.2}
          style={{
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 160ms ease",
            flex: "none",
          }}
        />
        {label}
        <span style={{ fontVariantNumeric: "tabular-nums", opacity: 0.75 }}>({count})</span>
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: "8px 0 0 18px" }}>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * The daily fill, wearing a task row's clothes.
 *
 * It is NOT a promise and writes nothing to the record — it is an offer to do
 * the day's logging, which is why it carries a dismiss rather than a checkbox.
 * Ticking a task claims the work is done; putting this away only says you are
 * finished logging, and those are different claims (see `dailyFill.ts`).
 */
function DailyFillRow({ onOpen, onDismiss, logged }: { onOpen: () => void; onDismiss: () => void; logged: boolean }) {
  const [hover, setHover] = useState(false);
  // Done AT A GLANCE: once anything has been logged today the glyph takes the
  // accent, so the row answers "have I done this?" without being opened. It is
  // NOT struck through and does not disappear — more can always be logged, and
  // a row that vanished would take the way back in with it.
  const accent = frostInk.accent;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, padding: "5px 0" }}
    >
      <button
        onClick={onOpen}
        aria-label="Log today's trackables"
        style={{
          width: 19, height: 19, flex: "none", padding: 0, borderRadius: 5, cursor: "pointer",
          background: "transparent",
          // DASHED, so it does not read as a task you can tick — the same shape
          // as the matrix's own "add a trackable" affordance.
          border: `1.5px dashed ${logged || hover ? accent : ink(0.32)}`,
          display: "grid", placeItems: "center",
          transition: "border-color 140ms ease",
        }}
      >
        <ListChecks size={11} strokeWidth={2} color={logged || hover ? accent : ink(0.42)} />
      </button>
      <button
        onClick={onOpen}
        style={{
          border: "none", background: "transparent", padding: 0, cursor: "pointer",
          fontFamily: FONT, fontSize: 19, letterSpacing: "-0.01em", textAlign: "left",
          color: hover ? ink(0.8) : logged ? ink(0.68) : ink(0.55),
          transition: "color 140ms ease",
        }}
      >
        log today
      </button>
      <button
        onClick={onDismiss}
        aria-label="Put the daily log away for today"
        title="Put it away for today"
        style={{
          marginLeft: 2, width: 20, height: 20, padding: 0, borderRadius: 999,
          border: "none", background: "transparent", cursor: "pointer",
          display: "grid", placeItems: "center",
          color: ink(0.38), opacity: hover ? 1 : 0, transition: "opacity 140ms ease",
        }}
      >
        <X size={12} strokeWidth={2} />
      </button>
    </div>
  );
}

function TaskRow({
  item,
  minutes,
  session,
  onTick,
  onFocus,
  onTogglePause,
  onStop,
}: {
  item: FocusReminder;
  minutes: number;
  /** the session on THIS row, if any */
  session: SessionRow | null;
  onTick: () => void;
  onFocus: () => void;
  onTogglePause: () => void;
  onStop: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [cbHover, setCbHover] = useState(false);
  const done = item.state === "kept";
  const accent = frostInk.accent;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: 12,
        padding: "5px 0",
      }}
    >
      <span style={{ position: "relative", flex: "none", width: 18, height: 18 }}>
        {/* the running task's checkbox reads as active, not just checkable —
            a ring in the FOCUS_GLOW token, pulsing while focus is live and
            static (calmer) through a break/pause. No blur, no offset — an
            animated border-opacity ring, not a drop shadow. */}
        {session && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              inset: -3,
              borderRadius: 7,
              border: `1.5px solid var(--gooni-focus)`,
              opacity: session.state === "focus" ? 1 : 0.4,
              animation: session.state === "focus" ? "gooni-run-pulse 1.8s ease-in-out infinite" : "none",
            }}
          />
        )}
        <button
          onClick={onTick}
          aria-label={done ? `Reopen ${item.content}` : `Complete ${item.content}`}
          aria-pressed={done}
          style={{
            width: 18,
            height: 18,
            padding: 0,
            cursor: "pointer",
            display: "grid",
            placeItems: "center",
            borderRadius: 4,
            border: `1.8px solid ${
              session ? "var(--gooni-focus)" : done || cbHover ? accent : ink(0.38)
            }`,
            background: session
              ? session.state === "focus"
                ? "color-mix(in srgb, var(--gooni-focus) 22%, transparent)"
                : "transparent"
              : done
                ? accent
                : "transparent",
            transition: "background 120ms ease, border-color 120ms ease",
          }}
          onMouseEnter={() => setCbHover(true)}
          onMouseLeave={() => setCbHover(false)}
        >
          {done && <Check size={11} strokeWidth={3.4} color="var(--gooni-void, #000)" />}
        </button>
      </span>

      <span
        style={{
          fontSize: 19,
          fontWeight: 450,
          letterSpacing: "-0.012em",
          lineHeight: 1.3,
          color: done ? ink(0.5) : ink(0.92),
          textDecoration: done ? "line-through" : "none",
          textDecorationThickness: done ? 1.5 : undefined,
        }}
      >
        {item.content}
      </span>

      {/* accrued focus time, and the session indicator while one is on this
          row. Only live FOCUS gets the accruing presentation (pulse + ticking
          clock) — break and paused each accrue nothing toward focus, so they
          name themselves instead and still route back. */}
      {/* Plain text, not a link. It used to route to the session; the session
          now occupies the wave's slot directly above this list, so there is
          nowhere for it to go — and a control that goes nowhere is worse than
          no control. */}
      {session ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontFamily: FONT,
            fontSize: 14,
            color: session.state === "focus" ? accent : ink(0.42),
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <RunningDot
            color={session.state === "focus" ? accent : ink(0.42)}
            pulse={session.state === "focus"}
          />
          {session.state === "focus" ? session.label : session.state}
        </span>
      ) : (
        minutes > 0 && (
          <span style={{ fontSize: 14, color: ink(0.34), fontVariantNumeric: "tabular-nums" }}>
            {fmtMinutes(minutes)}
          </span>
        )
      )}

      {/* The RUNNING row owns its own controls. It already shows the running
          state, so the controls belong to it — and this removes a real
          footgun: the focus target on a row that is already running went
          through the switch path, which ends-and-writes the live session and
          starts a fresh one on the SAME task, splitting one sitting into two
          entries and zeroing the clock. Non-running rows keep the target;
          focus still has exactly one door, it just is not this row's door
          while this row is the one running. */}
      {session ? (
        <div style={{ display: "flex", alignItems: "center", gap: 2, flex: "none", marginLeft: 2, opacity: hover ? 1 : 0, transition: "opacity 140ms ease" }}>
          <RowButton
            label={session.state === "focus" ? `Pause ${item.content}` : `Resume ${item.content}`}
            accent={session.state !== "focus"}
            onClick={onTogglePause}
          >
            {session.state === "focus"
              ? <Pause size={13} fill="currentColor" strokeWidth={0} />
              : <Play size={13} fill="currentColor" strokeWidth={0} />}
          </RowButton>
          <RowButton label={`Stop the session on ${item.content}`} onClick={onStop}>
            <Square size={11} fill="currentColor" strokeWidth={0} />
          </RowButton>
        </div>
      ) : (
        <button
          onClick={onFocus}
          aria-label={`Focus on ${item.content}`}
          title="focus"
          style={{
            flex: "none",
            marginLeft: 2,
            width: 26,
            height: 26,
            borderRadius: 999,
            border: "none",
            background: "transparent",
            padding: 0,
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
            color: ink(0.38),
            opacity: hover ? 1 : 0,
            transition: "opacity 140ms ease",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = accent)}
          onMouseLeave={(e) => (e.currentTarget.style.color = ink(0.38))}
        >
          <Target size={15} strokeWidth={1.8} />
        </button>
      )}
    </div>
  );
}

// The keyframes live at module scope, NOT inside the dot. A <style> rendered
// as a sibling of the dot sits INSIDE the button, so the button's textContent
// becomes the CSS plus the clock — which is what a screen reader and any test
// reading the label both get.
const RUN_PULSE_CSS = `@keyframes gooni-run-pulse{0%,100%{opacity:1}50%{opacity:0.35}}`;

function RowButton({
  label,
  onClick,
  accent: isAccent,
  children,
}: {
  label: string;
  onClick: () => void;
  accent?: boolean;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 24, height: 24, padding: 0, borderRadius: 999, cursor: "pointer",
        border: "none", background: "transparent",
        display: "grid", placeItems: "center",
        color: isAccent ? frostInk.accent : hover ? ink(0.9) : ink(0.38),
        transition: "color 140ms ease",
      }}
    >
      {children}
    </button>
  );
}

function RunningDot({ color, pulse }: { color: string; pulse: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 7,
        height: 7,
        borderRadius: 999,
        background: color,
        animation: pulse ? "gooni-run-pulse 1.8s ease-in-out infinite" : "none",
      }}
    />
  );
}

function AddField({
  onSubmit,
  onCancel,
}: {
  onSubmit: (title: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  async function submit() {
    const t = value.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await onSubmit(t);
    } finally {
      setBusy(false);
    }
  }

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => (value.trim() ? void submit() : onCancel())}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void submit();
        } else if (e.key === "Escape") {
          onCancel();
        }
      }}
      placeholder="what"
      spellCheck={false}
      style={{
        // bare underline, not a field — no box at the centre of the screen
        width: 260,
        textAlign: "center",
        fontFamily: FONT,
        fontSize: 17,
        padding: "3px 0",
        color: ink(0.92),
        background: "transparent",
        border: "none",
        borderBottom: `1px solid ${ink(0.16)}`,
        outline: "none",
      }}
    />
  );
}

function BareButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        border: "none",
        background: "transparent",
        padding: 0,
        cursor: "pointer",
        fontFamily: FONT,
        fontSize: 13,
        color: hover ? frostInk.accent : ink(0.38),
        transition: "color 140ms ease",
      }}
    >
      {children}
    </button>
  );
}
