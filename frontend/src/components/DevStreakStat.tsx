import { useEffect, useState } from "react";
import { fetchDevActivity, type DevActivity, type DevActivityRepo } from "../services/api";

const FONT = "'Inter', -apple-system, sans-serif";
const GREEN = "#30A14E";
const RED = "#CF222E";

// Stat-card sibling to "day streak". Same chrome, click to expand a
// commits panel below the row. Hidden when no GitHub repos tracked.
export function DevStreakStat() {
  const [dev, setDev] = useState<DevActivity | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetchDevActivity().then(setDev).catch(() => setDev(null));
    function onChange() {
      fetchDevActivity().then(setDev).catch(() => setDev(null));
    }
    window.addEventListener("gooni-tracked-repos-changed", onChange);
    return () => window.removeEventListener("gooni-tracked-repos-changed", onChange);
  }, []);

  if (!dev || !dev.connected || dev.repos.length === 0) return null;

  const { aggregate } = dev;
  const todayCommits = aggregate.today_commits;
  const adds = dev.repos.reduce((sum, r) => sum + (r.today?.additions ?? 0), 0);
  const dels = dev.repos.reduce((sum, r) => sum + (r.today?.deletions ?? 0), 0);

  return (
    <>
      <button
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "Hide commit details" : "Show commit details"}
        style={{
          background: "#fff", border: "0.5px solid rgba(0,0,0,0.08)",
          borderRadius: 10, padding: "10px 14px",
          display: "flex", flexDirection: "column", alignItems: "flex-start",
          minWidth: 110, cursor: "pointer", fontFamily: FONT, textAlign: "left",
          transition: "border-color 0.12s, background 0.12s",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(0,0,0,0.18)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(0,0,0,0.08)"; }}
      >
        <div style={{ fontSize: 11, color: "#8E8E93", letterSpacing: 0.3 }}>dev streak</div>
        <div style={{ fontSize: 20, fontWeight: 600, color: "#1C1C1E", marginTop: 1, lineHeight: 1.1 }}>
          {aggregate.streak_days}
        </div>
        <div style={{
          display: "flex", gap: 4, marginTop: 4, alignItems: "center",
          fontSize: 10.5, fontVariantNumeric: "tabular-nums",
        }}>
          <span style={{ color: "#6B6B70" }}>{todayCommits} today</span>
          {(adds > 0 || dels > 0) && (
            <>
              <span style={{ color: GREEN }}>+{adds}</span>
              <span style={{ color: RED }}>−{dels}</span>
            </>
          )}
        </div>
      </button>

      {expanded && (
        <DevExpandedPanel data={dev} />
      )}
    </>
  );
}

// Rendered as a sibling AFTER the stat-card row. The Dashboard wraps
// the stat row + this panel in the same container; when expanded=false
// this returns null and the layout is unchanged.
function DevExpandedPanel({ data }: { data: DevActivity }) {
  return (
    <div
      style={{
        flexBasis: "100%",
        width: "100%",
        marginTop: 12,
        background: "#fff",
        border: "0.5px solid rgba(0,0,0,0.08)",
        borderRadius: 12,
        padding: "14px 16px",
        fontFamily: FONT,
        animation: "gooni-dev-expand 200ms cubic-bezier(0.22, 1, 0.36, 1)",
      }}
    >
      <style>{`
        @keyframes gooni-dev-expand {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div style={{
        fontSize: 11, color: "#8E8E93", textTransform: "uppercase",
        letterSpacing: 0.6, fontWeight: 600, marginBottom: 10,
      }}>Dev Activity</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {data.repos.map((r) => (
          <RepoRow key={`${r.owner}/${r.name}`} repo={r} />
        ))}
      </div>
    </div>
  );
}

function RepoRow({ repo }: { repo: DevActivityRepo }) {
  const today = repo.today;
  const recent = (repo.recent ?? []).slice(0, 3);
  return (
    <div>
      <div style={{
        display: "flex", alignItems: "baseline", gap: 8,
        fontSize: 12, color: "#1C1C1E",
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
        <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
          {recent.map((c) => (
            <a
              key={c.sha}
              href={c.html_url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "flex", alignItems: "baseline", gap: 8,
                textDecoration: "none", color: "inherit",
                fontSize: 11.5,
              }}
            >
              <span style={{
                color: "#AEAEB2", fontFamily: "ui-monospace, monospace",
                flexShrink: 0,
              }}>─</span>
              <span style={{ color: "#3A3A3C", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.subject}
              </span>
              <span style={{ color: "#AEAEB2", fontSize: 10.5, flexShrink: 0 }}>
                {relTime(c.committed_at)}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
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
