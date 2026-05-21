import { useEffect, useMemo, useState } from "react";

/**
 * Shared continuously-updating elapsed-time pill. Used on the primary
 * todo card AND the primary backlog banner.
 *
 * Tier cadence scales the re-render rate with the displayed unit so we
 * don't burn one render per second forever:
 *   - < 1m elapsed → tick every 1s   (display: "Xs")
 *   - < 1h elapsed → tick every 30s  (display: "Xm")
 *   - < 1d elapsed → tick every 60s  (display: "Xh")
 *   - >= 1d        → tick every 1h   (display: "Xd", capped — no week)
 */

export interface LiveTimerProps {
  since: string | null;
  /** Visual variant. "subtle" matches the dashboard primary-todo pill;
   *  "onColor" sits well over saturated banner backgrounds. */
  variant?: "subtle" | "onColor";
  title?: string;
}

export function LiveTimer({ since, variant = "subtle", title }: LiveTimerProps) {
  const start = useMemo(() => {
    if (!since) return null;
    const ms = new Date(since).getTime();
    return Number.isFinite(ms) ? ms : null;
  }, [since]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (start == null) return;
    let id: number | null = null;
    function tick() {
      const elapsed = Date.now() - start!;
      const next =
        elapsed < 60_000 ? 1000 :
        elapsed < 3_600_000 ? 30_000 :
        elapsed < 86_400_000 ? 60_000 :
        3_600_000;
      setNow(Date.now());
      id = window.setTimeout(tick, next);
    }
    tick();
    return () => { if (id != null) clearTimeout(id); };
  }, [start]);

  if (start == null) return null;
  const elapsed = Math.max(0, now - start);
  const label =
    elapsed < 60_000 ? `${Math.floor(elapsed / 1000)}s` :
    elapsed < 3_600_000 ? `${Math.floor(elapsed / 60_000)}m` :
    elapsed < 86_400_000 ? `${Math.floor(elapsed / 3_600_000)}h` :
    `${Math.floor(elapsed / 86_400_000)}d`;

  const palette = variant === "onColor"
    ? {
        color: "#FFFFFF",
        background: "rgba(255,255,255,0.18)",
        border: "1px solid rgba(255,255,255,0.28)",
      }
    : {
        color: "#0F6E56",
        background: "rgba(15,110,86,0.10)",
        border: "1px solid transparent",
      };

  return (
    <span
      title={title ?? `Active for ${label}`}
      style={{
        display: "inline-flex", alignItems: "center",
        fontSize: 11.5,
        padding: "2px 8px", borderRadius: 99,
        flexShrink: 0,
        fontVariantNumeric: "tabular-nums",
        fontWeight: 600,
        letterSpacing: 0.2,
        ...palette,
      }}
    >
      {label}
    </span>
  );
}
