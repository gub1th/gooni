import { useEffect, useState } from "react";
import { FONT, Modal, frostInk } from "../../ui";
import {
  fetchFocusAttribution,
  type AttributedLayer,
  type AttributedPhoneLayer,
  type AttributedPromise,
} from "../../services/api";
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

/**
 * Rows are CLICKABLE (2026-08-15, modal since): a session's minutes on their
 * own don't answer "what was I actually doing" — that's exactly what the
 * attribution layer is for, and `p.browser`/`p.app`/`p.phone` (the
 * promise-level top names over the whole window) were already sitting
 * unused in the fetched response. Opening the modal costs no second fetch.
 * A modal rather than the old inline expand: the richer breakdown (three
 * sensor sections + per-day bars) doesn't fit readably inline in a 460px
 * column, and a modal gives it real width without disturbing the list.
 */
function FocusHistoryRow({ p, pal }: { p: AttributedPromise; pal: FocusPalette }) {
  const [open, setOpen] = useState(false);
  const maxMin = Math.max(1, ...p.days.map((d) => d.focused_minutes));
  return (
    <div>
      <button
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        style={{
          display: "flex", alignItems: "center", gap: 10, width: "100%",
          border: "none", background: "transparent", padding: 0, cursor: "pointer", textAlign: "left",
        }}
      >
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
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="focus session" width={480}>
        <FocusHistoryDetail p={p} />
      </Modal>
    </div>
  );
}

/**
 * The modal body — task/duration header, per-day bars, then one section per
 * sensor: browser (self-hosts already excluded server-side, see
 * `focus_attribution.SELF_HOSTS`), apps, phone (Shortcuts pings that fired
 * inside the session windows). frostInk throughout — this is chrome floating
 * over the void via `Modal`, not a card surface.
 */
function FocusHistoryDetail({ p }: { p: AttributedPromise }) {
  const maxMin = Math.max(1, ...p.days.map((d) => d.focused_minutes));
  const noData =
    p.browser.top.length === 0 && p.app.top.length === 0 && p.phone.top.length === 0;
  const dateRange =
    p.days.length > 0
      ? p.days.length === 1
        ? p.days[0].date
        : `${p.days[p.days.length - 1].date} – ${p.days[0].date}`
      : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <div
          style={{
            fontSize: 15,
            color: frostInk.text,
            textDecoration: p.state === "kept" ? "line-through" : "none",
            marginBottom: 4,
          }}
        >
          {p.title}
          {!p.promise_exists && (
            <span style={{ fontSize: 11, color: frostInk.muted, marginLeft: 8 }}>(deleted)</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: frostInk.muted, display: "flex", gap: 10 }}>
          <span>{fmtMinutes(p.focused_minutes)}{p.precise ? "" : " (upper bound)"}{p.truncated ? " · capped" : ""}</span>
          {dateRange && <span>{dateRange}</span>}
        </div>
      </div>

      {p.days.length > 1 && (
        <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 28 }}>
          {p.days.slice().reverse().map((d) => (
            <span
              key={d.date}
              title={`${d.date}: ${fmtMinutes(d.focused_minutes)}${d.precise ? "" : " (upper bound)"}`}
              style={{
                width: 6,
                height: Math.max(3, (d.focused_minutes / maxMin) * 28),
                borderRadius: 1.5,
                background: d.focused_minutes > 0 ? frostInk.accent : frostInk.hairline,
                opacity: d.precise ? 1 : 0.55,
              }}
            />
          ))}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {noData ? (
          <div style={{ fontSize: 12, color: frostInk.muted }}>no device activity observed</div>
        ) : (
          <>
            <AttributionColumn label="browser" layer={p.browser} />
            <AttributionColumn label="apps" layer={p.app} />
            <PhoneColumn label="phone" layer={p.phone} />
          </>
        )}
      </div>
    </div>
  );
}

function AttributionColumn({ label, layer }: { label: string; layer: AttributedLayer }) {
  if (layer.top.length === 0) return null;
  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: 0.8, textTransform: "uppercase", color: frostInk.muted, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {layer.top.map((n) => (
          <div key={n.name} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, color: frostInk.text }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.label}</span>
            <span style={{ flex: "none", fontVariantNumeric: "tabular-nums", color: frostInk.muted }}>
              {fmtMinutes(Math.round(n.seconds / 60))}
            </span>
          </div>
        ))}
        {layer.other_sec > 0 && (
          <div style={{ fontSize: 11.5, color: frostInk.muted }}>+ {fmtMinutes(Math.round(layer.other_sec / 60))} more</div>
        )}
      </div>
    </div>
  );
}

/** Same shape as `AttributionColumn`, but phone events are counted pings, not seconds. */
function PhoneColumn({ label, layer }: { label: string; layer: AttributedPhoneLayer }) {
  if (layer.top.length === 0) return null;
  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: 0.8, textTransform: "uppercase", color: frostInk.muted, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {layer.top.map((n) => (
          <div key={n.name} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, color: frostInk.text }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.label}</span>
            <span style={{ flex: "none", fontVariantNumeric: "tabular-nums", color: frostInk.muted }}>
              {n.count}×
            </span>
          </div>
        ))}
        {layer.other_count > 0 && (
          <div style={{ fontSize: 11.5, color: frostInk.muted }}>+ {layer.other_count} more</div>
        )}
      </div>
    </div>
  );
}
