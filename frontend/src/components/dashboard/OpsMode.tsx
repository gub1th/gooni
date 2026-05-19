import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ExternalLink } from "lucide-react";
import {
  fetchToolCallFailures,
  type ToolCallFailure,
} from "../../services/api";
import { useListsStore } from "../../stores/useListsStore";
import { BuildMode } from "./BuildMode";
import { CapabilityProfileCard } from "./CapabilityProfileCard";
import { BacklogBoard } from "../lists/BacklogBoard";

// OpsMode — single scrollable "operator's console". The Evals/Backlog/
// Health sub-tab bar was removed in the dashboard restructure: the Audit
// page already owns the eval workflow (click row → drilldown → rate →
// next), so a duplicate surface inside Ops was dead weight. Order:
//   1. Backlog kanban (fixed-height scroller)
//   2. Gooni-health cards (was Build mode) + CapabilityProfileCard
//   3. Tool-call failures (last 7d)

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

function fmtAgo(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const days = Math.floor(diff / 86400_000);
  const hours = Math.floor(diff / 3600_000);
  const mins = Math.floor(diff / 60_000);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

export function OpsMode() {
  return (
    <div style={{ fontFamily: FONT, display: "flex", flexDirection: "column", gap: 22 }}>
      <BacklogSection />
      <BuildMode />
      <CapabilityProfileCard />
      <FailuresSection />
    </div>
  );
}

// ── backlog (kanban, scrollable) ──────────────────────────────────────

function BacklogSection() {
  const navigate = useNavigate();
  const lists = useListsStore((s) => s.lists);
  const fetchAll = useListsStore((s) => s.fetchAll);
  useEffect(() => {
    if (!lists.length) void fetchAll();
  }, [lists.length, fetchAll]);
  const backlogList = lists.find((l) => l.type === "backlog");

  return (
    <Section
      title="Backlog"
      right={backlogList && (
        <button
          onClick={() => navigate({
            to: "/",
            search: { note: undefined, conv: undefined, list: backlogList.id, audit: undefined, segment: undefined, view: undefined },
          })}
          style={{
            background: "transparent", border: "none", cursor: "pointer",
            color: "var(--gooni-muted, #8E8E93)", fontSize: 11,
            display: "inline-flex", alignItems: "center", gap: 3,
            fontFamily: "inherit", padding: 0,
          }}
          title="Open full backlog board"
        >
          open full <ExternalLink size={10} />
        </button>
      )}
    >
      <div style={{
        height: 560,
        border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
        borderRadius: 10,
        background: "rgba(0,0,0,0.015)",
        display: "flex", flexDirection: "column",
      }}>
        <BacklogBoard />
      </div>
    </Section>
  );
}

// ── tool-call failures section ─────────────────────────────────────────

function FailuresSection() {
  const { data: failures = [] } = useQuery<ToolCallFailure[]>({
    queryKey: ["tool-failures"],
    queryFn: () => fetchToolCallFailures(7, 10),
  });

  return (
    <Section
      title="Tool-call failures (7d)"
      count={failures.length}
      tone={failures.length > 0 ? "warn" : "default"}
    >
      {failures.length === 0 ? (
        <EmptyHint>None. Anti-hallucination layer is quiet.</EmptyHint>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {failures.map((f) => (
            <div key={f.id} style={{
              background: "var(--gooni-card, #fff)",
              border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.10))",
              borderLeft: "2px solid #791F1F",
              borderRadius: 6,
              padding: "6px 10px",
              display: "grid",
              gridTemplateColumns: "auto 1fr auto",
              gap: 8,
              alignItems: "center",
            }}>
              <AlertTriangle size={12} color="#791F1F" />
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 500, color: "var(--gooni-text, #1C1C1E)" }}>
                  {f.tool_name}
                </span>
                <span style={{
                  fontSize: 10, color: "var(--gooni-muted, #8E8E93)",
                  marginLeft: 6,
                  overflow: "hidden", textOverflow: "ellipsis",
                }}>
                  {f.error.slice(0, 120)}
                </span>
              </div>
              <span style={{ fontSize: 10, color: "var(--gooni-muted, #8E8E93)" }}>
                {fmtAgo(f.started_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ── primitives ─────────────────────────────────────────────────────────

function Section({ title, count, tone = "default", right, children }: {
  title: string;
  count?: number;
  tone?: "default" | "warn";
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 500,
        color: tone === "warn" ? "#791F1F" : "var(--gooni-muted, #8E8E93)",
        letterSpacing: 0.4, textTransform: "uppercase",
        marginBottom: 8, padding: "0 2px",
        display: "flex", alignItems: "center", gap: 6,
      }}>
        <span>{title}</span>
        {count != null && (
          <span style={{
            fontSize: 10, color: "var(--gooni-muted, #8E8E93)", fontWeight: 400,
          }}>
            · {count}
          </span>
        )}
        {right && <span style={{ marginLeft: "auto" }}>{right}</span>}
      </div>
      {children}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
      fontStyle: "italic", padding: "4px 2px",
    }}>{children}</div>
  );
}
