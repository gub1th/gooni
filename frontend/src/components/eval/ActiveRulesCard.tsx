import { useEffect, useState } from "react";
import { color as ctok, FONT } from "../../ui";
import {
  fetchChatAudit, deleteMemory,
  type ChatAuditActiveRule,
} from "../../services/api";
import { relativeTimeShort as relativeTime } from "../../utils/date";

// Active feedback rules — the NL corrections Daniel has given Gooni
// (e.g. "less teacher-y") that are currently steering replies. Originally
// lived inside ChatAuditPanel; extracted so the merged /audit surface can
// mount it at the top of the Conversations tab.
//
// Scroll capped at 320px so a growing rule list doesn't push the segment
// list far down the page.



interface ActiveRulesCardProps {
  // When true, render the collapsed-by-default control shell — header
  // shows the count + expand chevron, body only renders when `open`.
  // Caller owns `open` so the state persists in localStorage at the
  // EvalView level.
  collapsedDefault?: boolean;
  open?: boolean;
  onToggle?: () => void;
}

export function ActiveRulesCard({ collapsedDefault, open: openProp, onToggle }: ActiveRulesCardProps = {}) {
  const [rules, setRules] = useState<ChatAuditActiveRule[]>([]);
  const [loaded, setLoaded] = useState(false);
  const open = openProp ?? !collapsedDefault;

  useEffect(() => {
    let cancelled = false;
    fetchChatAudit({ limit: 0 }).then((res) => {
      if (cancelled) return;
      setRules(res.active_rules);
      setLoaded(true);
    }).catch((e) => {
      console.error("active rules fetch failed", e);
      if (!cancelled) setLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  async function handleDismiss(rule: ChatAuditActiveRule) {
    if (!confirm(`Remove this feedback rule?\n\n"${rule.rule}"`)) return;
    try {
      await deleteMemory(rule.memory_id);
      setRules((prev) => prev.filter((r) => r.memory_id !== rule.memory_id));
    } catch (e) {
      console.error("dismiss failed", e);
    }
  }

  if (!loaded) return null;

  return (
    <div style={{
      background: "#fff",
      border: "1px solid rgba(0,0,0,0.08)",
      borderRadius: 12,
      padding: "12px 16px",
      margin: "16px 24px 0",
      fontFamily: FONT,
    }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: onToggle ? "pointer" : "default",
          fontFamily: FONT,
          color: ctok.text,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          Active feedback rules
        </span>
        <span style={{ fontSize: 12, color: ctok.muted, fontWeight: 500 }}>
          ({rules.length})
        </span>
        {onToggle && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: ctok.muted }}>
            {open ? "collapse ▴" : "expand ▾"}
          </span>
        )}
      </button>
      {!open ? null : rules.length === 0 ? (
        <div style={{ fontSize: 13, color: ctok.faint, marginTop: 10 }}>
          No active rules. Reply to a Gooni message with a correction (e.g. "less teacher-y") to add one.
        </div>
      ) : (
        <div style={{
          display: "flex", flexDirection: "column", gap: 6,
          maxHeight: 320, overflowY: "auto",
          paddingRight: 4,
          marginTop: 10,
        }}>
          {rules.map((r) => (
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
                <span style={{ marginLeft: 10, fontSize: 11, color: "#6E6E73" }}>
                  · {relativeTime(r.created_at)}
                </span>
              </div>
              <button
                onClick={() => handleDismiss(r)}
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
  );
}
