import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { FONT } from "../../ui";
import {
  fetchWhoopStatus, fetchWhoopToday,
  type WhoopStatus, type WhoopToday,
  type DashboardStats,
} from "../../services/api";
import { parseServerDate } from "../../utils/date";

// DashboardHeader — the top band of the dashboard. Greeting + date on
// the left; on the right: inline Whoop stats (recovery / sleep / strain
// — only when Whoop is connected) + a day-streak tile with a divider.
//
// Pulled from the prior layout where Whoop lived as its own card strip
// below the composer; consolidating into the header tightens the
// fold-of-the-page real estate without dropping any data.


function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function getDateStr(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
}

function recoveryColor(score: number | null): string {
  if (score == null) return "var(--gooni-muted, #8E8E93)";
  if (score >= 67) return "#0F6E56";
  if (score >= 34) return "#BA7517";
  return "#791F1F";
}

function fmtSleep(min: number | null | undefined): string {
  if (min == null) return "—";
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

// "updated 3h ago" off source_updated_at — when Whoop last had NEW data
// upstream, not when we last polled (a poll can re-fetch identical data).
// parseServerDate handles the naive-UTC server timestamp correctly.
function fmtUpdatedAgo(iso: string | null | undefined): string | null {
  const d = parseServerDate(iso ?? null);
  if (!d) return null;
  const min = Math.floor((Date.now() - d.getTime()) / 60000);
  if (min < 1) return "updated just now";
  if (min < 60) return `updated ${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `updated ${hr}h ago`;
  return `updated ${Math.floor(hr / 24)}d ago`;
}

export function DashboardHeader({
  stats,
  onBrainClick,
}: {
  stats: DashboardStats | undefined;
  onBrainClick: () => void;
}) {
  const { data: whoopStatus } = useQuery<WhoopStatus>({
    queryKey: ["whoop-status"],
    queryFn: fetchWhoopStatus,
  });
  const whoopEnabled = Boolean(whoopStatus?.configured && whoopStatus?.connected);

  const { data: whoop } = useQuery<WhoopToday>({
    queryKey: ["whoop-today"],
    queryFn: () => fetchWhoopToday(),
    enabled: whoopEnabled,
  });

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 16, fontFamily: FONT,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 28, fontWeight: 700, color: "var(--gooni-text, #1C1C1E)",
          letterSpacing: "-0.5px", lineHeight: 1.2,
        }}>
          {getGreeting()}, Daniel.
        </div>
        <div style={{ fontSize: 14, color: "var(--gooni-muted, #8E8E93)", marginTop: 4 }}>
          {getDateStr()}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <GooniAvatar size={36} onClick={onBrainClick} />

          {whoopEnabled && (
            <>
              <Stat
                value={whoop?.recovery_score != null ? `${whoop.recovery_score}%` : "—"}
                label="recovery"
                color={recoveryColor(whoop?.recovery_score ?? null)}
              />
              <Stat
                value={fmtSleep(whoop?.sleep_minutes)}
                label="sleep"
                color="var(--gooni-text, #1C1C1E)"
              />
              <Stat
                value={whoop?.strain != null ? whoop.strain.toFixed(1) : "—"}
                label="strain"
                color="#BA7517"
              />
            </>
          )}

          <Stat
            value={stats?.streak != null ? String(stats.streak) : "—"}
            label="streak"
            color="var(--gooni-text, #1C1C1E)"
          />
        </div>

        {/* Subtle Whoop freshness — when the strap last produced NEW data
            (source_updated_at), not when we polled. */}
        {whoopEnabled && fmtUpdatedAgo(whoop?.source_updated_at) && (
          <span
            title={`Whoop data ${fmtUpdatedAgo(whoop?.source_updated_at)}`}
            style={{ fontSize: 10.5, color: "var(--gooni-faint, #B0B0B5)", letterSpacing: 0.2 }}
          >
            whoop · {fmtUpdatedAgo(whoop?.source_updated_at)}
          </span>
        )}
      </div>
    </div>
  );
}

function Stat({ value, label, color }: {
  value: string; label: string; color: string;
}) {
  return (
    <div style={{
      display: "inline-flex", alignItems: "baseline", gap: 6,
    }}>
      <span style={{
        fontSize: 18, fontWeight: 600, color,
        fontVariantNumeric: "tabular-nums",
      }}>
        {value}
      </span>
      <span style={{
        fontSize: 13, color: "var(--gooni-muted, #8E8E93)",
      }}>
        {label}
      </span>
    </div>
  );
}

// Compact head-only Gooni mascot. Eyes track the cursor so the avatar
// feels alive without needing the full walking-body NeuralBrain that
// used to live here. Click opens the brain-graph modal (kept the
// existing onBrainClick wiring).
function GooniAvatar({ size, onClick }: { size: number; onClick: () => void }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const eyeL = useRef<SVGCircleElement>(null);
  const eyeR = useRef<SVGCircleElement>(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const el = svgRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.hypot(dx, dy) || 1;
      const MAX = 2;
      const t = Math.min(1, dist / 220);
      const transform = `translate(${((dx / dist) * MAX * t).toFixed(2)} ${((dy / dist) * MAX * t).toFixed(2)})`;
      eyeL.current?.setAttribute("transform", transform);
      eyeR.current?.setAttribute("transform", transform);
    }
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  return (
    <svg
      ref={svgRef}
      onClick={onClick}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      style={{ cursor: "pointer", flexShrink: 0, display: "block" }}
      role="button"
      aria-label="Open brain map"
    >
      <circle cx="32" cy="32" r="30" fill="#1A1A1A" />
      <circle cx="32" cy="32" r="22" fill="#F2F2F2" />
      <circle ref={eyeL} cx="25" cy="29" r="3"  fill="#1A1A1A" />
      <circle ref={eyeR} cx="39" cy="29" r="3"  fill="#1A1A1A" />
      <path d="M24 38 Q32 44 40 38" stroke="#1A1A1A" strokeWidth="2.2" fill="none" strokeLinecap="round" />
    </svg>
  );
}
