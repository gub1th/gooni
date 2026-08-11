import { useCallback, useEffect, useRef, useState } from "react";
import { FONT, frostInk } from "../../ui";
import { ink } from "./ambientInk";
import { isDaily } from "./LogDots";
import {
  FEED_REFRESH_MS,
  fetchTrackableDays,
  fetchTrackables,
  type Trackable,
  type TrackableDay,
} from "../../services/api";

// ONE faint row of streak dots under the list. The full matrix stays where it
// is (the log surface, reachable from the rail) — this is the glance, so it's a
// single row of trailing days per trackable and nothing else. Bare text and
// dots on the void, dim at rest, brightens on hover — the treatment every
// non-wave thing on this screen follows (inherited from the ActivityRail block
// this replaced).

const TRAIL = 5; // trailing days per trackable

interface Col {
  t: Trackable;
  days: TrackableDay[]; // newest-first, gap-filled; days[0] = today
}

export function StreakRow({ onOpen }: { onOpen: () => void }) {
  const [cols, setCols] = useState<Col[]>([]);
  const [hover, setHover] = useState(false);
  const defsRef = useRef<Trackable[] | null>(null);

  const load = useCallback(async () => {
    try {
      if (!defsRef.current) {
        const all = (await fetchTrackables()).filter(isDaily);
        all.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "boolean" ? -1 : 1;
          if (a.is_important !== b.is_important) return a.is_important ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        defsRef.current = all;
      }
      const defs = defsRef.current;
      setCols(
        await Promise.all(
          defs.map(async (t) => ({ t, days: (await fetchTrackableDays(t.id, 1 + TRAIL)).days })),
        ),
      );
    } catch {
      /* ambient — stay quiet */
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), FEED_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  if (cols.length === 0) return null;

  return (
    <button
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="open the log matrix"
      style={{
        border: "none",
        background: "transparent",
        padding: 0,
        cursor: "pointer",
        fontFamily: FONT,
        display: "flex",
        // ONE row, by contract — the full matrix is a click away and is where
        // wrapped rows of dots belong. Overflow clips rather than wraps so the
        // glance can never become a second block competing with the list.
        flexWrap: "nowrap",
        maxWidth: "100%",
        overflow: "hidden",
        justifyContent: "center",
        gap: 18,
        opacity: hover ? 1 : 0.45,
        transition: "opacity 200ms ease",
      }}
    >
      {cols.map((c) => (
        <StreakItem key={c.t.id} col={c} />
      ))}
    </button>
  );
}

function StreakItem({ col }: { col: Col }) {
  const { t, days } = col;
  // days[0] is today; the trail runs oldest → newest so it reads left-to-right.
  const trail = days.slice(0, 1 + TRAIL).slice().reverse();
  const n = trail.length;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: "none" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {trail.map((d, i) => {
          const recency = n <= 1 ? 1 : i / (n - 1);
          const did = t.kind === "boolean" ? d.value === true : d.value != null;
          const size = 4 + recency * 2;
          return (
            <span
              key={d.date}
              title={`${d.date}: ${d.value ?? "—"}`}
              style={{
                width: size,
                height: size,
                borderRadius: 999,
                boxSizing: "border-box",
                background: did ? frostInk.accent : "transparent",
                opacity: did ? 0.35 + recency * 0.5 : 0.6,
                border: did ? "none" : `1px solid ${ink(0.3)}`,
              }}
            />
          );
        })}
      </span>
      <span style={{ fontSize: 10, letterSpacing: 0.2, color: ink(0.36) }}>{t.name}</span>
    </span>
  );
}
