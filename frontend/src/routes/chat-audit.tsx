import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  fetchChatAudit, deleteMemory,
  type ChatAuditEntry, type ChatAuditActiveRule,
  type ChatAuditDebug, type ChatAuditDebugMemory,
} from "../services/api";
import { PasswordGate } from "../components/PasswordGate";
import { Sidebar } from "../components/notes/Sidebar";
import { GooniLayer } from "../components/GooniLayer";
import { useWindowWidth } from "../hooks/useWindowWidth";

export const Route = createFileRoute("/chat-audit")({
  component: ChatAuditPage,
});

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";
const SIDEBAR_BREAKPOINT = 768;

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const hasOffset = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
  const diff = Date.now() - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  const mo = Math.floor(days / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function ChatAuditPage() {
  const navigate = useNavigate();
  const windowWidth = useWindowWidth();
  const [sidebarOpen, setSidebarOpen] = useState(windowWidth >= SIDEBAR_BREAKPOINT);
  useEffect(() => {
    setSidebarOpen(windowWidth >= SIDEBAR_BREAKPOINT);
  }, [windowWidth >= SIDEBAR_BREAKPOINT]);

  const [hasFeedbackOnly, setHasFeedbackOnly] = useState(false);
  const [entries, setEntries] = useState<ChatAuditEntry[]>([]);
  const [activeRules, setActiveRules] = useState<ChatAuditActiveRule[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function load() {
    setLoading(true);
    try {
      const res = await fetchChatAudit({ hasFeedbackOnly, limit: 200 });
      setEntries(res.entries);
      setActiveRules(res.active_rules);
      setTotal(res.total);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFeedbackOnly]);

  async function handleDismissRule(rule: ChatAuditActiveRule) {
    if (!confirm(`Remove this feedback rule?\n\n"${rule.rule}"`)) return;
    try {
      await deleteMemory(rule.memory_id);
      setActiveRules((prev) => prev.filter((r) => r.memory_id !== rule.memory_id));
    } catch (e) {
      alert("Dismiss failed.");
      console.error(e);
    }
  }

  function gotoDashboard() {
    navigate({ to: "/", search: { note: undefined, conv: undefined } });
  }

  return (
    <PasswordGate>
      <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: "#FAFAFA" }}>
        {sidebarOpen && (
          <Sidebar
            isDashboard={false}
            isNotes={false}
            isChat={false}
            showCompose={true}
            onLogoClick={gotoDashboard}
            onSpaceSelect={gotoDashboard}
            onCompose={gotoDashboard}
            onNewChat={gotoDashboard}
          />
        )}

        <div style={{ flex: 1, overflowY: "auto", fontFamily: FONT }}>
          <div style={{ maxWidth: 980, margin: "0 auto", padding: "32px 32px 80px" }}>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 18 }}>
              <div>
                <h1 style={{ fontSize: 26, fontWeight: 700, color: "#1C1C1E", margin: 0, letterSpacing: "-0.4px" }}>
                  Chat audit
                </h1>
                <p style={{ fontSize: 13, color: "#8E8E93", margin: "4px 0 0" }}>
                  Every Gooni reply, with any feedback you gave inline. {total} replies.
                </p>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <label style={{
                  fontSize: 12, color: "#6E6E73",
                  display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                  userSelect: "none",
                }}>
                  <input
                    type="checkbox"
                    checked={hasFeedbackOnly}
                    onChange={(e) => setHasFeedbackOnly(e.target.checked)}
                  />
                  with feedback only
                </label>
                <button
                  onClick={() => load()}
                  style={{
                    padding: "6px 12px", borderRadius: 8,
                    border: "1px solid rgba(0,0,0,0.1)",
                    background: "#fff", cursor: "pointer", fontSize: 12, fontFamily: FONT,
                  }}
                >
                  Refresh
                </button>
              </div>
            </div>

            {/* Active feedback rules — what's currently steering Gooni */}
            <div style={{
              background: "#fff",
              border: "1px solid rgba(0,0,0,0.08)",
              borderRadius: 12,
              padding: "14px 16px",
              marginBottom: 18,
            }}>
              <div style={{
                fontSize: 11, fontWeight: 600, letterSpacing: 0.4,
                textTransform: "uppercase", color: "#8E8E93", marginBottom: 10,
              }}>
                Active feedback rules ({activeRules.length})
              </div>
              {activeRules.length === 0 ? (
                <div style={{ fontSize: 13, color: "#AEAEB2" }}>
                  No active rules. Reply to a Gooni message with a correction (e.g. "less teacher-y") to add one.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {activeRules.map((r) => (
                    <div
                      key={r.memory_id}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        padding: "8px 12px", borderRadius: 8,
                        background: "rgba(74,222,128,0.10)",
                        border: "1px solid rgba(22,163,74,0.18)",
                      }}
                    >
                      <div style={{ fontSize: 13, color: "#1C1C1E", lineHeight: 1.4 }}>
                        {r.rule}
                        <span style={{ marginLeft: 10, fontSize: 11, color: "#6E6E73" }}>
                          · {relativeTime(r.created_at)}
                        </span>
                      </div>
                      <button
                        onClick={() => handleDismissRule(r)}
                        style={{
                          padding: "4px 10px", fontSize: 11.5,
                          fontFamily: FONT, fontWeight: 500,
                          border: "1px solid rgba(0,0,0,0.1)",
                          background: "transparent", color: "#6E6E73",
                          borderRadius: 6, cursor: "pointer",
                        }}
                        title="Deactivate this rule"
                      >
                        dismiss
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Audit feed */}
            <div style={{
              background: "#fff",
              border: "1px solid rgba(0,0,0,0.08)",
              borderRadius: 12,
              overflow: "hidden",
            }}>
              <div style={{
                display: "grid",
                gridTemplateColumns: "110px 80px 1fr",
                gap: 0,
                padding: "10px 16px",
                fontSize: 11, color: "#8E8E93", letterSpacing: 0.4,
                textTransform: "uppercase", fontWeight: 600,
                background: "#F8F8F9",
                borderBottom: "1px solid rgba(0,0,0,0.06)",
              }}>
                <div>Time</div>
                <div>Source</div>
                <div>Reply</div>
              </div>

              {loading && entries.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: "#AEAEB2", fontSize: 13 }}>
                  Loading…
                </div>
              ) : entries.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: "#AEAEB2", fontSize: 13 }}>
                  {hasFeedbackOnly ? "No feedback logged yet." : "No replies yet."}
                </div>
              ) : (
                entries.map((e) => (
                  <div
                    key={e.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "110px 80px 1fr",
                      gap: 0,
                      padding: "12px 16px",
                      fontSize: 13,
                      borderBottom: "1px solid rgba(0,0,0,0.05)",
                      alignItems: "flex-start",
                    }}
                  >
                    <div style={{ color: "#8E8E93", fontSize: 12 }}>
                      {relativeTime(e.created_at)}
                    </div>
                    <div>
                      <span style={{
                        display: "inline-flex", alignItems: "center",
                        padding: "2px 7px", borderRadius: 999,
                        background: e.conversation_source === "telegram"
                          ? "rgba(37,99,235,0.13)"
                          : "rgba(107,114,128,0.13)",
                        color: e.conversation_source === "telegram" ? "#2563EB" : "#4B5563",
                        fontSize: 10.5, fontWeight: 600,
                        textTransform: "capitalize",
                      }}>
                        {e.conversation_source ?? "—"}
                      </span>
                    </div>
                    <div style={{ color: "#1C1C1E", lineHeight: 1.45, paddingRight: 12 }}>
                      <div style={{ whiteSpace: "pre-wrap" }}>{e.content}</div>
                      {e.feedback && (
                        <div style={{
                          marginTop: 8, padding: "8px 10px",
                          borderRadius: 8,
                          background: "rgba(220,38,38,0.06)",
                          border: "1px solid rgba(220,38,38,0.18)",
                          fontSize: 12.5, color: "#7F1D1D",
                        }}>
                          <div style={{
                            fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4,
                            textTransform: "uppercase", color: "#B91C1C",
                            marginBottom: 4,
                          }}>
                            ↳ Daniel said
                          </div>
                          <div style={{ color: "#1C1C1E", whiteSpace: "pre-wrap" }}>
                            {e.feedback.content}
                          </div>
                        </div>
                      )}
                      {e.debug && (
                        <div style={{ marginTop: 8 }}>
                          <button
                            onClick={() => toggleExpand(e.id)}
                            style={{
                              fontSize: 11.5, fontFamily: FONT,
                              color: "#6E6E73", background: "transparent",
                              border: "1px solid rgba(0,0,0,0.08)",
                              borderRadius: 6, padding: "3px 9px",
                              cursor: "pointer",
                            }}
                          >
                            {expanded.has(e.id) ? "▾" : "▸"} behind the scenes
                            {" · "}
                            {e.debug.memories.length} mem{" · "}
                            {e.debug.latency_ms}ms
                          </button>
                          {expanded.has(e.id) && (
                            <DebugPanel debug={e.debug} />
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <GooniLayer />
      </div>
    </PasswordGate>
  );
}

// Type → tab color, matching the /memories palette so the visualizer reads
// at a glance with the rest of the app.
const MEM_TYPE_COLORS: Record<string, { bg: string; fg: string; dot: string }> = {
  preference: { bg: "rgba(74,222,128,0.14)", fg: "#16A34A", dot: "#16A34A" },
  goal:       { bg: "rgba(124,58,237,0.14)", fg: "#7C3AED", dot: "#7C3AED" },
  fact:       { bg: "rgba(37,99,235,0.13)",  fg: "#2563EB", dot: "#2563EB" },
  routine:    { bg: "rgba(234,88,12,0.13)",  fg: "#C2410C", dot: "#EA580C" },
  constraint: { bg: "rgba(220,38,38,0.13)",  fg: "#B91C1C", dot: "#DC2626" },
  episode:    { bg: "rgba(107,114,128,0.13)", fg: "#4B5563", dot: "#6B7280" },
};

function DebugPanel({ debug }: { debug: ChatAuditDebug }) {
  const flags: Array<[string, boolean]> = [
    ["entry note", debug.has_entry_context],
    ["focus", debug.has_focus_context],
    ["lists", debug.has_list_context],
    ["conv summary", debug.has_conv_summary],
  ];
  return (
    <div style={{
      marginTop: 8,
      padding: "10px 12px",
      borderRadius: 8,
      background: "#FAFAFA",
      border: "1px solid rgba(0,0,0,0.06)",
      fontSize: 12,
    }}>
      {/* Stats row */}
      <div style={{
        display: "flex", flexWrap: "wrap", gap: 12,
        marginBottom: 10,
        color: "#6E6E73",
      }}>
        <Stat label="model" value={debug.model || "—"} />
        <Stat label="latency" value={`${debug.latency_ms}ms`} />
        <Stat label="prompt" value={`${debug.prompt_chars} ch`} />
        <Stat label="history" value={`${debug.history_msgs} msgs`} />
        <Stat label="memories" value={`${debug.memories.length}`} />
      </div>

      {/* Context flags */}
      {flags.some(([, v]) => v) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
          {flags.filter(([, v]) => v).map(([label]) => (
            <span key={label} style={{
              fontSize: 10.5, padding: "2px 7px", borderRadius: 999,
              background: "rgba(14,165,233,0.13)", color: "#0369A1",
              fontWeight: 600,
            }}>
              {label}
            </span>
          ))}
        </div>
      )}

      {/* Tools used */}
      {debug.tools_used.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <DebugSectionLabel>tools</DebugSectionLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {debug.tools_used.map((t) => (
              <span key={t} style={{
                fontSize: 10.5, padding: "2px 7px", borderRadius: 999,
                background: "rgba(168,85,247,0.13)", color: "#7C3AED",
                fontWeight: 600,
              }}>
                {t}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Intention */}
      {debug.intention && (
        <div style={{ marginBottom: 10 }}>
          <DebugSectionLabel>intention</DebugSectionLabel>
          <div style={{ color: "#3C3C43", lineHeight: 1.4 }}>
            {debug.intention}
          </div>
        </div>
      )}

      {/* Memories */}
      {debug.memories.length > 0 && (
        <div>
          <DebugSectionLabel>memories injected</DebugSectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {debug.memories.map((m) => <MemoryRow key={m.id} m={m} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function MemoryRow({ m }: { m: ChatAuditDebugMemory }) {
  const c = MEM_TYPE_COLORS[m.type] ?? MEM_TYPE_COLORS.episode;
  // Similarity bar width — preferences (always-injected) get a flat full bar;
  // cosine-retrieved rows show the actual similarity.
  const sim = m.similarity ?? 1;
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "92px 1fr 56px",
      gap: 8,
      alignItems: "center",
      padding: "5px 8px",
      borderRadius: 6,
      background: "#fff",
      border: "1px solid rgba(0,0,0,0.04)",
    }}>
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "1px 7px", borderRadius: 999,
        background: c.bg, color: c.fg,
        fontSize: 10.5, fontWeight: 600,
        textTransform: "capitalize",
      }}>
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: c.dot }} />
        {m.type}
      </span>
      <span style={{
        color: "#1C1C1E", fontSize: 12, lineHeight: 1.4,
        overflow: "hidden", textOverflow: "ellipsis",
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
      }}>
        {m.content}
      </span>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
        <span style={{
          fontSize: 10.5, color: "#6E6E73", fontVariantNumeric: "tabular-nums",
        }}>
          {m.always_inject ? "always" : `${Math.round(sim * 100)}%`}
        </span>
        <div style={{
          width: 50, height: 3, borderRadius: 2,
          background: "rgba(0,0,0,0.06)", overflow: "hidden",
        }}>
          <div style={{
            width: `${Math.round(sim * 100)}%`,
            height: "100%",
            background: m.always_inject ? "#16A34A" : c.dot,
          }} />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span style={{
        fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4,
        textTransform: "uppercase", color: "#9CA3AF",
      }}>{label}</span>
      <span style={{
        fontSize: 12, color: "#1C1C1E", fontVariantNumeric: "tabular-nums",
      }}>{value}</span>
    </div>
  );
}

function DebugSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4,
      textTransform: "uppercase", color: "#9CA3AF",
      marginBottom: 4,
    }}>
      {children}
    </div>
  );
}
