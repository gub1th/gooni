import { useQuery } from "@tanstack/react-query";
import {
  fetchDashboardStats,
  fetchDevActivity,
  fetchHabits,
  fetchLeetcodeToday,
  type ApiHabit,
  type DashboardStats,
  type DevActivity,
  type LeetcodeToday,
} from "../../services/api";
import {
  SectionShell,
  WhoopSection,
  LeetcodeSection,
  DevSection,
  ActivitySection,
} from "../StatsView";
import { UsageCards } from "../UsageCards";
import { FONT } from "../../ui";

// StatsMode — the merged Stats tab. Absorbs the old Pulse mode AND
// the standalone sidebar StatsView page into one surface. Reorganized
// from a flat grid into a clear visual hierarchy (top → bottom):
//   1. Health (Whoop)          — primary daily signal, prominent
//   2. Streaks                  — at-a-glance motivational row
//   3. Dev activity             — what shipped today (Dev Take + commits)
//   4. LeetCode                 — practice tracker w/ heatmap
//   5. Usage                    — OpenAI / Claude reference data
//   6. Activity                 — full grid of secondary counters
//
// Each section is the existing StatsView component reused as-is. The
// only new piece is StreaksSection (a compact 4-card row) and the
// reordering. Per-section freshness still renders inside each section
// where the underlying data exposes `updated_at`.


export function StatsMode() {
  return (
    <div style={{ fontFamily: FONT, color: "var(--gooni-text, #1C1C1E)" }}>
      <WhoopSection />
      <StreaksSection />
      <DevSection />
      <LeetcodeSection />
      <UsageCards />
      <ActivitySection />
    </div>
  );
}

// ── streaks row ──────────────────────────────────────────────────────
//
// Compact, equal-weight row of streak cards. These are motivational
// numbers — at-a-glance signal that habits/practice/commits are on.

function StreaksSection() {
  const { data: stats } = useQuery<DashboardStats>({
    queryKey: ["dashboard-stats"], queryFn: fetchDashboardStats,
  });
  const { data: leetcode } = useQuery<LeetcodeToday>({
    queryKey: ["leetcode-today"], queryFn: () => fetchLeetcodeToday(),
    staleTime: 30 * 60_000, retry: false,
  });
  const { data: habits = [] } = useQuery<ApiHabit[]>({
    queryKey: ["habits"], queryFn: fetchHabits,
  });
  const { data: dev } = useQuery<DevActivity>({
    queryKey: ["dev-activity"], queryFn: () => fetchDevActivity(),
  });

  const longestHabit = habits.reduce((m, h) => Math.max(m, h.streak), 0);

  return (
    <SectionShell label="Streaks">
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
        gap: 14,
      }}>
        <StreakCard label="day streak"     value={stats?.streak} suffix="d" />
        <StreakCard label="leetcode"        value={leetcode?.streak} suffix="d" />
        <StreakCard label="habit streak"    value={longestHabit > 0 ? longestHabit : null} suffix="d" />
        <StreakCard label="commit streak"   value={dev?.aggregate?.streak_days} suffix="d" />
      </div>
    </SectionShell>
  );
}

function StreakCard({ label, value, suffix }: {
  label: string;
  value: number | null | undefined;
  suffix?: string;
}) {
  const display = value != null && value > 0
    ? `${value}${suffix ?? ""}`
    : "—";
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
        textTransform: "uppercase",
        color: "var(--gooni-muted, #8E8E93)",
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 22, fontWeight: 600,
        color: "var(--gooni-text, #1C1C1E)",
        fontVariantNumeric: "tabular-nums", lineHeight: 1.1,
      }}>
        {display}
      </div>
    </div>
  );
}
