import { useQuery } from "@tanstack/react-query";
import {
  fetchDashboardStats,
  fetchDevActivity,
  fetchDevTake,
  fetchExtendedStats,
  fetchLeetcodeToday,
  fetchTimeOnGooni,
  fetchWhoopStatus,
  fetchWhoopToday,
  parseDevTake,
  type DashboardStats,
  type DevActivity,
  type DevActivityRepo,
  type ExtendedStats,
  type GooniTakePayload,
  type LeetcodeToday,
  type TimeOnGooni,
  type WhoopStatus,
  type WhoopToday,
} from "../services/api";
import { Skeleton } from "./Skeleton";
import { UsageCards } from "./UsageCards";

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

        {/* OpenAI/Claude usage — today + this month tiles w/ provider toggle.
            Replaces the previous OpenAISection + ClaudeSection (rich monthly
            spend + daily token chart + per-model breakdown) — Daniel preferred
            the dashboard's compact tile view as the single source of truth. */}
        <UsageCards />
        <WhoopSection />
        <LeetcodeSection />
        <DevSection />
        <ActivitySection />
      </div>
    </div>
  );
}

// ── Sections ──────────────────────────────────────────────────────────────

export function FreshnessActions({
  updatedAt, isFetching, onRefresh,
}: {
  updatedAt: string | null | undefined;
  isFetching: boolean;
  onRefresh: () => void;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
      fontFamily: FONT,
    }}>
      {updatedAt && <span>updated {relTime(updatedAt)}</span>}
      {updatedAt && <span style={{ opacity: 0.5 }}>·</span>}
      <button
        onClick={onRefresh}
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
    </div>
  );
}

export function SectionShell({
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

export function WhoopSection() {
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

  const headerActions = (
    <FreshnessActions
      updatedAt={data?.updated_at}
      isFetching={isFetching}
      onRefresh={() => fetchWhoopToday(true).then(() => refetch())}
    />
  );

  const recovery = data?.recovery_score ?? null;
  const ringColor = recoveryColor(recovery);

  return (
    <SectionShell label="Whoop — today" right={headerActions}>
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

export function LeetcodeSection() {
  const { data, isLoading, refetch, isFetching } = useQuery<LeetcodeToday>({
    queryKey: ["leetcode-today"],
    queryFn: () => fetchLeetcodeToday(),
    staleTime: 30 * 60_000,
    retry: false,
  });

  const headerActions = (
    <FreshnessActions
      updatedAt={data?.updated_at}
      isFetching={isFetching}
      onRefresh={() => fetchLeetcodeToday(true).then(() => refetch())}
    />
  );

  if (isLoading && !data) {
    return (
      <SectionShell label="LeetCode" right={headerActions}>
        <SkeletonRow />
      </SectionShell>
    );
  }

  if (!data?.available) {
    return (
      <SectionShell label="LeetCode" right={headerActions}>
        <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)" }}>
          No snapshot yet. LeetCode may have rate-limited the public profile
          query — refresh later.
        </div>
      </SectionShell>
    );
  }

  return (
    <SectionShell
      label={`LeetCode${data.username ? ` · ${data.username}` : ""}`}
      right={headerActions}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: 14,
        }}>
          <BigStat label="streak" value={fmtInt(data.streak)} sub="days" />
          <BigStat label="today" value={fmtInt(data.today_count)} sub="subs" />
          <BigStat label="past 7 days" value={fmtInt(data.week_count)} sub="subs" />
          <BigStat label="solved" value={fmtInt(data.total_solved)} />
        </div>

        {(data.easy_solved != null || data.medium_solved != null || data.hard_solved != null) && (
          <div style={{
            display: "flex", gap: 14, flexWrap: "wrap",
            fontSize: 12, color: "#3A3A3C",
            paddingTop: 12,
            borderTop: "0.5px solid var(--gooni-border, rgba(0,0,0,0.06))",
          }}>
            <span><span style={{ color: "#30A14E", fontWeight: 600 }}>easy</span> {fmtInt(data.easy_solved)}</span>
            <span><span style={{ color: "#E2A26B", fontWeight: 600 }}>med</span> {fmtInt(data.medium_solved)}</span>
            <span><span style={{ color: "#C76B6B", fontWeight: 600 }}>hard</span> {fmtInt(data.hard_solved)}</span>
            {data.ranking != null && (
              <span style={{ marginLeft: "auto", color: "#8E8E93" }}>
                global rank {data.ranking.toLocaleString()}
              </span>
            )}
          </div>
        )}

        <Heatmap calendar={data.calendar ?? {}} />
      </div>
    </SectionShell>
  );
}

// 53-week × 7-day heatmap, GitHub-style. Today is the bottom-right cell of
// the rightmost column. Each cell maps a UTC midnight unix timestamp to its
// submission count via `calendar`. Color buckets are eyeballed against
// LeetCode's own profile heatmap (0 / 1-2 / 3-5 / 6-9 / 10+).
function Heatmap({ calendar }: { calendar: Record<string, number> }) {
  const WEEKS = 53;
  const DAYS = 7;
  const CELL = 11;
  const GAP = 2;

  // Walk back from today (UTC) so each column = ISO week (Mon-Sun).
  const today = new Date();
  // Anchor on UTC midnight today.
  const todayUtc = new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(),
  ));

  const cells: { ts: number; count: number; date: Date }[] = [];
  const totalDays = WEEKS * DAYS;
  for (let i = totalDays - 1; i >= 0; i--) {
    const d = new Date(todayUtc);
    d.setUTCDate(d.getUTCDate() - i);
    const ts = Math.floor(d.getTime() / 1000);
    const count = Number(calendar[String(ts)] ?? 0);
    cells.push({ ts, count, date: d });
  }

  function cellColor(count: number): string {
    if (count <= 0) return "var(--gooni-border, rgba(0,0,0,0.06))";
    if (count < 3) return "#C6E6CF";
    if (count < 6) return "#7FCB97";
    if (count < 10) return "#3FA968";
    return "#1F7A45";
  }

  // Month labels above the columns. Drop in a label whenever the first cell
  // of a column starts a new month — cheap heuristic that mostly mirrors
  // GitHub's layout without overlapping.
  const monthLabels: { col: number; label: string }[] = [];
  let lastMonth = -1;
  for (let col = 0; col < WEEKS; col++) {
    const cell = cells[col * DAYS];
    if (!cell) continue;
    const m = cell.date.getUTCMonth();
    if (m !== lastMonth) {
      monthLabels.push({
        col,
        label: cell.date.toLocaleString("en-US", { month: "short" }),
      });
      lastMonth = m;
    }
  }

  const gridWidth = WEEKS * (CELL + GAP);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{
        position: "relative", height: 12,
        width: gridWidth, fontSize: 9.5, color: "#8E8E93",
      }}>
        {monthLabels.map((m) => (
          <span
            key={`${m.col}-${m.label}`}
            style={{
              position: "absolute",
              left: m.col * (CELL + GAP),
              top: 0,
            }}
          >
            {m.label}
          </span>
        ))}
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: `repeat(${WEEKS}, ${CELL}px)`,
        gridTemplateRows: `repeat(${DAYS}, ${CELL}px)`,
        columnGap: GAP, rowGap: GAP,
        gridAutoFlow: "column",
      }}>
        {cells.map((c, idx) => (
          <div
            key={idx}
            title={`${c.date.toISOString().slice(0, 10)} · ${c.count} submission${c.count === 1 ? "" : "s"}`}
            style={{
              width: CELL, height: CELL, borderRadius: 2,
              background: cellColor(c.count),
            }}
          />
        ))}
      </div>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        fontSize: 10, color: "#8E8E93", marginTop: 2,
      }}>
        <span>less</span>
        {[0, 1, 4, 8, 12].map((n) => (
          <span
            key={n}
            style={{
              width: CELL, height: CELL, borderRadius: 2,
              background: cellColor(n), display: "inline-block",
            }}
          />
        ))}
        <span>more</span>
      </div>
    </div>
  );
}


export function DevSection() {
  const { data: dev, isLoading, refetch, isFetching } = useQuery<DevActivity | null>({
    queryKey: ["dev-activity"],
    queryFn: () => fetchDevActivity().catch(() => null),
  });
  const { data: devTake } = useQuery<GooniTakePayload>({
    queryKey: ["dev-take"],
    queryFn: () => fetchDevTake(),
    staleTime: 30 * 60_000,
  });

  const headerActions = (
    <FreshnessActions
      updatedAt={dev?.fetched_at}
      isFetching={isFetching}
      onRefresh={() => fetchDevActivity(true).then(() => refetch())}
    />
  );

  if (isLoading && !dev) {
    return (
      <SectionShell label="Dev activity" right={headerActions}>
        <SkeletonRow />
      </SectionShell>
    );
  }

  if (!dev || !dev.connected || dev.repos.length === 0) {
    return (
      <SectionShell label="Dev activity" right={headerActions}>
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
    <SectionShell label="Dev activity" right={headerActions}>
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

      {devTake?.take && (() => {
        const view = parseDevTake(devTake.take);
        return (
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
            {view.kind === "themes" ? (
              // Theme chip stacks ABOVE the body. Variable-width chips
              // ("Public app UX" vs "Data migrations and reliability")
              // used to push the body into a jagged left edge —
              // vertical layout puts every body block at the same x.
              <ul style={{
                margin: 0, padding: 0, listStyle: "none",
                display: "flex", flexDirection: "column", gap: 12,
              }}>
                {view.themes.map((t) => (
                  <li key={t.theme} style={{
                    display: "flex", flexDirection: "column", gap: 4,
                    fontSize: 13, lineHeight: 1.5, color: "#3A3A3C",
                  }}>
                    <span style={{
                      alignSelf: "flex-start",
                      fontSize: 10.5, fontWeight: 600, letterSpacing: 0.3,
                      color: "#1C1C1E",
                      background: "rgba(0,0,0,0.05)",
                      padding: "1.5px 7px", borderRadius: 99,
                    }}>
                      {t.theme}
                    </span>
                    <span>{t.summary}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div style={{
                fontSize: 13, color: "#3A3A3C", lineHeight: 1.55,
                whiteSpace: "pre-wrap",
              }}>
                {devTake.take}
              </div>
            )}
          </div>
        );
      })()}

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

export function ActivitySection() {
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

export function BigStat({
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

export function SkeletonRow() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Skeleton width="60%" height={16} />
      <Skeleton width="80%" height={12} />
      <Skeleton width="55%" height={12} />
    </div>
  );
}

export function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

export function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}
