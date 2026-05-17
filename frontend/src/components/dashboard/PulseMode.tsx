import { useQuery } from "@tanstack/react-query";
import {
  fetchWhoopStatus, fetchWhoopToday,
  fetchLeetcodeToday, fetchHabits, fetchDevActivity,
  fetchDashboardStats,
  type WhoopStatus, type WhoopToday,
  type LeetcodeToday, type ApiHabit,
  type DevActivity, type DashboardStats,
} from "../../services/api";

// PulseMode — life-stats grid. Consistent stat-card chrome across:
//   Whoop (recovery/sleep/strain)  · LeetCode (streak/today)
//   Habits (longest streak)        · Writing velocity (notes/week)
//   GitHub commits (today)         · Gooni engagement (chat msgs)
//
// Each card: small label + big number + sub-line. No fancy trend
// strips for v1 — that's a follow-up that needs the snapshot table.

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

export function PulseMode() {
  const { data: whoopStatus } = useQuery<WhoopStatus>({
    queryKey: ["whoop-status"], queryFn: fetchWhoopStatus,
  });
  const whoopOn = Boolean(whoopStatus?.configured && whoopStatus?.connected);
  const { data: whoop } = useQuery<WhoopToday>({
    queryKey: ["whoop-today"], queryFn: () => fetchWhoopToday(),
    enabled: whoopOn,
  });

  const { data: leetcode } = useQuery<LeetcodeToday>({
    queryKey: ["leetcode-today"], queryFn: () => fetchLeetcodeToday(),
  });

  const { data: habits = [] } = useQuery<ApiHabit[]>({
    queryKey: ["habits"], queryFn: fetchHabits,
  });
  const longestStreak = habits.reduce((m, h) => Math.max(m, h.streak), 0);

  const { data: dev } = useQuery<DevActivity>({
    queryKey: ["dev-activity"], queryFn: fetchDevActivity,
  });

  const { data: stats } = useQuery<DashboardStats>({
    queryKey: ["dashboard-stats"], queryFn: fetchDashboardStats,
  });

  return (
    <div style={{ fontFamily: FONT }}>
      <div style={{
        fontSize: 11, fontWeight: 500, color: "var(--gooni-muted, #8E8E93)",
        letterSpacing: 0.4, textTransform: "uppercase",
        marginBottom: 10, padding: "0 2px",
      }}>
        Pulse
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        gap: 10,
      }}>
        <StatCard
          label="recovery"
          value={whoop?.recovery_score != null ? `${whoop.recovery_score}%` : "—"}
          sub={whoop?.hrv_rmssd_ms != null ? `${Math.round(whoop.hrv_rmssd_ms)}ms HRV` : "—"}
          tint="#0F6E56"
          dim={!whoopOn}
        />
        <StatCard
          label="sleep"
          value={
            whoop?.sleep_minutes != null
              ? `${Math.floor(whoop.sleep_minutes / 60)}h ${whoop.sleep_minutes % 60}m`
              : "—"
          }
          sub={whoop?.sleep_performance_pct != null ? `${whoop.sleep_performance_pct}% of need` : "—"}
          tint="#3B82F6"
          dim={!whoopOn}
        />
        <StatCard
          label="strain"
          value={whoop?.strain != null ? whoop.strain.toFixed(1) : "—"}
          sub={whoop?.resting_hr != null ? `${whoop.resting_hr} bpm RHR` : "—"}
          tint="#A855F7"
          dim={!whoopOn}
        />

        <StatCard
          label="leetcode streak"
          value={leetcode?.streak != null ? `${leetcode.streak}d` : "—"}
          sub={leetcode?.today_count != null ? `${leetcode.today_count} today` : "—"}
          tint="#22C55E"
        />
        <StatCard
          label="habit streak"
          value={longestStreak > 0 ? `${longestStreak}d` : "—"}
          sub={`${habits.length} habit${habits.length === 1 ? "" : "s"} tracked`}
          tint="#F97316"
        />
        <StatCard
          label="day streak"
          value={stats?.streak != null ? `${stats.streak}` : "—"}
          sub="gooni activity"
          tint="#EC4899"
        />

        <StatCard
          label="commits today"
          value={dev?.aggregate?.today_commits != null ? `${dev.aggregate.today_commits}` : "—"}
          sub={`${dev?.repos?.length ?? 0} repo${dev?.repos?.length === 1 ? "" : "s"}`}
          tint="#14B8A6"
        />
        <StatCard
          label="commit streak"
          value={dev?.aggregate?.streak_days != null ? `${dev.aggregate.streak_days}d` : "—"}
          sub="across tracked repos"
          tint="#06B6D4"
        />
        <StatCard
          label="claude turns"
          value={stats?.mcp_calls_today != null ? `${stats.mcp_calls_today}` : "—"}
          sub="today's mcp calls"
          tint="#84CC16"
        />
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, tint, dim }: {
  label: string; value: string; sub: string; tint: string; dim?: boolean;
}) {
  return (
    <div style={{
      background: "var(--gooni-card, #fff)",
      border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.10))",
      borderRadius: 12,
      padding: "12px 14px",
      borderLeft: `2px solid ${tint}`,
      opacity: dim ? 0.5 : 1,
      minHeight: 78,
      display: "flex", flexDirection: "column", justifyContent: "space-between",
    }}>
      <div style={{
        fontSize: 10, color: "var(--gooni-muted, #8E8E93)",
        letterSpacing: 0.4, textTransform: "uppercase",
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 22, fontWeight: 600,
        color: "var(--gooni-text, #1C1C1E)",
        fontVariantNumeric: "tabular-nums", lineHeight: 1.1,
      }}>
        {value}
      </div>
      <div style={{
        fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
      }}>
        {sub}
      </div>
    </div>
  );
}
