import { useEffect, useState } from "react";
import { FONT } from "../../ui";
import { fetchFocusAttribution, type AttributedPromise } from "../../services/api";
import { fmtMinutes } from "../../services/focusTime";
import type { FocusPalette } from "./focusPalette";

const HISTORY_DAYS = 7;
const MAX_ROWS = 6;

/**
 * Past focus sessions — what got worked on, and for how long. Nothing in the
 * app read `GET /focus/attribution` (the timer-as-attribution layer, additive
 * since 2026-08-15) before this; the route, the fetcher and the types all
 * shipped with "which surface renders it is a product call" left open. The
 * idle kiosk is the answer: it is already the one screen dedicated to focus
 * and nothing else, and it is otherwise a bare "focus starts from a task"
 * line with room under it.
 *
 * Reads the last HISTORY_DAYS days, ranks promises by total focused minutes
 * (`rank()`'s job server-side would do the same — this is a small enough set
 * that a client-side sort is simpler than adding a second server shape for
 * it), and shows each one's per-day minutes as a tiny bar so a week's rhythm
 * is visible at a glance. `precise: false` rows are flagged — their minutes
 * come off the day's envelope rather than the exact focus runs, so the value
 * is an upper bound, same distinction `focus_attribution` draws server-side.
 */
export function FocusHistory({ pal }: { pal: FocusPalette }) {
  const [promises, setPromises] = useState<AttributedPromise[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchFocusAttribution({ days: HISTORY_DAYS })
      .then((res) => {
        if (cancelled) return;
        const ranked = res.promises
          .filter((p) => p.focused_minutes > 0)
          .sort((a, b) => b.focused_minutes - a.focused_minutes)
          .slice(0, MAX_ROWS);
        setPromises(ranked);
      })
      .catch(() => { if (!cancelled) setErr(true); });
    return () => { cancelled = true; };
  }, []);

  if (err || (promises && promises.length === 0)) return null;

  return (
    <div style={{ width: "min(92vw, 460px)", margin: "28px auto 0", fontFamily: FONT }}>
      <div style={{ fontSize: 10.5, letterSpacing: 1, textTransform: "uppercase", color: pal.ink3, marginBottom: 10, textAlign: "center" }}>
        last {HISTORY_DAYS} days
      </div>
      {!promises ? (
        <div style={{ fontSize: 12, color: pal.ink3, textAlign: "center" }}>loading…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {promises.map((p) => (
            <FocusHistoryRow key={p.promise_id} p={p} pal={pal} />
          ))}
        </div>
      )}
    </div>
  );
}

function FocusHistoryRow({ p, pal }: { p: AttributedPromise; pal: FocusPalette }) {
  const maxMin = Math.max(1, ...p.days.map((d) => d.focused_minutes));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div
        style={{
          flex: 1, minWidth: 0, fontSize: 13, color: p.promise_exists ? pal.ink2 : pal.ink3,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          textDecoration: p.state === "kept" ? "line-through" : "none",
        }}
        title={p.title}
      >
        {p.title}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 18 }}>
        {p.days.slice().reverse().map((d) => (
          <span
            key={d.date}
            title={`${d.date}: ${fmtMinutes(d.focused_minutes)}${d.precise ? "" : " (upper bound)"}`}
            style={{
              width: 4,
              height: Math.max(2, (d.focused_minutes / maxMin) * 18),
              borderRadius: 1,
              background: d.focused_minutes > 0 ? pal.accent : pal.rule,
              opacity: d.precise ? 1 : 0.55,
            }}
          />
        ))}
      </div>
      <div style={{ fontSize: 12, color: pal.ink3, fontVariantNumeric: "tabular-nums", minWidth: 42, textAlign: "right" }}>
        {fmtMinutes(p.focused_minutes)}
      </div>
    </div>
  );
}
