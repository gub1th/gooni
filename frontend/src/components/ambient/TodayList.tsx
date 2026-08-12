import { useEffect, useRef, useState } from "react";
import { Check, Pause, Play, Square, Target } from "lucide-react";
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
}) {
  const [hovered, setHovered] = useState(false);
  const [adding, setAdding] = useState(false);
  const [laterOpen, setLaterOpen] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
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
        }}
      >
        {rows.map(({ item, minutes }) => (
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

        {rows.length === 0 && !adding && (
          <span style={{ fontSize: 14, color: ink(0.3), padding: "5px 0" }}>nothing today</span>
        )}
      </div>

      <div
        style={{
          marginTop: 10,
          opacity: hovered || adding ? 1 : 0,
          transition: "opacity 180ms ease",
        }}
      >
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

      {/* `N later` is load-bearing, not decoration: `+ add` defaults every new
          task to today, so without a visible longer-term bucket TODAY quietly
          becomes a dumping ground and stops meaning today. */}
      {laterCount > 0 && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <BareButton onClick={() => setLaterOpen((o) => !o)}>
            {laterCount} later
          </BareButton>
          {laterOpen && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5, paddingTop: 2 }}>
              {laterRows.map((r) => (
                <span key={r.id} style={{ fontSize: 14.5, color: ink(0.5), lineHeight: 1.35 }}>
                  {r.content}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
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
      <button
        onClick={onTick}
        aria-label={done ? `Reopen ${item.content}` : `Complete ${item.content}`}
        aria-pressed={done}
        style={{
          width: 18,
          height: 18,
          flex: "none",
          borderRadius: 4,
          padding: 0,
          cursor: "pointer",
          display: "grid",
          placeItems: "center",
          border: `1.8px solid ${done || cbHover ? accent : ink(0.38)}`,
          background: done ? accent : "transparent",
          transition: "background 120ms ease, border-color 120ms ease",
        }}
        onMouseEnter={() => setCbHover(true)}
        onMouseLeave={() => setCbHover(false)}
      >
        {done && <Check size={11} strokeWidth={3.4} color="var(--gooni-void, #000)" />}
      </button>

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
