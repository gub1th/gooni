import { useEffect, useRef, useState } from "react";
import { Check, Target } from "lucide-react";
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

export interface TodayRow {
  item: FocusReminder;
  /** focus minutes accrued against this promise, all-time in the window */
  minutes: number;
}

export function TodayList({
  rows,
  laterCount,
  laterRows,
  runningId,
  runningLabel,
  onTick,
  onAdd,
  onFocus,
  onResume,
  rowsMaxHeight,
}: {
  rows: TodayRow[];
  laterCount: number;
  laterRows: FocusReminder[];
  /** promise id of the session running right now, if any */
  runningId: number | null;
  /** live mm:ss for that session */
  runningLabel: string;
  onTick: (item: FocusReminder) => void;
  onAdd: (title: string) => Promise<void> | void;
  onFocus: (item: FocusReminder) => void;
  onResume: () => void;
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
        alignItems: "center",
        textAlign: "center",
        fontFamily: FONT,
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.14em",
          color: ink(0.38),
          marginBottom: 14,
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
          display: "flex", flexDirection: "column", alignItems: "center",
        }}
      >
        {rows.map(({ item, minutes }) => (
          <TaskRow
            key={item.id}
            item={item}
            minutes={minutes}
            running={runningId === item.id}
            runningLabel={runningLabel}
            onTick={() => onTick(item)}
            onFocus={() => onFocus(item)}
            onResume={onResume}
          />
        ))}

        {rows.length === 0 && !adding && (
          <span style={{ fontSize: 17, color: ink(0.3), padding: "6px 0" }}>nothing today</span>
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
  running,
  runningLabel,
  onTick,
  onFocus,
  onResume,
}: {
  item: FocusReminder;
  minutes: number;
  running: boolean;
  runningLabel: string;
  onTick: () => void;
  onFocus: () => void;
  onResume: () => void;
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
        justifyContent: "center",
        gap: 14,
        padding: "6px 0",
      }}
    >
      <button
        onClick={onTick}
        aria-label={done ? `Reopen ${item.content}` : `Complete ${item.content}`}
        aria-pressed={done}
        style={{
          width: 22,
          height: 22,
          flex: "none",
          borderRadius: 5,
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
        {done && <Check size={12} strokeWidth={3.4} color="var(--gooni-void, #000)" />}
      </button>

      <span
        style={{
          fontSize: 25,
          fontWeight: 450,
          letterSpacing: "-0.012em",
          lineHeight: 1.25,
          color: done ? ink(0.5) : ink(0.92),
          textDecoration: done ? "line-through" : "none",
          textDecorationThickness: done ? 1.5 : undefined,
        }}
      >
        {item.content}
      </span>

      {/* accrued focus time, and the live clock while a session is on it */}
      {running ? (
        <button
          onClick={onResume}
          title="back to the session"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            border: "none",
            background: "transparent",
            padding: 0,
            cursor: "pointer",
            fontFamily: FONT,
            fontSize: 14,
            color: accent,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <RunningDot color={accent} />
          {runningLabel}
        </button>
      ) : (
        minutes > 0 && (
          <span style={{ fontSize: 14, color: ink(0.34), fontVariantNumeric: "tabular-nums" }}>
            {fmtMinutes(minutes)}
          </span>
        )
      )}

      {/* focus has exactly ONE door and it is a task */}
      <button
        onClick={onFocus}
        aria-label={`Focus on ${item.content}`}
        title="focus"
        style={{
          position: "absolute",
          right: -34,
          width: 30,
          height: 30,
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
    </div>
  );
}

function RunningDot({ color }: { color: string }) {
  return (
    <>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: color,
          animation: "gooni-run-pulse 1.8s ease-in-out infinite",
        }}
      />
      <style>{`@keyframes gooni-run-pulse{0%,100%{opacity:1}50%{opacity:0.35}}`}</style>
    </>
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
