import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Check, ChevronRight, ExternalLink, Minus, SkipForward, X } from "lucide-react";
import {
  fetchEvalSegments,
  fetchEvalSegmentFull,
  patchEvalSegment,
  putMessageRating,
  fetchToolCallFailures,
  type ApiEvalSegment,
  type EvalSegmentFull,
  type EvalMessage,
  type EvalReflectionInline,
  type ToolCallFailure,
} from "../../services/api";
import { renderMarkdown } from "../../utils/markdown";
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

const RATING_LABEL: Record<number, string> = { 1: "bad", 2: "neutral", 3: "good" };
const RATING_COLOR: Record<number, string> = { 1: "#791F1F", 2: "#6B7280", 3: "#0F6E56" };

// Mirror of backend `split_for_bots` in app/services/messaging/base.py. Same
// constants so the eval transcript renders the EXACT bubble shape Telegram /
// WhatsApp / iMessage users actually saw on their phone.
const _MIN_SEGMENT_CHARS = 40;
const _MAX_SEGMENT_CHARS = 320;
const _MAX_SEGMENTS = 4;
const _PARA_RE = /\n\s*\n/;
const _SENTENCE_RE = /(?<=[.!?])\s+(?=[A-Z])/;

function splitForBubbles(text: string): string[] {
  const raw = (text ?? "").trim();
  if (!raw) return [];
  const paragraphs = raw.split(_PARA_RE).map((p) => p.trim()).filter(Boolean);
  if (!paragraphs.length) return [raw];

  const pieces: string[] = [];
  for (const para of paragraphs) {
    if (para.length <= _MAX_SEGMENT_CHARS) {
      pieces.push(para);
      continue;
    }
    const sentences = para.split(_SENTENCE_RE);
    let current = "";
    for (let s of sentences) {
      s = s.trim();
      if (!s) continue;
      if (!current) current = s;
      else if (current.length + 1 + s.length <= _MAX_SEGMENT_CHARS) current = `${current} ${s}`;
      else { pieces.push(current); current = s; }
    }
    if (current) pieces.push(current);
  }

  const merged: string[] = [];
  for (const p of pieces) {
    if (merged.length && merged[merged.length - 1].length < _MIN_SEGMENT_CHARS) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}\n${p}`;
    } else {
      merged.push(p);
    }
  }

  if (merged.length > _MAX_SEGMENTS) {
    const head = merged.slice(0, _MAX_SEGMENTS - 1);
    const tail = merged.slice(_MAX_SEGMENTS - 1).join("\n\n");
    return [...head, tail];
  }
  return merged;
}

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
  const [celebrating, setCelebrating] = useState(false);
  const visibleQueue = useMemo(
    () => queue.filter((s) => !skipped.has(s.id)),
    [queue, skipped],
  );
  const current = visibleQueue[0] ?? null;

  return (
    <Section title="Evals" count={visibleQueue.length}>
      <div style={{ position: "relative" }}>
        {!current ? (
          <EmptyHint>Queue clear. Rate one below as new chats finish.</EmptyHint>
        ) : (
          <EvalDrilldown
            key={current.id}
            segment={current}
            onSkip={() => setSkipped((s) => new Set(s).add(current.id))}
            onDone={async () => {
              await patchEvalSegment(current.id, { eval_status: "done" });
              setCelebrating(true);
              window.setTimeout(() => setCelebrating(false), 1100);
              qc.invalidateQueries({ queryKey: ["eval-not-yet-queue"] });
            }}
            remaining={visibleQueue.length}
          />
        )}
        <DoneBurst show={celebrating} />
      </div>
    </Section>
  );
}

// Centered checkmark badge that scales-in then fades. One-shot, mounted at
// EvalSection scope so the next segment can render underneath while the
// animation plays out. ~1.1s total.
function DoneBurst({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div
      aria-hidden
      style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 10,
      }}
    >
      <style>{`
        @keyframes gooni-done-pop {
          0% { transform: scale(0.4); opacity: 0; }
          30% { transform: scale(1.15); opacity: 1; }
          55% { transform: scale(1); opacity: 1; }
          100% { transform: scale(1.4); opacity: 0; }
        }
        @keyframes gooni-done-ring {
          0% { transform: scale(0.4); opacity: 0.55; }
          100% { transform: scale(2.4); opacity: 0; }
        }
      `}</style>
      <div style={{ position: "relative", width: 88, height: 88 }}>
        <div style={{
          position: "absolute", inset: 0,
          borderRadius: "50%", border: "2px solid #0F6E56",
          animation: "gooni-done-ring 900ms ease-out forwards",
        }} />
        <div style={{
          position: "absolute", inset: 0,
          borderRadius: "50%", background: "#0F6E56",
          boxShadow: "0 12px 36px rgba(15,110,86,0.35)",
          display: "flex", alignItems: "center", justifyContent: "center",
          animation: "gooni-done-pop 1100ms cubic-bezier(0.22, 1, 0.36, 1) forwards",
        }}>
          <Check size={42} color="#fff" strokeWidth={3} />
        </div>
      </div>
    </div>
  );
}

function EvalDrilldown({ segment, onSkip, onDone, remaining }: {
  segment: ApiEvalSegment;
  onSkip: () => void;
  onDone: () => Promise<void>;
  remaining: number;
}) {
  const navigate = useNavigate();
  const { data: full, isLoading } = useQuery<EvalSegmentFull>({
    queryKey: ["eval-segment-full", segment.id],
    queryFn: () => fetchEvalSegmentFull(segment.id),
  });

  const openFullEval = () => {
    navigate({
      to: "/",
      search: {
        note: undefined, conv: undefined, list: undefined,
        audit: true, segment: segment.id,
      },
    });
  };

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
            display: "inline-flex", alignItems: "center", gap: 8,
          }}>
            <span>{segment.source} · {segment.message_count} msgs · {fmtAgo(segment.last_message_at)}</span>
            {segment.is_active && (
              <span
                title="Active conversation — last message <30 min ago"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  color: "#0F6E56",
                }}
              >
                <style>{`
                  @keyframes gooni-active-pulse-ops {
                    0%, 100% { box-shadow: 0 0 0 0 rgba(34,197,94,0.55); }
                    50%      { box-shadow: 0 0 0 4px rgba(34,197,94,0); }
                  }
                `}</style>
                <span style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: "#22C55E",
                  animation: "gooni-active-pulse-ops 1.6s ease-out infinite",
                }} />
                live
              </span>
            )}
          </div>
          <div style={{
            fontSize: 12, color: "var(--gooni-text, #1C1C1E)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {segment.preview ?? segment.title ?? `Segment #${segment.id}`}
          </div>
        </div>
        <button
          onClick={openFullEval}
          title="Open this segment in the full audit view"
          style={{
            ...navButton,
            color: "#5C5953",
          }}
        >
          open full <ExternalLink size={11} />
        </button>
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

      {/* Transcript — scrollable, chat-bubble layout. Mirrors ChatView so the
          eval surface reads as the same conversation the user actually saw.
          Warm cream bg + soft borders for a Claude-app-like calm tone. */}
      <div style={{
        maxHeight: 520, overflowY: "auto",
        padding: "14px 18px",
        background: "#FBF8F2",
      }}>
        {isLoading || !full ? (
          <div style={{
            fontSize: 12, color: "var(--gooni-muted, #8E8E93)", padding: 20,
          }}>
            Loading conversation…
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {full.messages.map((m) => (
              <MessageBlock key={m.id} segmentId={segment.id} msg={m} />
            ))}
          </div>
        )}
      </div>

      {/* Footer — just queue count now. Rating legend lives on the buttons. */}
      <div style={{
        padding: "6px 14px",
        borderTop: "0.5px solid var(--gooni-border, rgba(0,0,0,0.08))",
        fontSize: 10, color: "var(--gooni-muted, #8E8E93)",
      }}>
        {remaining - 1} more in queue after this
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
  const [pending, setPending] = useState(false);

  const serverComment = msg.rating?.comment ?? "";
  const commentDirty = serverComment !== comment;
  const canSave = !!rating && commentDirty && !pending;

  // Single source of truth for persistence. Backend requires rating ∈ {1,2,3},
  // so comment-only edits stay client-side until the user picks a rating.
  async function save(nextRating: 1 | 2 | 3, nextComment: string | null) {
    setPending(true);
    try {
      await putMessageRating(segmentId, msg.id, {
        rating: nextRating,
        comment: nextComment,
      });
      qc.invalidateQueries({ queryKey: ["eval-segment-full", segmentId] });
    } catch (e) {
      console.error("rating save failed", e);
    } finally {
      setPending(false);
    }
  }

  // Bubble shape: user = one bubble; assistant = N bubbles split by the same
  // logic the bot channels used at send-time so the eval surface reads as the
  // exact phone-side conversation.
  const bubbles = useMemo(() => {
    if (!msg.content) return [];
    return isAssistant ? splitForBubbles(msg.content) : [msg.content];
  }, [msg.content, isAssistant]);

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      alignItems: isAssistant ? "flex-start" : "flex-end",
      marginBottom: 14,
    }}>
      {/* Bubble stack — tight vertical gap mimics multi-message phone view. */}
      <div style={{
        display: "flex", flexDirection: "column", gap: 4,
        alignItems: isAssistant ? "flex-start" : "flex-end",
        maxWidth: "82%",
      }}>
        {bubbles.length === 0 ? (
          <div style={{
            fontSize: 12, fontStyle: "italic",
            color: "var(--gooni-muted, #8E8E93)",
          }}>(empty)</div>
        ) : (
          bubbles.map((b, i) => {
            const isFirst = i === 0;
            const isLast = i === bubbles.length - 1;
            // iMessage-style tail logic: tighten the corner only on the very
            // last bubble of the stack (closest to the avatar/edge).
            const tailRadius = "4px";
            const full = "18px";
            const borderRadius = isAssistant
              ? `${full} ${full} ${full} ${isLast ? tailRadius : full}`
              : `${full} ${full} ${isLast ? tailRadius : full} ${full}`;
            return (
              <div
                key={i}
                style={{
                  padding: "10px 14px",
                  borderRadius,
                  // Calm/warm palette — Claude-app inspired. User bubble is
                  // a soft cream tint (not stark black) so the surface reads
                  // restrained on the Ops console. Assistant stays neutral
                  // off-white.
                  background: isAssistant ? "#F7F5F1" : "#EFE5D6",
                  color: "#2C2A26",
                  border: isAssistant ? "0.5px solid rgba(0,0,0,0.05)" : "0.5px solid rgba(180,150,100,0.18)",
                  fontSize: 14,
                  fontFamily: FONT,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  marginTop: isFirst ? 0 : 0,
                }}
              >
                {isAssistant ? renderMarkdown(b) : b}
              </div>
            );
          })
        )}
      </div>

      {/* Gooni's self-take (Reflexion row). Surfaces sev ≥ 2 only — clean
          turns are still persisted for classifier eval but not shown here.
          Same rule the dedicated Eval page uses. */}
      {isAssistant && msg.reflection && msg.reflection.severity >= 2 && (
        <SelfTakeInline reflection={msg.reflection} />
      )}

      {isAssistant && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6, maxWidth: "82%", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {[1, 2, 3].map((r) => {
              const active = rating === r;
              const icon = r === 1
                ? <X size={14} strokeWidth={3} />
                : r === 2
                  ? <Minus size={14} strokeWidth={3} />
                  : <Check size={14} strokeWidth={3} />;
              return (
                <button
                  key={r}
                  onClick={() => {
                    setRating(r as 1 | 2 | 3);
                    void save(r as 1 | 2 | 3, comment || null);
                  }}
                  title={RATING_LABEL[r]}
                  style={{
                    width: 28, height: 28, borderRadius: 8,
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    background: active ? RATING_COLOR[r] : "var(--gooni-card, #fff)",
                    border: `0.5px solid ${active ? RATING_COLOR[r] : "rgba(0,0,0,0.14)"}`,
                    color: active ? "#fff" : RATING_COLOR[r],
                    cursor: "pointer",
                    padding: 0, fontFamily: "inherit",
                    transition: "background 120ms ease, color 120ms ease, transform 120ms ease",
                    transform: active ? "scale(1.05)" : "scale(1)",
                  }}
                >
                  {icon}
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
          </div>
          {commentOpen && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                placeholder={rating ? "what went wrong / right" : "pick a rating to save a note"}
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
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                {commentDirty && (
                  <button
                    onClick={() => setComment(serverComment)}
                    disabled={pending}
                    style={{
                      padding: "4px 10px", borderRadius: 6,
                      border: "0.5px solid rgba(0,0,0,0.12)",
                      background: "transparent",
                      color: "var(--gooni-muted, #6E6E73)",
                      fontSize: 11, fontWeight: 500,
                      cursor: pending ? "wait" : "pointer", fontFamily: "inherit",
                    }}
                  >
                    Cancel
                  </button>
                )}
                <button
                  onClick={() => rating && void save(rating, comment.trim() || null)}
                  disabled={!canSave}
                  title={!rating ? "pick a rating first" : !commentDirty ? "no changes" : "save note"}
                  style={{
                    padding: "4px 10px", borderRadius: 6,
                    border: "none",
                    background: canSave ? "#0A84FF" : "rgba(0,0,0,0.06)",
                    color: canSave ? "#fff" : "var(--gooni-muted, #8E8E93)",
                    fontSize: 11, fontWeight: 600,
                    cursor: canSave ? "pointer" : "not-allowed",
                    fontFamily: "inherit",
                  }}
                >
                  {serverComment ? "Save" : "Add note"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Gooni's self-take (inline reflexion card) ────────────────────────
// Mirror of EvalView's SelfTakePanel, embedded in the Ops eval drilldown so
// chat audit and eval surfaces have parity on this block. Sev 2 = notable
// (yellow), sev 3 = load-bearing (red). Sev 1 is filtered upstream.
function SelfTakeInline({ reflection }: { reflection: EvalReflectionInline }) {
  const palette = reflection.severity === 3
    ? { bg: "#FFF5F5", border: "#FFD3D3", accent: "#FF3B30", label: "load-bearing" }
    : { bg: "#FFFBEA", border: "#FFE6A6", accent: "#FF9500", label: "notable" };
  return (
    <div style={{
      marginTop: 8, maxWidth: "82%",
      padding: "8px 10px",
      background: palette.bg,
      border: `1px solid ${palette.border}`,
      borderLeft: `3px solid ${palette.accent}`,
      borderRadius: 8,
    }}>
      <div style={{
        fontSize: 10, textTransform: "uppercase", letterSpacing: 0.3,
        color: palette.accent, fontWeight: 600, marginBottom: 4,
      }}>
        Gooni's self-take · sev {reflection.severity} · {palette.label} · {reflection.action_vs_described}
      </div>
      {reflection.critique_summary && (
        <div style={{ fontSize: 12.5, color: "#1C1C1E", marginBottom: 3 }}>
          <strong>Daniel pushed back:</strong> {reflection.critique_summary}
        </div>
      )}
      {reflection.gap_exposed && (
        <div style={{ fontSize: 12.5, color: "#1C1C1E", marginBottom: 3 }}>
          <strong>Gap:</strong> {reflection.gap_exposed}
        </div>
      )}
      {reflection.proposed_self_fix && (
        <div style={{ fontSize: 12.5, color: "#1C1C1E" }}>
          <strong>Proposed fix:</strong> {reflection.proposed_self_fix}
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
            search: { note: undefined, conv: undefined, list: backlogList.id, audit: undefined, segment: undefined },
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
  // Warm dark instead of pure black — softer Claude-app palette so the
  // primary action doesn't feel stark on the Ops console.
  background: "#3A3733",
  color: "#FBF8F2",
  fontSize: 11, fontWeight: 500, cursor: "pointer",
  fontFamily: FONT,
};
