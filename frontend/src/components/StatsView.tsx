import { useQuery } from "@tanstack/react-query";
import {
  fetchDashboardStats,
  fetchDevActivity,
  fetchExtendedStats,
  fetchOpenAIUsage,
  fetchSnapshotToday,
  type DashboardStats,
  type DevActivity,
  type DevActivityRepo,
  type ExtendedStats,
  type GooniSnapshot,
  type OpenAIUsage,
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
          {data.by_model && data.by_model.length > 0 && (
            <ModelBreakdown rows={data.by_model} />
          )}
        </>
      )}
    </SectionShell>
  );
}

function DevSection() {
  const { data: dev, isLoading } = useQuery<DevActivity | null>({
    queryKey: ["dev-activity"],
    queryFn: () => fetchDevActivity().catch(() => null),
  });
  const { data: snap } = useQuery<GooniSnapshot>({
    queryKey: ["snapshot-today"],
    queryFn: fetchSnapshotToday,
    staleTime: 60 * 60_000,
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

      {snap?.digest && (
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
            Gooni's take · {snap.day}
          </div>
          <div style={{
            fontSize: 13, color: "#3A3A3C", lineHeight: 1.55,
            whiteSpace: "pre-wrap",
          }}>
            {snap.digest}
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

  if (isLoading && !stats) {
    return (
      <SectionShell label="Activity">
        <SkeletonRow />
      </SectionShell>
    );
  }

  return (
    <SectionShell label="Activity">
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        gap: 14,
      }}>
        <BigStat label="day streak" value={fmtInt(stats?.streak)} sub="days" />
        <BigStat label="notes this week" value={fmtInt(stats?.notes_this_week)} />
        <BigStat label="notes total" value={fmtInt(ext?.notes_total)} />
        <BigStat label="messages this week" value={fmtInt(ext?.user_messages_this_week)} />
        <BigStat label="messages total" value={fmtInt(ext?.user_messages_total)} />
        <BigStat label="conversations" value={fmtInt(ext?.conversations_total)} />
        <BigStat label="todos done this week" value={fmtInt(ext?.todos_done_this_week)} />
        <BigStat label="todos open" value={fmtInt(ext?.todos_open)} />
        <BigStat label="claude calls today" value={fmtInt(stats?.mcp_calls_today)} />
      </div>
    </SectionShell>
  );
}

// ── Atoms ─────────────────────────────────────────────────────────────────

function BigStat({
  label, value, sub,
}: { label: string; value: React.ReactNode; sub?: string }) {
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
