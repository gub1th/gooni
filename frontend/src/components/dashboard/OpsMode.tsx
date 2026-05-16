import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, AlertTriangle } from "lucide-react";
import {
  fetchBacklogTickets,
  fetchEvalSegments,
  patchEvalSegment,
  fetchToolCallFailures,
  type ApiBacklogTicket,
  type ApiEvalSegment,
  type ToolCallFailure,
} from "../../services/api";

// OpsMode — "operator's console". Three sections:
//   1. Last eval line + eval queue (3 unrated segments w/ inline rating)
//   2. Backlog (all statuses, sorted by board status then updated_at)
//   3. Recent tool-call failures (hallucination / integration breakage)
//
// Goal: reduce friction on rating evals. Daniel said he doesn't get
// into the eval habit — surfacing the queue here makes it a 1-tap
// action rather than a separate-page visit.

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

const RATING_LABEL: Record<number, string> = {
  1: "bad",
  2: "meh",
  3: "good",
};

const RATING_COLOR: Record<number, string> = {
  1: "#791F1F",
  2: "#BA7517",
  3: "#0F6E56",
};

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
    <div style={{ fontFamily: FONT, display: "flex", flexDirection: "column", gap: 18 }}>
      <EvalSection />
      <BacklogSection />
      <FailuresSection />
    </div>
  );
}

// ── eval section ───────────────────────────────────────────────────────

function EvalSection() {
  const qc = useQueryClient();
  // Last eval = most recent segment w/ done status.
  const { data: doneSegs = [] } = useQuery<ApiEvalSegment[]>({
    queryKey: ["eval-done"],
    queryFn: () => fetchEvalSegments({ statuses: "done", limit: 1 }),
  });
  // Unrated queue = not_yet status.
  const { data: queue = [] } = useQuery<ApiEvalSegment[]>({
    queryKey: ["eval-not-yet"],
    queryFn: () => fetchEvalSegments({ statuses: "not_yet", limit: 3 }),
  });

  const last = doneSegs[0];

  const handleRate = async (id: number, rating: number) => {
    await patchEvalSegment(id, {
      overall_rating: rating, eval_status: "done",
    });
    qc.invalidateQueries({ queryKey: ["eval-not-yet"] });
    qc.invalidateQueries({ queryKey: ["eval-done"] });
  };

  return (
    <Section title="Evals">
      <div style={{
        fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
        marginBottom: 10,
      }}>
        {last ? (
          <>
            Last eval: <strong>{fmtAgo(last.last_message_at)}</strong>
            {last.overall_rating != null && (
              <>
                {" · "}
                <span style={{ color: RATING_COLOR[last.overall_rating] }}>
                  {RATING_LABEL[last.overall_rating]}
                </span>
              </>
            )}
          </>
        ) : (
          "No evals yet — rate one below to start."
        )}
      </div>

      {queue.length === 0 ? (
        <EmptyHint>Queue clear. New conversations will surface here when they finish.</EmptyHint>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {queue.map((seg) => (
            <EvalRow key={seg.id} seg={seg} onRate={handleRate} />
          ))}
        </div>
      )}
    </Section>
  );
}

function EvalRow({ seg, onRate }: {
  seg: ApiEvalSegment;
  onRate: (id: number, rating: number) => void;
}) {
  return (
    <div style={{
      background: "var(--gooni-card, #fff)",
      border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.10))",
      borderRadius: 10,
      padding: "10px 14px",
      display: "grid",
      gridTemplateColumns: "1fr auto",
      gap: 12,
      alignItems: "center",
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
          textTransform: "uppercase", letterSpacing: 0.4,
          marginBottom: 3,
        }}>
          {seg.source} · {seg.message_count} msgs · {fmtAgo(seg.last_message_at)}
        </div>
        <div style={{
          fontSize: 12, color: "var(--gooni-text, #1C1C1E)",
          overflow: "hidden", textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 2 as unknown as number,
          WebkitBoxOrient: "vertical" as unknown as "vertical",
        }}>
          {seg.preview ?? seg.title ?? `Segment #${seg.id}`}
        </div>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        {[1, 2, 3].map((r) => (
          <button
            key={r}
            onClick={() => onRate(seg.id, r)}
            title={RATING_LABEL[r]}
            style={{
              width: 26, height: 26, borderRadius: 6,
              background: "var(--gooni-card, #fff)",
              border: "0.5px solid rgba(0,0,0,0.12)",
              color: RATING_COLOR[r],
              cursor: "pointer", fontSize: 13, fontWeight: 600,
              padding: 0, fontFamily: "inherit",
            }}
          >
            {r === 1 ? "✗" : r === 2 ? "·" : "✓"}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── backlog section ────────────────────────────────────────────────────

const BOARD_STATUS_ORDER: Record<string, number> = { doing: 0, not_yet: 1, done: 2 };
const BOARD_STATUS_LABEL: Record<string, string> = {
  not_yet: "Not yet",
  doing: "Doing",
  done: "Done",
};
const BOARD_STATUS_COLOR: Record<string, string> = {
  not_yet: "var(--gooni-muted, #8E8E93)",
  doing: "#BA7517",
  done: "#0F6E56",
};

function BacklogSection() {
  const { data: tickets = [] } = useQuery<ApiBacklogTicket[]>({
    queryKey: ["backlog-tickets"],
    queryFn: () => fetchBacklogTickets(true),
  });

  const sorted = [...tickets].sort((a, b) => {
    const sa = BOARD_STATUS_ORDER[a.board_status ?? "not_yet"] ?? 9;
    const sb = BOARD_STATUS_ORDER[b.board_status ?? "not_yet"] ?? 9;
    if (sa !== sb) return sa - sb;
    const ta = a.updated_at ? Date.parse(a.updated_at) : 0;
    const tb = b.updated_at ? Date.parse(b.updated_at) : 0;
    return tb - ta;
  });

  return (
    <Section title="Backlog" count={tickets.length}>
      {sorted.length === 0 ? (
        <EmptyHint>Backlog empty. Chat about a feature request to add one.</EmptyHint>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {sorted.map((t) => (
            <BacklogRow key={t.id} ticket={t} />
          ))}
        </div>
      )}
    </Section>
  );
}

function BacklogRow({ ticket }: { ticket: ApiBacklogTicket }) {
  return (
    <div style={{
      background: "var(--gooni-card, #fff)",
      border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.10))",
      borderRadius: 8,
      padding: "8px 12px",
      display: "grid",
      gridTemplateColumns: "auto 1fr auto",
      alignItems: "center",
      gap: 10,
      opacity: ticket.board_status === "done" ? 0.65 : 1,
    }}>
      <span style={{
        fontSize: 10, fontWeight: 500,
        color: BOARD_STATUS_COLOR[ticket.board_status ?? "not_yet"],
        background: "rgba(0,0,0,0.04)",
        padding: "2px 6px", borderRadius: 4,
        textTransform: "uppercase", letterSpacing: 0.4,
        whiteSpace: "nowrap",
      }}>
        {BOARD_STATUS_LABEL[ticket.board_status ?? "not_yet"] ?? ticket.board_status}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 12,
          color: "var(--gooni-text, #1C1C1E)",
          textDecoration: ticket.board_status === "done" ? "line-through" : "none",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {ticket.text}
        </div>
        {ticket.subtitle && (
          <div style={{
            fontSize: 10, color: "var(--gooni-muted, #8E8E93)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {ticket.subtitle}
          </div>
        )}
      </div>
      {ticket.pr_url ? (
        <a
          href={ticket.pr_url} target="_blank" rel="noopener noreferrer"
          title="View PR"
          style={{
            display: "inline-flex", alignItems: "center", gap: 3,
            fontSize: 10, color: "#0F6E56",
            textDecoration: "none",
            padding: "2px 6px", borderRadius: 4,
            background: "rgba(15,110,86,0.08)",
          }}
        >
          PR <ExternalLink size={9} />
        </a>
      ) : <span />}
    </div>
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

function Section({ title, count, tone = "default", children }: {
  title: string;
  count?: number;
  tone?: "default" | "warn";
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
