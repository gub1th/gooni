import { useEffect, useState } from "react";
import { fetchDevActivity, type DevActivity, type DevActivityRepo } from "../services/api";

export function DevActivityCard() {
  const [data, setData] = useState<DevActivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  async function refresh() {
    try {
      setData(await fetchDevActivity());
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    function onChange() { setLoading(true); refresh(); }
    window.addEventListener("gooni-tracked-repos-changed", onChange);
    return () => window.removeEventListener("gooni-tracked-repos-changed", onChange);
  }, []);

  // Hide entirely when not connected or no repos tracked — dashboard stays
  // clean for users who don't use the GitHub integration.
  if (loading) return null;
  if (!data || !data.connected || data.repos.length === 0) return null;

  return (
    <div style={{
      background: "#fff",
      border: "0.5px solid rgba(0,0,0,0.08)",
      borderRadius: 12,
      padding: "16px 18px",
      marginBottom: 16,
      fontFamily: "'Manrope', -apple-system, sans-serif",
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 12,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            width: 8, height: 8, borderRadius: "50%", background: "#1C1C1E",
          }} />
          <span style={{
            fontSize: 11, color: "#8E8E93", textTransform: "uppercase",
            letterSpacing: 0.6, fontWeight: 600,
          }}>
            Dev Activity
          </span>
        </div>
        <div style={{ fontSize: 12, color: "#1C1C1E", fontWeight: 600 }}>
          {data.aggregate.today_commits} today · {data.aggregate.streak_days}d streak
        </div>
      </div>

      {data.week_summary && (
        <div style={{
          fontSize: 12.5, color: "#3A3A3C", lineHeight: 1.55,
          padding: "10px 12px", marginBottom: 12,
          background: "#FAFAF8", borderRadius: 8,
          border: "0.5px solid rgba(0,0,0,0.05)",
        }}>
          {data.week_summary}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {data.repos.map((r) => (
          <RepoRow
            key={`${r.owner}/${r.name}`}
            repo={r}
            expanded={expandedKey === `${r.owner}/${r.name}`}
            onToggle={() => {
              const k = `${r.owner}/${r.name}`;
              setExpandedKey((prev) => (prev === k ? null : k));
            }}
          />
        ))}
      </div>
    </div>
  );
}

function RepoRow({ repo, expanded, onToggle }: { repo: DevActivityRepo; expanded: boolean; onToggle: () => void }) {
  const today = repo.today;
  const hasErr = Boolean(repo.error);

  return (
    <div style={{
      border: "0.5px solid rgba(0,0,0,0.06)", borderRadius: 8,
      padding: "10px 12px", background: "#FDFCFA",
    }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
        onClick={onToggle}
      >
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "#1C1C1E" }}>
          {repo.owner}/{repo.name}
        </span>
        {hasErr ? (
          <span style={{ fontSize: 11, color: "#C44" }}>{repo.error}</span>
        ) : today ? (
          <span style={{ fontSize: 11.5, color: "#6B6B70", marginLeft: "auto", display: "flex", gap: 8 }}>
            <span>{today.commits} {today.commits === 1 ? "commit" : "commits"}</span>
            {today.commits > 0 && (
              <>
                <span style={{ color: "#30A14E" }}>+{today.additions}</span>
                <span style={{ color: "#CF222E" }}>−{today.deletions}</span>
              </>
            )}
            <span>· {repo.streak_days ?? 0}d</span>
          </span>
        ) : null}
      </div>

      {expanded && repo.recent && repo.recent.length > 0 && (
        <div style={{
          marginTop: 10, paddingTop: 10,
          borderTop: "0.5px solid rgba(0,0,0,0.06)",
          display: "flex", flexDirection: "column", gap: 6,
        }}>
          {repo.recent.map((c) => (
            <a
              key={c.sha}
              href={c.html_url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "flex", alignItems: "baseline", gap: 8,
                textDecoration: "none", color: "inherit",
              }}
            >
              <span style={{
                fontSize: 10.5, fontFamily: "ui-monospace, monospace",
                color: "#8E8E93", flexShrink: 0,
              }}>
                {c.sha}
              </span>
              <span style={{ fontSize: 12, color: "#1C1C1E", flex: 1 }}>
                {c.subject}
              </span>
              <span style={{ fontSize: 10.5, color: "#AEAEB2", flexShrink: 0 }}>
                {relativeTime(c.committed_at)}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diffMs = Date.now() - t;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  return `${d}d`;
}
