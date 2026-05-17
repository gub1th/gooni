import { useEffect, useState } from "react";
import {
  fetchChatAudit, deleteMemory,
  type ChatAuditActiveRule,
} from "../../services/api";

// Active feedback rules — the NL corrections Daniel has given Gooni
// (e.g. "less teacher-y") that are currently steering replies. Originally
// lived inside ChatAuditPanel; extracted so the merged /audit surface can
// mount it at the top of the Conversations tab.
//
// Scroll capped at 320px so a growing rule list doesn't push the segment
// list far down the page.

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

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

export function ActiveRulesCard() {
  const [rules, setRules] = useState<ChatAuditActiveRule[]>([]);
  const [loaded, setLoaded] = useState(false);

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
      padding: "14px 16px",
      margin: "16px 24px 0",
      fontFamily: FONT,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 600, letterSpacing: 0.4,
        textTransform: "uppercase", color: "#8E8E93", marginBottom: 10,
      }}>
        Active feedback rules ({rules.length})
      </div>
      {rules.length === 0 ? (
        <div style={{ fontSize: 13, color: "#AEAEB2" }}>
          No active rules. Reply to a Gooni message with a correction (e.g. "less teacher-y") to add one.
        </div>
      ) : (
        <div style={{
          display: "flex", flexDirection: "column", gap: 6,
          maxHeight: 320, overflowY: "auto",
          paddingRight: 4,
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
              <div style={{ fontSize: 13, color: "#1C1C1E", lineHeight: 1.4 }}>
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
