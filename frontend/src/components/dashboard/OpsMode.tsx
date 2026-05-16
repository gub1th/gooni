import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, SkipForward } from "lucide-react";
import {
  fetchEvalSegments,
  fetchEvalSegmentFull,
  patchEvalSegment,
  putMessageRating,
  fetchToolCallFailures,
  type ApiEvalSegment,
  type EvalSegmentFull,
  type EvalMessage,
  type ToolCallFailure,
} from "../../services/api";
import { useListsStore } from "../../stores/useListsStore";
import { BuildMode } from "./BuildMode";
import { CapabilityProfileCard } from "./CapabilityProfileCard";
import { BacklogBoard } from "../lists/BacklogBoard";

// OpsMode — single "operator's console". Folds in what used to be Build.
// Top → bottom:
//   1. Gooni-health cards (was Build mode) + CapabilityProfileCard
//   2. Evals: ONE convo at a time. Per-assistant-turn rating + optional
//      comment. Skip pulls the next unrated.
//   3. Backlog: the kanban BacklogBoard rendered in a fixed-height
//      scroll container, plus an "open full board" link to the
//      standalone /lists/<backlog-id> route.
//   4. Tool-call failures (last 7d).

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

const RATING_LABEL: Record<number, string> = { 1: "bad", 2: "meh", 3: "good" };
const RATING_COLOR: Record<number, string> = { 1: "#791F1F", 2: "#BA7517", 3: "#0F6E56" };
const RATING_GLYPH: Record<number, string> = { 1: "✗", 2: "·", 3: "✓" };

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
      <BuildMode />
      <CapabilityProfileCard />
      <EvalSection />
      <BacklogSection />
      <FailuresSection />
    </div>
  );
}

// ── eval drilldown ────────────────────────────────────────────────────

function EvalSection() {
  const qc = useQueryClient();
  // Pull a small queue of unrated segments. We drill into one at a time;
  // skip = client-side advance; rate-and-mark-done = server flip + advance.
  const { data: queue = [] } = useQuery<ApiEvalSegment[]>({
    queryKey: ["eval-not-yet-queue"],
    queryFn: () => fetchEvalSegments({ statuses: "not_yet", limit: 20 }),
  });

  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const visibleQueue = useMemo(
    () => queue.filter((s) => !skipped.has(s.id)),
    [queue, skipped],
  );
  const current = visibleQueue[0] ?? null;

  return (
    <Section title="Evals" count={visibleQueue.length}>
      {!current ? (
        <EmptyHint>Queue clear. Rate one below as new chats finish.</EmptyHint>
      ) : (
        <EvalDrilldown
          key={current.id}
          segment={current}
          onSkip={() => setSkipped((s) => new Set(s).add(current.id))}
          onDone={async () => {
            await patchEvalSegment(current.id, { eval_status: "done" });
            qc.invalidateQueries({ queryKey: ["eval-not-yet-queue"] });
          }}
          remaining={visibleQueue.length}
        />
      )}
    </Section>
  );
}

function EvalDrilldown({ segment, onSkip, onDone, remaining }: {
  segment: ApiEvalSegment;
  onSkip: () => void;
  onDone: () => Promise<void>;
  remaining: number;
}) {
  const { data: full, isLoading } = useQuery<EvalSegmentFull>({
    queryKey: ["eval-segment-full", segment.id],
    queryFn: () => fetchEvalSegmentFull(segment.id),
  });

  return (
    <div style={{
      background: "var(--gooni-card, #fff)",
      border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.10))",
      borderRadius: 10,
      overflow: "hidden",
    }}>
      {/* Convo header */}
      <div style={{
        padding: "10px 14px",
        borderBottom: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
        display: "flex", alignItems: "center", gap: 12,
        background: "rgba(0,0,0,0.015)",
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
            textTransform: "uppercase",
            color: "var(--gooni-muted, #8E8E93)",
            marginBottom: 2,
          }}>
            {segment.source} · {segment.message_count} msgs · {fmtAgo(segment.last_message_at)}
          </div>
          <div style={{
            fontSize: 12, color: "var(--gooni-text, #1C1C1E)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {segment.preview ?? segment.title ?? `Segment #${segment.id}`}
          </div>
        </div>
        <button
          onClick={onSkip}
          title="Skip to next unrated convo"
          style={navButton}
        >
          <SkipForward size={12} /> Skip
        </button>
        <button
          onClick={() => void onDone()}
          title="Mark this convo done + advance"
          style={primaryButton}
        >
          Done <ChevronRight size={12} />
        </button>
      </div>

      {/* Transcript — scrollable. Per-assistant-turn rating row inline. */}
      <div style={{
        maxHeight: 420, overflowY: "auto",
        padding: "10px 14px",
      }}>
        {isLoading || !full ? (
          <div style={{
            fontSize: 12, color: "var(--gooni-muted, #8E8E93)", padding: 20,
          }}>
            Loading conversation…
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {full.messages.map((m) => (
              <MessageBlock key={m.id} segmentId={segment.id} msg={m} />
            ))}
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div style={{
        padding: "6px 14px",
        borderTop: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
        fontSize: 10, color: "var(--gooni-muted, #8E8E93)",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span>{remaining - 1} more in queue after this</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <ChevronLeft size={10} /> bad · meh · good <ChevronRight size={10} />
        </span>
      </div>
    </div>
  );
}

function MessageBlock({ segmentId, msg }: {
  segmentId: number;
  msg: EvalMessage;
}) {
  const qc = useQueryClient();
  const isAssistant = msg.role === "assistant";
  const [rating, setRating] = useState<1 | 2 | 3 | null>(
    (msg.rating?.rating as 1 | 2 | 3 | undefined) ?? null,
  );
  const [comment, setComment] = useState<string>(msg.rating?.comment ?? "");
  const [commentOpen, setCommentOpen] = useState<boolean>(!!msg.rating?.comment);
  const [saving, setSaving] = useState(false);

  async function save(nextRating: 1 | 2 | 3, nextComment: string | null) {
    setSaving(true);
    try {
      await putMessageRating(segmentId, msg.id, {
        rating: nextRating,
        comment: nextComment,
      });
      qc.invalidateQueries({ queryKey: ["eval-segment-full", segmentId] });
    } catch (e) {
      console.error("rating save failed", e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      borderLeft: `2px solid ${isAssistant ? "#3B82F6" : "rgba(0,0,0,0.12)"}`,
      paddingLeft: 10,
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
        textTransform: "uppercase",
        color: isAssistant ? "#3B82F6" : "var(--gooni-muted, #8E8E93)",
      }}>
        {isAssistant ? "Gooni" : "User"}
      </div>
      <div style={{
        fontSize: 13, color: "var(--gooni-text, #1C1C1E)",
        whiteSpace: "pre-wrap", lineHeight: 1.5,
        maxHeight: 220, overflowY: "auto",
      }}>
        {msg.content || <em style={{ color: "var(--gooni-muted, #8E8E93)" }}>(empty)</em>}
      </div>

      {isAssistant && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {[1, 2, 3].map((r) => {
              const active = rating === r;
              return (
                <button
                  key={r}
                  onClick={() => { setRating(r as 1 | 2 | 3); void save(r as 1 | 2 | 3, comment || null); }}
                  disabled={saving}
                  title={RATING_LABEL[r]}
                  style={{
                    width: 26, height: 26, borderRadius: 6,
                    background: active ? RATING_COLOR[r] : "var(--gooni-card, #fff)",
                    border: `0.5px solid ${active ? RATING_COLOR[r] : "rgba(0,0,0,0.12)"}`,
                    color: active ? "#fff" : RATING_COLOR[r],
                    cursor: saving ? "wait" : "pointer", fontSize: 13, fontWeight: 600,
                    padding: 0, fontFamily: "inherit",
                  }}
                >
                  {RATING_GLYPH[r]}
                </button>
              );
            })}
            <button
              onClick={() => setCommentOpen((v) => !v)}
              style={{
                marginLeft: 4,
                background: "transparent", border: "none", cursor: "pointer",
                color: "var(--gooni-muted, #8E8E93)", fontSize: 11,
                padding: 0, fontFamily: "inherit",
              }}
            >
              {commentOpen ? "hide note" : (msg.rating?.comment ? "edit note" : "+ note")}
            </button>
            {msg.rating?.updated_at && (
              <span style={{
                marginLeft: "auto",
                fontSize: 10, color: "var(--gooni-muted, #8E8E93)",
              }}>
                saved {fmtAgo(msg.rating.updated_at)}
              </span>
            )}
          </div>
          {commentOpen && (
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onBlur={() => { if (rating) void save(rating, comment || null); }}
              rows={2}
              placeholder="what went wrong / right"
              style={{
                width: "100%", resize: "vertical",
                fontFamily: "inherit", fontSize: 12, lineHeight: 1.45,
                padding: "6px 8px",
                background: "var(--gooni-card, #fff)",
                border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.12))",
                borderRadius: 6,
                color: "var(--gooni-text, #1C1C1E)",
                outline: "none",
              }}
            />
          )}
        </div>
      )}
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
            search: { note: undefined, conv: undefined, list: backlogList.id, audit: undefined },
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
      {/* Scrollable wrapper — fixed height so the rest of OpsMode stays
          reachable without endless scroll. BacklogBoard's columns shrink
          naturally into the narrower container. */}
      <div style={{
        height: 360, overflow: "auto",
        border: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
        borderRadius: 10,
        background: "rgba(0,0,0,0.015)",
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

const navButton: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "5px 10px", borderRadius: 6,
  border: "0.5px solid rgba(0,0,0,0.12)",
  background: "var(--gooni-card, #fff)",
  color: "var(--gooni-muted, #6B7280)",
  fontSize: 11, fontWeight: 500, cursor: "pointer",
  fontFamily: FONT,
};

const primaryButton: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4,
  padding: "5px 10px", borderRadius: 6,
  border: "none",
  background: "var(--gooni-text, #1C1C1E)",
  color: "var(--gooni-card, #fff)",
  fontSize: 11, fontWeight: 500, cursor: "pointer",
  fontFamily: FONT,
};
