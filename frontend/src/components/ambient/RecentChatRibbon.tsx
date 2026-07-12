import { useEffect, useRef, useState } from "react";
import { SearchCheck } from "lucide-react";
import { FONT } from "../../ui";
import { fetchMessageLog, type LogMessage } from "../../services/api";
import { TurnTracePanel } from "./TurnTracePanel";

// Recent-chat ribbon: hover the band beneath the waveform → today's last ~3
// turns fade in (bottom = newest = most opaque, older dims upward — the same
// recency gradient as the log dots). Bare text on the void, NO frosted glass.
// Hover a turn → an audit icon slides in on its right; click → the fullscreen
// per-turn trace panel. Scope = the current local day only, live (polled), so
// nothing persists past midnight.

const POLL_MS = 20_000;
const MAX_TURNS = 3;
const GRACE_MS = 240;
const SOURCE_BADGE: Record<string, string> = { whatsapp: "wa", telegram: "tg", imessage: "im" };

interface Turn {
  user: LogMessage;
  assistant: LogMessage | null;
  source: string;
}

// Pair each of today's user messages with the next assistant reply in the same
// conversation. Returns oldest→newest, capped to the last MAX_TURNS.
function buildTurns(msgs: LogMessage[]): Turn[] {
  const today = new Date().toDateString();
  const asc = msgs
    .filter((m) => new Date(m.created_at).toDateString() === today && !m.is_feedback)
    .sort((a, b) => a.id - b.id);
  const turns: Turn[] = [];
  for (let i = 0; i < asc.length; i++) {
    const u = asc[i];
    if (u.role !== "user") continue;
    const a = asc
      .slice(i + 1)
      .find((m) => m.conversation_id === u.conversation_id && m.role === "assistant");
    turns.push({ user: u, assistant: a ?? null, source: u.source });
  }
  return turns.slice(-MAX_TURNS);
}

export function RecentChatRibbon({ suppressed }: { suppressed: boolean }) {
  const [messages, setMessages] = useState<LogMessage[]>([]);
  const [hot, setHot] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const [traceId, setTraceId] = useState<number | null>(null);
  const graceTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const rows = await fetchMessageLog({ limit: 40 });
        if (!cancelled) setMessages(rows);
      } catch {
        /* transient — keep last good */
      }
    }
    void load();
    const iv = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, []);

  const turns = buildTurns(messages);

  function enter() {
    if (graceTimer.current) window.clearTimeout(graceTimer.current);
    setHot(true);
  }
  function leave() {
    if (graceTimer.current) window.clearTimeout(graceTimer.current);
    graceTimer.current = window.setTimeout(() => {
      setHot(false);
      setHovered(null);
    }, GRACE_MS);
  }

  return (
    <>
      {!suppressed && turns.length > 0 && (
        <div
          data-chat-ribbon
          onMouseEnter={enter}
          onMouseLeave={leave}
          style={{
            position: "fixed",
            left: "50%",
            transform: "translateX(-50%)",
            top: "calc(44vh + 120px)",
            width: "min(600px, 88vw)",
            zIndex: 4,
            fontFamily: FONT,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            opacity: hot ? 1 : 0,
            transition: "opacity 240ms ease",
            pointerEvents: "auto",
          }}
        >
          {turns.map((t, i) => {
            const recency = turns.length <= 1 ? 1 : i / (turns.length - 1);
            const baseOp = 0.34 + recency * 0.66; // oldest dim → newest full
            const isHov = hovered === i;
            return (
              <div
                key={t.user.id}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered((h) => (h === i ? null : h))}
                style={{
                  position: "relative",
                  opacity: isHov ? 1 : baseOp,
                  transition: "opacity 160ms ease",
                  paddingRight: 30,
                }}
              >
                <Line
                  badge={SOURCE_BADGE[t.source]}
                  who="you"
                  text={t.user.content}
                  accent={false}
                />
                <Line
                  who="gooni"
                  text={t.assistant ? t.assistant.content : "…"}
                  accent
                />

                {t.assistant && (
                  <button
                    aria-label="Audit this turn"
                    title="Inspect the trace for this turn"
                    onClick={() => setTraceId(t.assistant!.id)}
                    style={{
                      position: "absolute",
                      right: 0,
                      top: "50%",
                      transform: "translateY(-50%)",
                      width: 26,
                      height: 26,
                      borderRadius: 7,
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                      color: "rgba(74,222,128,0.85)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      opacity: isHov ? 1 : 0,
                      transition: "opacity 160ms ease",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(74,222,128,0.12)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <SearchCheck size={15} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {traceId != null && (
        <TurnTracePanel messageId={traceId} onClose={() => setTraceId(null)} />
      )}
    </>
  );
}

function Line({
  badge,
  who,
  text,
  accent,
}: {
  badge?: string;
  who: string;
  text: string;
  accent: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, lineHeight: 1.5 }}>
      {badge ? (
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: "rgba(74,222,128,0.7)",
            border: "1px solid rgba(74,222,128,0.3)",
            borderRadius: 4,
            padding: "0 3px",
            flexShrink: 0,
          }}
        >
          {badge}
        </span>
      ) : (
        <span
          style={{
            fontSize: 10.5,
            color: accent ? "rgba(74,222,128,0.8)" : "rgba(244,245,244,0.4)",
            minWidth: 34,
            flexShrink: 0,
          }}
        >
          {who}
        </span>
      )}
      <span
        style={{
          fontSize: 13,
          color: accent ? "rgba(244,245,244,0.78)" : "rgba(244,245,244,0.95)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {text}
      </span>
    </div>
  );
}
