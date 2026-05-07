import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchClaudeUsage,
  fetchDashboardStats,
  fetchDevActivity,
  fetchDevTake,
  fetchExtendedStats,
  fetchOpenAIUsage,
  fetchTimeOnGooni,
  fetchWhoopStatus,
  fetchWhoopToday,
  type ClaudeUsage,
  type DashboardStats,
  type DayBucket,
  type DevActivity,
  type DevActivityRepo,
  type ExtendedStats,
  type GooniTakePayload,
  type OpenAIUsage,
  type TimeOnGooni,
  type WhoopStatus,
  type WhoopToday,
} from "../services/api";
import { Skeleton } from "./Skeleton";

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
const GREEN = "#30A14E";
const RED = "#CF222E";

// Stats / Activity dashboard. Three sections: OpenAI usage (live month-to-
// date from the Admin API), Dev activity (streak + Gooni's Take + per-repo
// recent commits — all inline; the old click-into-modal flow is gone), and
// general counters (notes, messages, todos). Each section pulls its own
// query so a slow one doesn't block the rest.
export function StatsView() {
  return (
    <div
      style={{
        flex: 1,
        height: "100%",
        overflowY: "auto",
        background: "var(--gooni-bg, #FAFAFA)",
        fontFamily: FONT,
        color: "var(--gooni-text, #1C1C1E)",
      }}
    >
      <div style={{ maxWidth: 880, margin: "0 auto", padding: "40px 32px 80px" }}>
        <div style={{
          fontSize: 13, color: "var(--gooni-muted, #8E8E93)",
          textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600,
          marginBottom: 6,
        }}>
          Stats
        </div>
        <h1 style={{
          fontSize: 28, fontWeight: 700, letterSpacing: "-0.5px",
          margin: 0, marginBottom: 28,
        }}>
          What's happening inside Gooni
        </h1>

        <OpenAISection />
        <ClaudeSection />
        <WhoopSection />
        <DevSection />
        <ActivitySection />
      </div>
    </div>
  );
}

// ── Sections ──────────────────────────────────────────────────────────────

function SectionShell({
  label, children, right,
}: { label: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 36 }}>
      <div style={{
        display: "flex", alignItems: "center", marginBottom: 12,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: 0.6,
          textTransform: "uppercase", color: "var(--gooni-muted, #8E8E93)",
        }}>
          {label}
        </div>
        {right && <div style={{ marginLeft: "auto" }}>{right}</div>}
      </div>
      <div style={{
        background: "var(--gooni-card, #fff)",
        border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
        borderRadius: 12,
        padding: 20,
      }}>
        {children}
      </div>
    </section>
  );
}

function OpenAISection() {
  const { data, isLoading, refetch, isFetching } = useQuery<OpenAIUsage>({
    queryKey: ["openai-usage"],
    queryFn: () => fetchOpenAIUsage(),
    staleTime: 60 * 60_000,
  });

  const refreshButton = (
    <button
      onClick={() => fetchOpenAIUsage(true).then(() => refetch())}
      disabled={isFetching}
      style={{
        fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
        background: "transparent", border: "none", cursor: "pointer",
        padding: 0, fontFamily: FONT,
        opacity: isFetching ? 0.5 : 1,
      }}
    >
      {isFetching ? "refreshing…" : "refresh"}
    </button>
  );

  return (
    <SectionShell label="OpenAI usage — month to date" right={refreshButton}>
      {isLoading && !data ? (
        <SkeletonRow />
      ) : !data?.configured ? (
        <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)", lineHeight: 1.5 }}>
          Set <code style={mono}>OPENAI_ADMIN_KEY</code> on the backend to see
          live usage. Use a key prefixed <code style={mono}>sk-admin-</code> —
          regular API keys can't read org-level usage.
        </div>
      ) : data.error ? (
        <div style={{ fontSize: 13, color: RED }}>
          OpenAI usage error: {data.error}
        </div>
      ) : (
        <>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 14,
          }}>
            <BigStat label="monthly spend" value={`$${(data.spend_usd ?? 0).toFixed(2)}`} />
            <BigStat label="requests" value={fmtInt(data.requests)} />
            <BigStat label="input tokens" value={fmtInt(data.input_tokens)} />
            <BigStat label="output tokens" value={fmtInt(data.output_tokens)} />
          </div>
          {data.by_day && data.by_day.length > 0 && (
            <DailyTokenChart days={data.by_day} title="Daily tokens — month to date" />
          )}
          {data.by_model && data.by_model.length > 0 && (
            <ModelBreakdown rows={data.by_model} />
          )}
        </>
      )}
    </SectionShell>
  );
}

function ClaudeSection() {
  const [days, setDays] = useState<7 | 30 | 90 | 0>(30);
  const { data, isLoading, refetch, isFetching } = useQuery<ClaudeUsage>({
    queryKey: ["claude-usage", days],
    queryFn: () => fetchClaudeUsage(days),
    staleTime: 60 * 60_000,
  });

  // Prod has no JSONLs and (until the uploader runs) no DB rows — hide the
  // section entirely rather than rendering a "not configured" stub. Only
  // hide once the fetch has resolved; while loading we still show the
  // skeleton so dev laptops don't flash empty space on first paint.
  if (data && !data.available) {
    return null;
  }

  const rangeChips = (
    <div style={{ display: "flex", gap: 4 }}>
      {([7, 30, 90, 0] as const).map((d) => (
        <button
          key={d}
          onClick={() => setDays(d)}
          style={{
            fontSize: 11, fontFamily: FONT,
            padding: "2px 8px", borderRadius: 999,
            border: "0.5px solid rgba(0,0,0,0.10)",
            background: days === d ? "rgba(0,0,0,0.08)" : "transparent",
            color: "var(--gooni-text, #1C1C1E)",
            cursor: "pointer",
            fontWeight: days === d ? 600 : 400,
          }}
        >
          {d === 0 ? "all" : `${d}d`}
        </button>
      ))}
      <button
        onClick={() => fetchClaudeUsage(days, true).then(() => refetch())}
        disabled={isFetching}
        style={{
          fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
          background: "transparent", border: "none", cursor: "pointer",
          padding: "2px 6px", fontFamily: FONT,
          opacity: isFetching ? 0.5 : 1,
        }}
      >
        {isFetching ? "…" : "↻"}
      </button>
    </div>
  );

  return (
    <SectionShell
      label="Claude usage — personal (Claude Code)"
      right={rangeChips}
    >
      {isLoading && !data ? (
        <SkeletonRow />
      ) : !data?.configured ? (
        <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)", lineHeight: 1.5 }}>
          No <code style={mono}>~/.claude/projects</code> directory found.
          Override path with <code style={mono}>CLAUDE_PROJECTS_DIR</code> env
          var if Claude Code stores logs elsewhere.
        </div>
      ) : (
        <>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
            gap: 14,
          }}>
            <BigStat label="est. cost" value={`$${(data.est_cost_usd ?? 0).toFixed(2)}`} />
            <BigStat label="sessions" value={fmtInt(data.sessions)} />
            <BigStat label="turns" value={fmtInt(data.turns)} />
            <BigStat label="input" value={fmtInt(data.input_tokens)} />
            <BigStat label="output" value={fmtInt(data.output_tokens)} />
            <BigStat label="cache read" value={fmtInt(data.cache_read_tokens)} />
          </div>
          {data.by_day && data.by_day.length > 0 && (
            <DailyTokenChart
              days={data.by_day}
              title={`Daily tokens — last ${days === 0 ? "all time" : `${days}d`}`}
              showCache
            />
          )}
          {data.by_model && data.by_model.length > 0 && (
            <ClaudeModelBreakdown rows={data.by_model} />
          )}
        </>
      )}
    </SectionShell>
  );
}

function WhoopSection() {
  // Hide whole section unless Whoop is configured AND connected. Avoids
  // rendering empty stubs for users without the integration.
  const { data: status } = useQuery<WhoopStatus>({
    queryKey: ["whoop-status"],
    queryFn: fetchWhoopStatus,
    staleTime: 60 * 60_000,
    retry: false,
  });
  const enabled = !!status?.configured && !!status?.connected;

  const { data, isLoading, refetch, isFetching } = useQuery<WhoopToday>({
    queryKey: ["whoop-today"],
    queryFn: () => fetchWhoopToday(),
    enabled,
    staleTime: 30 * 60_000,
    retry: false,
  });

  if (!status) return null;          // status query in flight
  if (!enabled) return null;          // not configured / not connected

  // Whoop's standard recovery zones: red <34, yellow 34-66, green ≥67.
  function recoveryColor(score: number | null | undefined): string {
    if (score == null) return "#AEAEB2";
    if (score >= 67) return "#30A14E";
    if (score >= 34) return "#E2A26B";
    return "#C76B6B";
  }
  function fmtSleep(min: number | null | undefined): string {
    if (min == null) return "—";
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h}h ${m}m`;
  }

  const refreshButton = (
    <button
      onClick={() => fetchWhoopToday(true).then(() => refetch())}
      disabled={isFetching}
      style={{
        fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
        background: "transparent", border: "none", cursor: "pointer",
        padding: 0, fontFamily: FONT,
        opacity: isFetching ? 0.5 : 1,
      }}
    >
      {isFetching ? "refreshing…" : "refresh"}
    </button>
  );

  const recovery = data?.recovery_score ?? null;
  const ringColor = recoveryColor(recovery);

  return (
    <SectionShell label="Whoop — today" right={refreshButton}>
      {isLoading && !data ? (
        <SkeletonRow />
      ) : !data ? (
        <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)" }}>
          No data yet. Hit refresh after Whoop syncs your latest cycle.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Hero row: recovery ring + headline stats */}
          <div style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
            <RecoveryRing score={recovery} color={ringColor} />
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
              gap: 14, flex: 1, minWidth: 220,
            }}>
              <BigStat label="HRV (ms)" value={data.hrv_rmssd_ms != null ? data.hrv_rmssd_ms.toFixed(1) : "—"} />
              <BigStat label="Resting HR" value={data.resting_hr ?? "—"} />
              <BigStat label="Day strain" value={data.strain != null ? data.strain.toFixed(1) : "—"} />
            </div>
          </div>

          {/* Sleep block */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 14,
            paddingTop: 14,
            borderTop: "0.5px solid var(--gooni-border, rgba(0,0,0,0.06))",
          }}>
            <BigStat label="Sleep" value={fmtSleep(data.sleep_minutes)} />
            <BigStat
              label="Sleep performance"
              value={data.sleep_performance_pct != null ? `${Math.round(data.sleep_performance_pct)}%` : "—"}
            />
          </div>

          {data.updated_at && (
            <div style={{ fontSize: 11, color: "var(--gooni-muted, #8E8E93)" }}>
              updated {relTime(data.updated_at)}
            </div>
          )}
        </div>
      )}
    </SectionShell>
  );
}

function RecoveryRing({ score, color }: { score: number | null; color: string }) {
  // 72px svg ring with the score centered. Stroke is the recovery color so
  // the eye picks up zone at a glance without needing the number.
  const size = 84;
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = score != null ? Math.max(0, Math.min(100, score)) : 0;
  const dash = (pct / 100) * c;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size}>
        <circle
          cx={size / 2} cy={size / 2} r={r}
          stroke="var(--gooni-border, rgba(0,0,0,0.08))"
          strokeWidth={stroke} fill="none"
        />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div style={{
        position: "absolute", inset: 0,
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        fontFamily: FONT,
      }}>
        <div style={{
          fontSize: 22, fontWeight: 700, color,
          fontVariantNumeric: "tabular-nums", lineHeight: 1,
        }}>
          {score != null ? score : "—"}
        </div>
        <div style={{
          fontSize: 9, color: "var(--gooni-muted, #8E8E93)",
          textTransform: "uppercase", letterSpacing: 0.5, marginTop: 3,
        }}>
          recovery
        </div>
      </div>
    </div>
  );
}

function DevSection() {
  const { data: dev, isLoading } = useQuery<DevActivity | null>({
    queryKey: ["dev-activity"],
    queryFn: () => fetchDevActivity().catch(() => null),
  });
  const { data: devTake } = useQuery<GooniTakePayload>({
    queryKey: ["dev-take"],
    queryFn: () => fetchDevTake(),
    staleTime: 30 * 60_000,
  });

  if (isLoading && !dev) {
    return (
      <SectionShell label="Dev activity">
        <SkeletonRow />
      </SectionShell>
    );
  }

  if (!dev || !dev.connected || dev.repos.length === 0) {
    return (
      <SectionShell label="Dev activity">
        <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)" }}>
          GitHub not connected, or no repos tracked. Connect via Settings →
          Integrations.
        </div>
      </SectionShell>
    );
  }

  const { aggregate } = dev;
  const adds = dev.repos.reduce((s, r) => s + (r.today?.additions ?? 0), 0);
  const dels = dev.repos.reduce((s, r) => s + (r.today?.deletions ?? 0), 0);

  return (
    <SectionShell label="Dev activity">
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        gap: 14,
      }}>
        <BigStat label="dev streak" value={String(aggregate.streak_days)} sub="days" />
        <BigStat label="commits today" value={String(aggregate.today_commits)} />
        <BigStat
          label="diff today"
          value={
            <span>
              <span style={{ color: GREEN }}>+{adds}</span>{" "}
              <span style={{ color: RED }}>−{dels}</span>
            </span>
          }
        />
      </div>

      {devTake?.take && (
        <div style={{
          marginTop: 18,
          background: "linear-gradient(180deg, #FAFBFC, #F4F6F8)",
          border: "0.5px solid rgba(0,0,0,0.06)",
          borderRadius: 10, padding: "12px 14px",
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
            textTransform: "uppercase", color: "#8E8E93",
            marginBottom: 6,
          }}>
            Gooni's dev take · {devTake.day}
          </div>
          <div style={{
            fontSize: 13, color: "#3A3A3C", lineHeight: 1.55,
            whiteSpace: "pre-wrap",
          }}>
            {devTake.take}
          </div>
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
          textTransform: "uppercase", color: "#8E8E93", marginBottom: 8,
        }}>
          Recent commits
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {dev.repos.map((r) => (
            <RepoRow key={`${r.owner}/${r.name}`} repo={r} />
          ))}
        </div>
      </div>
    </SectionShell>
  );
}

function ActivitySection() {
  const { data: stats, isLoading } = useQuery<DashboardStats>({
    queryKey: ["dashboard-stats"],
    queryFn: fetchDashboardStats,
  });
  const { data: ext } = useQuery<ExtendedStats>({
    queryKey: ["dashboard-stats-ext"],
    queryFn: fetchExtendedStats,
  });
  // Fetched separately because the GitHub API call adds ~200ms; we don't
  // want to block the dashboard render on it.
  const { data: timeOnGooni } = useQuery<TimeOnGooni>({
    queryKey: ["dashboard-time-on-gooni"],
    queryFn: fetchTimeOnGooni,
    staleTime: 5 * 60 * 1000,  // 5 min — GitHub data doesn't change often
  });

  if (isLoading && !stats) {
    return (
      <SectionShell label="Activity">
        <SkeletonRow />
      </SectionShell>
    );
  }

  // Unified tile grid — every stat is a same-sized card with a colored
  // category dot. Earlier layout nested per-category mini-grids, which
  // produced sparse half-empty rows (e.g. day-streak alone, claude alone).
  // Keeping category context via the dot + tag is enough to scan by domain
  // without breaking the visual rhythm.
  return (
    <SectionShell label="Activity">
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
        gap: 10,
      }}>
        <ActivityTile category="time" categoryColor="#7B8FE6"
          label="day streak" value={fmtInt(stats?.streak)} sub="days" />
        <ActivityTile category="notes" categoryColor="#A879D6"
          label="this week" value={fmtInt(stats?.notes_this_week)}
          delta={
            stats?.notes_this_week != null && stats?.notes_last_week != null
              ? stats.notes_this_week - stats.notes_last_week
              : undefined
          } />
        <ActivityTile category="notes" categoryColor="#A879D6"
          label="total" value={fmtInt(ext?.notes_total)} />
        <ActivityTile category="chat" categoryColor="#5DAE8B"
          label="messages this week" value={fmtInt(ext?.user_messages_this_week)} />
        <ActivityTile category="chat" categoryColor="#5DAE8B"
          label="messages total" value={fmtInt(ext?.user_messages_total)} />
        <ActivityTile category="chat" categoryColor="#5DAE8B"
          label="conversations" value={fmtInt(ext?.conversations_total)} />
        <ActivityTile category="lists" categoryColor="#E2A26B"
          label="checked this week" value={fmtInt(ext?.todos_done_this_week)} />
        <ActivityTile category="lists" categoryColor="#E2A26B"
          label="open" value={fmtInt(ext?.todos_open)} />
        <ActivityTile category="claude" categoryColor="#C76B6B"
          label="calls (24h)" value={fmtInt(stats?.mcp_calls_today)} />
        <ActivityTile category="focus-cam" categoryColor="#5B8BC4"
          label="sessions total"
          value={fmtInt(stats?.focus_cam_sessions_total)} />
        <ActivityTile category="focus-cam" categoryColor="#5B8BC4"
          label="7-day avg score"
          value={
            stats?.focus_cam_7d_avg_score == null
              ? "—"
              : stats.focus_cam_7d_avg_score.toFixed(0)
          } />
        <ActivityTile category="gooni" categoryColor="#A879D6"
          label="time today (commits)"
          value={fmtMinutes(timeOnGooni?.today_minutes)}
          sub={
            timeOnGooni?.today_sessions
              ? `${timeOnGooni.today_sessions} session${timeOnGooni.today_sessions === 1 ? "" : "s"}`
              : undefined
          } />
        <ActivityTile category="gooni" categoryColor="#A879D6"
          label="time this week"
          value={fmtMinutes(timeOnGooni?.week_minutes)}
          sub={
            timeOnGooni?.week_sessions
              ? `${timeOnGooni.week_sessions} sessions`
              : undefined
          } />
      </div>
    </SectionShell>
  );
}

function fmtMinutes(m: number | undefined): string {
  if (m == null || m === 0) return "—";
  if (m < 60) return `${Math.round(m)}m`;
  const h = Math.floor(m / 60);
  const rem = Math.round(m - h * 60);
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

function ActivityTile({
  category, categoryColor, label, value, sub, delta,
}: {
  category: string;
  categoryColor: string;
  label: string;
  value: React.ReactNode;
  sub?: string;
  delta?: number;
}) {
  let deltaLine: React.ReactNode = null;
  if (typeof delta === "number") {
    const isFlat = delta === 0;
    const isUp = delta > 0;
    deltaLine = (
      <div style={{
        fontSize: 10.5,
        color: isFlat ? "#AEAEB2" : isUp ? "#2B8C4D" : "#C76B6B",
        marginTop: 4, fontVariantNumeric: "tabular-nums",
      }}>
        {isFlat ? "→" : isUp ? "↑" : "↓"} {Math.abs(delta)} from last week
      </div>
    );
  }
  return (
    <div style={{
      border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
      borderRadius: 10,
      padding: "12px 14px",
      background: "var(--gooni-card-soft, rgba(0,0,0,0.015))",
      display: "flex",
      flexDirection: "column",
      minHeight: 88,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{
          width: 6, height: 6, borderRadius: "50%",
          background: categoryColor, flexShrink: 0,
        }} />
        <span style={{
          fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5,
          textTransform: "uppercase", color: "var(--gooni-muted, #8E8E93)",
        }}>{category}</span>
      </div>
      <div style={{
        fontSize: 10.5, color: "var(--gooni-muted, #8E8E93)",
        textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600,
        marginBottom: 4,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 24, fontWeight: 600,
        color: "var(--gooni-text, #1C1C1E)", lineHeight: 1.1,
        fontVariantNumeric: "tabular-nums",
      }}>
        {value ?? "—"}
        {sub && (
          <span style={{
            fontSize: 11, fontWeight: 500, color: "var(--gooni-muted, #8E8E93)",
            marginLeft: 4,
          }}>{sub}</span>
        )}
      </div>
      {deltaLine}
    </div>
  );
}

// ── Atoms ─────────────────────────────────────────────────────────────────

function BigStat({
  label, value, sub, delta,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  // Week-over-week delta. Renders a small "↑ N from last week" / "↓ N" /
  // "→ flat" line under the value. Hidden when undefined.
  delta?: number;
}) {
  let deltaLine: React.ReactNode = null;
  if (typeof delta === "number") {
    const isFlat = delta === 0;
    const isUp = delta > 0;
    deltaLine = (
      <div style={{
        fontSize: 10.5,
        color: isFlat ? "#AEAEB2" : isUp ? "#2B8C4D" : "#C76B6B",
        marginTop: 2, fontVariantNumeric: "tabular-nums",
      }}>
        {isFlat ? "→" : isUp ? "↑" : "↓"} {Math.abs(delta)} from last week
      </div>
    );
  }
  return (
    <div>
      <div style={{
        fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
        textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 22, fontWeight: 600, marginTop: 2,
        color: "var(--gooni-text, #1C1C1E)", lineHeight: 1.1,
        fontVariantNumeric: "tabular-nums",
      }}>
        {value ?? "—"}
        {sub && (
          <span style={{
            fontSize: 11, fontWeight: 500, color: "var(--gooni-muted, #8E8E93)",
            marginLeft: 4,
          }}>{sub}</span>
        )}
      </div>
      {deltaLine}
    </div>
  );
}

function ModelBreakdown({ rows }: { rows: NonNullable<OpenAIUsage["by_model"]> }) {
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
        textTransform: "uppercase", color: "#8E8E93", marginBottom: 8,
      }}>
        By model
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "1.6fr 0.8fr 0.9fr 0.9fr 0.9fr",
        rowGap: 6, columnGap: 12,
        fontSize: 12,
        fontVariantNumeric: "tabular-nums",
      }}>
        <Cell head>model</Cell>
        <Cell head right>requests</Cell>
        <Cell head right>in</Cell>
        <Cell head right>out</Cell>
        <Cell head right>total</Cell>
        {rows.map((r) => (
          <ModelRow key={`${r.kind}-${r.model}`} row={r} />
        ))}
      </div>
    </div>
  );
}

function ModelRow({ row }: { row: NonNullable<OpenAIUsage["by_model"]>[number] }) {
  return (
    <>
      <Cell>
        <span style={{ fontFamily: "'SF Mono', Menlo, monospace", fontSize: 11.5 }}>
          {row.model}
        </span>
        <span style={{
          marginLeft: 6, fontSize: 10, color: "#8E8E93",
          textTransform: "uppercase", letterSpacing: 0.4,
        }}>
          {row.kind}
        </span>
      </Cell>
      <Cell right>{fmtInt(row.requests)}</Cell>
      <Cell right>{fmtInt(row.input_tokens)}</Cell>
      <Cell right>{row.kind === "embedding" ? "—" : fmtInt(row.output_tokens)}</Cell>
      <Cell right>{fmtInt(row.total_tokens)}</Cell>
    </>
  );
}

// Inline SVG bar chart. Stacks input + output (+ optional cache_read +
// cache_creation) per day. No chart lib — keeps the bundle small and
// the styling fully theme-token aware. ResizeObserver isn't needed
// since we render a fixed-aspect viewBox + scale to 100% width.
function DailyTokenChart({
  days, title, showCache,
}: { days: DayBucket[]; title: string; showCache?: boolean }) {
  if (!days.length) return null;
  const VIEW_W = 800;
  const VIEW_H = 180;
  const PAD_L = 44;
  const PAD_R = 8;
  const PAD_T = 8;
  const PAD_B = 24;

  const COLOR_INPUT = "#3B82F6";
  const COLOR_OUTPUT = "#A855F7";
  const COLOR_CACHE_READ = "#10B981";
  const COLOR_CACHE_CREATE = "#F59E0B";

  const totals = days.map((d) =>
    d.input + d.output + (showCache ? (d.cache_read ?? 0) + (d.cache_creation ?? 0) : 0)
  );
  const max = Math.max(1, ...totals);
  const innerW = VIEW_W - PAD_L - PAD_R;
  const innerH = VIEW_H - PAD_T - PAD_B;
  const barW = Math.max(2, innerW / days.length - 2);

  function y(v: number): number {
    return PAD_T + innerH - (v / max) * innerH;
  }

  const tickValues = [0, max / 2, max];
  function fmtAbbr(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(Math.round(n));
  }

  return (
    <div style={{ marginTop: 22 }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 8,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
          textTransform: "uppercase", color: "#8E8E93",
        }}>
          {title}
        </div>
        <div style={{ display: "flex", gap: 10, fontSize: 10.5, color: "#6B6B70" }}>
          <Legend color={COLOR_INPUT} label="input" />
          <Legend color={COLOR_OUTPUT} label="output" />
          {showCache && <Legend color={COLOR_CACHE_READ} label="cache read" />}
          {showCache && <Legend color={COLOR_CACHE_CREATE} label="cache create" />}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: 180, display: "block" }}
      >
        {/* Y-axis ticks */}
        {tickValues.map((v) => (
          <g key={v}>
            <line
              x1={PAD_L} x2={VIEW_W - PAD_R}
              y1={y(v)} y2={y(v)}
              stroke="rgba(0,0,0,0.06)"
              strokeWidth={1}
            />
            <text
              x={PAD_L - 6} y={y(v) + 3}
              textAnchor="end"
              fontSize={9}
              fill="#8E8E93"
              fontFamily="'SF Mono', Menlo, monospace"
            >{fmtAbbr(v)}</text>
          </g>
        ))}

        {/* Stacked bars */}
        {days.map((d, i) => {
          const x = PAD_L + i * (innerW / days.length) + 1;
          let stackTopValue = 0;
          const stack: { color: string; v: number }[] = [
            { color: COLOR_INPUT, v: d.input },
            { color: COLOR_OUTPUT, v: d.output },
          ];
          if (showCache) {
            stack.push({ color: COLOR_CACHE_READ, v: d.cache_read ?? 0 });
            stack.push({ color: COLOR_CACHE_CREATE, v: d.cache_creation ?? 0 });
          }
          return (
            <g key={d.date}>
              {stack.map((seg, idx) => {
                if (seg.v <= 0) return null;
                const yTop = y(stackTopValue + seg.v);
                const h = y(stackTopValue) - yTop;
                stackTopValue += seg.v;
                return (
                  <rect
                    key={idx}
                    x={x} y={yTop}
                    width={barW} height={Math.max(0.5, h)}
                    fill={seg.color}
                    rx={1}
                  >
                    <title>{`${d.date} · ${fmtAbbr(seg.v)} ${["input","output","cache read","cache create"][idx]}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}

        {/* X-axis: first / mid / last date labels only — keeps it readable
            even on a 90d window. */}
        {[0, Math.floor(days.length / 2), days.length - 1]
          .filter((v, i, a) => a.indexOf(v) === i)
          .map((idx) => {
            const d = days[idx];
            if (!d) return null;
            const x = PAD_L + idx * (innerW / days.length) + barW / 2 + 1;
            return (
              <text
                key={d.date}
                x={x} y={VIEW_H - 6}
                textAnchor="middle"
                fontSize={9.5}
                fill="#8E8E93"
                fontFamily={FONT}
              >{d.date.slice(5)}</text>
            );
          })}
      </svg>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={{
        width: 8, height: 8, borderRadius: 2, background: color,
        display: "inline-block",
      }} />
      <span>{label}</span>
    </span>
  );
}

function ClaudeModelBreakdown({
  rows,
}: { rows: NonNullable<ClaudeUsage["by_model"]> }) {
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
        textTransform: "uppercase", color: "#8E8E93", marginBottom: 8,
      }}>
        By model
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "1.6fr 0.7fr 0.8fr 0.8fr 0.9fr 0.9fr",
        rowGap: 6, columnGap: 12,
        fontSize: 12,
        fontVariantNumeric: "tabular-nums",
      }}>
        <Cell head>model</Cell>
        <Cell head right>turns</Cell>
        <Cell head right>in</Cell>
        <Cell head right>out</Cell>
        <Cell head right>cache rd</Cell>
        <Cell head right>est. cost</Cell>
        {rows.map((r) => (
          <span key={r.model} style={{ display: "contents" }}>
            <Cell>
              <span style={{ fontFamily: "'SF Mono', Menlo, monospace", fontSize: 11.5 }}>
                {r.model}
              </span>
            </Cell>
            <Cell right>{fmtInt(r.turns)}</Cell>
            <Cell right>{fmtInt(r.input)}</Cell>
            <Cell right>{fmtInt(r.output)}</Cell>
            <Cell right>{fmtInt(r.cache_read)}</Cell>
            <Cell right>${r.est_cost_usd.toFixed(2)}</Cell>
          </span>
        ))}
      </div>
    </div>
  );
}

function Cell({
  children, head, right,
}: { children: React.ReactNode; head?: boolean; right?: boolean }) {
  return (
    <div style={{
      textAlign: right ? "right" : "left",
      color: head ? "#8E8E93" : "var(--gooni-text, #1C1C1E)",
      fontWeight: head ? 600 : 400,
      fontSize: head ? 10.5 : 12,
      letterSpacing: head ? 0.4 : 0,
      textTransform: head ? "uppercase" : "none",
    }}>
      {children}
    </div>
  );
}

function RepoRow({ repo }: { repo: DevActivityRepo }) {
  const today = repo.today;
  const recent = (repo.recent ?? []).slice(0, 4);
  return (
    <div>
      <div style={{
        display: "flex", alignItems: "baseline", gap: 8,
        fontSize: 13, color: "var(--gooni-text, #1C1C1E)",
      }}>
        <span style={{ fontWeight: 600 }}>{repo.owner}/{repo.name}</span>
        {today && today.commits > 0 ? (
          <span style={{ fontSize: 11, color: "#6B6B70", display: "flex", gap: 6 }}>
            <span>{today.commits} today</span>
            <span style={{ color: GREEN }}>+{today.additions}</span>
            <span style={{ color: RED }}>−{today.deletions}</span>
            <span>· {repo.streak_days ?? 0}d</span>
          </span>
        ) : (
          <span style={{ fontSize: 11, color: "#8E8E93" }}>
            0 today · {repo.streak_days ?? 0}d
          </span>
        )}
      </div>
      {recent.length > 0 && (
        <div style={{ marginTop: 5, display: "flex", flexDirection: "column", gap: 3 }}>
          {recent.map((c) => (
            <a
              key={c.sha}
              href={c.html_url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "flex", alignItems: "baseline", gap: 8,
                textDecoration: "none", color: "inherit",
                fontSize: 12,
              }}
            >
              <span style={{
                color: "#AEAEB2", fontFamily: "ui-monospace, monospace",
                flexShrink: 0,
              }}>─</span>
              <span style={{
                color: "#3A3A3C", flex: 1,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {c.subject}
              </span>
              <span style={{ color: "#AEAEB2", fontSize: 11, flexShrink: 0 }}>
                {relTime(c.committed_at)}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function SkeletonRow() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Skeleton width="60%" height={16} />
      <Skeleton width="80%" height={12} />
      <Skeleton width="55%" height={12} />
    </div>
  );
}

const mono: React.CSSProperties = {
  fontFamily: "'SF Mono', Menlo, monospace",
  background: "rgba(0,0,0,0.05)",
  padding: "1px 5px", borderRadius: 4, fontSize: 11.5,
};

function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}
