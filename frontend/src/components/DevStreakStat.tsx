import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchDevActivity, fetchSnapshotToday, type DevActivity, type DevActivityRepo, type GooniSnapshot } from "../services/api";
import { Skeleton } from "./Skeleton";

const FONT = "'Inter', -apple-system, sans-serif";
const GREEN = "#30A14E";
const RED = "#CF222E";

// Stat-card sibling to "day streak". Click opens a floating panel anchored
// below the card (rendered via Portal so it doesn't disrupt the stat row's
// flex layout). Hidden when no GitHub repos tracked.
export function DevStreakStat() {
  const queryClient = useQueryClient();
  const { data: dev, isLoading } = useQuery<DevActivity | null>({
    queryKey: ["dev-activity"],
    queryFn: () => fetchDevActivity().catch(() => null),
  });
  const [expanded, setExpanded] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // RepoPicker fires this when a repo is tracked/untracked — invalidate the
  // cache so dev activity refetches with the new repo set.
  useEffect(() => {
    function onChange() { queryClient.invalidateQueries({ queryKey: ["dev-activity"] }); }
    window.addEventListener("gooni-tracked-repos-changed", onChange);
    return () => window.removeEventListener("gooni-tracked-repos-changed", onChange);
  }, [queryClient]);

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!expanded) return;
    function onDocClick(e: MouseEvent) {
      const btn = buttonRef.current;
      const target = e.target as Node;
      if (btn?.contains(target)) return;
      if ((target as HTMLElement)?.closest?.("[data-gooni-dev-popover]")) return;
      setExpanded(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setExpanded(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [expanded]);

  // First-paint skeleton — shaped like the real card so the stat row layout
  // doesn't reflow when data lands.
  if (isLoading && !dev) {
    return (
      <div style={{
        background: "#fff", border: "0.5px solid rgba(0,0,0,0.08)",
        borderRadius: 10, padding: "10px 14px",
        display: "flex", flexDirection: "column", alignItems: "flex-start",
        minWidth: 110, gap: 4,
      }}>
        <Skeleton width={50} height={11} />
        <Skeleton width={28} height={20} />
        <Skeleton width={70} height={11} />
      </div>
    );
  }
  if (!dev || !dev.connected || dev.repos.length === 0) return null;

  const { aggregate } = dev;
  const todayCommits = aggregate.today_commits;
  const adds = dev.repos.reduce((sum, r) => sum + (r.today?.additions ?? 0), 0);
  const dels = dev.repos.reduce((sum, r) => sum + (r.today?.deletions ?? 0), 0);

  return (
    <>
      <button
        ref={buttonRef}
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

      {expanded && buttonRef.current && (
        <DevExpandedPopover data={dev} anchor={buttonRef.current} />
      )}
    </>
  );
}

// Floating popover anchored to the stat card. Rendered through a portal so
// the dashboard's flex row layout stays untouched (the in-flow expand was
// pushing the row to wrap and overlap the greeting).
function DevExpandedPopover({ data, anchor }: { data: DevActivity; anchor: HTMLElement }) {
  // Re-measure on resize / scroll so the panel hugs the anchor.
  const [rect, setRect] = useState(() => anchor.getBoundingClientRect());
  useEffect(() => {
    function update() { setRect(anchor.getBoundingClientRect()); }
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor]);

  const PANEL_WIDTH = 420;
  // Default: anchor right edge of panel under right edge of button.
  const left = Math.max(12, Math.min(window.innerWidth - PANEL_WIDTH - 12, rect.right - PANEL_WIDTH));
  const top = rect.bottom + 8;

  return createPortal(
    <div
      data-gooni-dev-popover="true"
      style={{
        position: "fixed",
        top, left,
        width: PANEL_WIDTH,
        background: "#fff",
        border: "0.5px solid rgba(0,0,0,0.10)",
        borderRadius: 12,
        padding: "14px 16px",
        fontFamily: FONT,
        boxShadow: "0 12px 32px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)",
        zIndex: 1200,
        animation: "gooni-dev-expand 180ms cubic-bezier(0.22, 1, 0.36, 1)",
      }}
    >
      <style>{`
        @keyframes gooni-dev-expand {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <GooniTake />
      <div style={{
        fontSize: 11, color: "#8E8E93", textTransform: "uppercase",
        letterSpacing: 0.6, fontWeight: 600, marginBottom: 10, marginTop: 14,
      }}>Dev Activity</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: "60vh", overflowY: "auto" }}>
        {data.repos.map((r) => (
          <RepoRow key={`${r.owner}/${r.name}`} repo={r} />
        ))}
      </div>
    </div>,
    document.body,
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

// Gooni's Take — daily reflection block at the top of the popover. Fetches
// /snapshot/today which lazy-builds on first read of the day, so we don't
// need a cron. While loading: skeleton lines in the same shape so the
// popover doesn't jump when the digest lands.
function GooniTake() {
  const { data, isLoading } = useQuery<GooniSnapshot>({
    queryKey: ["snapshot-today"],
    queryFn: fetchSnapshotToday,
    // Snapshot rarely changes within a session; keep it fresh for an hour.
    staleTime: 60 * 60_000,
  });

  if (isLoading && !data) {
    return (
      <div style={{ marginBottom: 4 }}>
        <div style={{
          fontSize: 11, color: "#8E8E93", textTransform: "uppercase",
          letterSpacing: 0.6, fontWeight: 600, marginBottom: 8,
        }}>Gooni's Take</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <Skeleton width="100%" height={11} />
          <Skeleton width="92%" height={11} />
          <Skeleton width="78%" height={11} />
        </div>
      </div>
    );
  }
  if (!data || !data.digest) return null;

  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
      }}>
        <span style={{
          fontSize: 11, color: "#8E8E93", textTransform: "uppercase",
          letterSpacing: 0.6, fontWeight: 600,
        }}>Gooni's Take</span>
        <span style={{ fontSize: 10.5, color: "#AEAEB2" }}>
          {data.day}
        </span>
      </div>
      <div style={{
        fontSize: 12, color: "#3A3A3C", lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        background: "linear-gradient(180deg, #FAFBFC, #F4F6F8)",
        border: "0.5px solid rgba(0,0,0,0.06)",
        borderRadius: 10, padding: "10px 12px",
      }}>
        {data.digest}
      </div>
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
