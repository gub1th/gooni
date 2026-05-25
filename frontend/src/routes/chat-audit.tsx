import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { color as ctok, FONT } from "../ui";
import {
  fetchChatAudit, deleteMemory,
  type ChatAuditEntry, type ChatAuditActiveRule,
} from "../services/api";
import { relativeTimeShort as relativeTime } from "../utils/date";

export const Route = createFileRoute("/chat-audit")({
  component: ChatAuditPage,
});

function ChatAuditPage() {
  const [hasFeedbackOnly, setHasFeedbackOnly] = useState(false);
  const [entries, setEntries] = useState<ChatAuditEntry[]>([]);
  const [activeRules, setActiveRules] = useState<ChatAuditActiveRule[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

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

  return (
    <div style={{ flex: 1, overflowY: "auto", fontFamily: FONT, background: ctok.bg }}>
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "32px 32px 80px" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 18 }}>
          <div>
            <h1 style={{ fontSize: 26, fontWeight: 700, color: ctok.text, margin: 0, letterSpacing: "-0.4px" }}>
              Chat audit
            </h1>
            <p style={{ fontSize: 13, color: ctok.muted, margin: "4px 0 0" }}>
              Every Gooni reply, with any feedback you gave inline. {total} replies.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label style={{
              fontSize: 12, color: "var(--gooni-muted, #6E6E73)",
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
                background: "var(--gooni-card, #fff)", cursor: "pointer", fontSize: 12, fontFamily: FONT,
              }}
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Active feedback rules — what's currently steering Gooni */}
        <div style={{
          background: "var(--gooni-card, #fff)",
          border: "1px solid rgba(0,0,0,0.08)",
          borderRadius: 12,
          padding: "14px 16px",
          marginBottom: 18,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, letterSpacing: 0.4,
            textTransform: "uppercase", color: ctok.muted, marginBottom: 10,
          }}>
            Active feedback rules ({activeRules.length})
          </div>
          {activeRules.length === 0 ? (
            <div style={{ fontSize: 13, color: ctok.faint }}>
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
                  <div style={{ fontSize: 13, color: ctok.text, lineHeight: 1.4 }}>
                    {r.rule}
                    <span style={{ marginLeft: 10, fontSize: 11, color: "var(--gooni-muted, #6E6E73)" }}>
                      · {relativeTime(r.created_at)}
                    </span>
                  </div>
                  <button
                    onClick={() => handleDismissRule(r)}
                    style={{
                      padding: "4px 10px", fontSize: 11.5,
                      fontFamily: FONT, fontWeight: 500,
                      border: "1px solid rgba(0,0,0,0.1)",
                      background: "transparent", color: "var(--gooni-muted, #6E6E73)",
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
          background: "var(--gooni-card, #fff)",
          border: "1px solid rgba(0,0,0,0.08)",
          borderRadius: 12,
          overflow: "hidden",
        }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "110px 80px 1fr",
            gap: 0,
            padding: "10px 16px",
            fontSize: 11, color: ctok.muted, letterSpacing: 0.4,
            textTransform: "uppercase", fontWeight: 600,
            background: "var(--gooni-card, #F8F8F9)",
            borderBottom: "1px solid rgba(0,0,0,0.06)",
          }}>
            <div>Time</div>
            <div>Source</div>
            <div>Reply</div>
          </div>

          {loading && entries.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: ctok.faint, fontSize: 13 }}>
              Loading…
            </div>
          ) : entries.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: ctok.faint, fontSize: 13 }}>
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
                <div style={{ color: ctok.muted, fontSize: 12 }}>
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
                <div style={{ color: ctok.text, lineHeight: 1.45, paddingRight: 12 }}>
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
                      <div style={{ color: ctok.text, whiteSpace: "pre-wrap" }}>
                        {e.feedback.content}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
