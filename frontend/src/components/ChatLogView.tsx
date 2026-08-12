import { useCallback, useEffect, useRef, useState } from "react";
import { Check, RotateCcw, X } from "lucide-react";
import { FONT, frostInk as ctok } from "../ui";
import { AmbientOverlay } from "./AmbientOverlay";
import {
  dismissMessageGlow,
  fetchMessageLog,
  promoteMessage,
  reextractMessage,
  undoPromoteMessage,
  type LogMessage,
  type SignalPreviewSignal,
} from "../services/api";

// Ambient-loop v2 Slice 3 — the append-only Thought log. Every Message
// across every source (web / whatsapp / telegram) renders as one stream;
// entries the extractor flagged as commitment-shaped get a glow dot in
// the left gutter. Tapping the dot opens a peek panel with Gooni's parse
// + Promote / Dismiss. Promote creates the Promise(s); an undo window
// (UNDO_SECONDS) reverses it exactly. Slice 7 makes this the app's
// default surface — until then it mounts behind ?view=log.

const UNDO_SECONDS = 10;
const POLL_MS = 15_000;

function cadenceLabel(s: SignalPreviewSignal): string | null {
  switch (s.cadence) {
    case "daily": return "daily";
    case "n_per_week": return `${s.cadence_target ?? "?"}x/wk`;
    case "permanent_do": return "always";
    case "permanent_never": return "never";
    default: return null;
  }
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return hm;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}

const SOURCE_BADGE: Record<string, string> = {
  whatsapp: "wa",
  telegram: "tg",
  imessage: "im",
};

export function ChatLogView() {
  const [messages, setMessages] = useState<LogMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [openPeekId, setOpenPeekId] = useState<number | null>(null);
  // messageId → seconds left in the undo window. Entry removed on expiry.
  const [undoLeft, setUndoLeft] = useState<Record<number, number>>({});
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const didInitialScroll = useRef(false);

  const reload = useCallback(async () => {
    try {
      const rows = await fetchMessageLog({ limit: 150 });
      // API returns newest-first; the stream renders oldest → newest.
      setMessages(rows.slice().reverse());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(t);
  }, [reload]);

  // First load lands scrolled to the newest entry. (Optional-call guard:
  // jsdom has no scrollIntoView — the seam test runs headless.)
  useEffect(() => {
    if (!didInitialScroll.current && messages.length > 0) {
      didInitialScroll.current = true;
      bottomRef.current?.scrollIntoView?.({ block: "end" });
    }
  }, [messages]);

  // Undo countdown tick.
  useEffect(() => {
    const ids = Object.keys(undoLeft);
    if (ids.length === 0) return;
    const t = window.setTimeout(() => {
      setUndoLeft((prev) => {
        const next: Record<number, number> = {};
        for (const [id, secs] of Object.entries(prev)) {
          if (secs > 1) next[Number(id)] = secs - 1;
        }
        return next;
      });
    }, 1000);
    return () => window.clearTimeout(t);
  }, [undoLeft]);

  function patchMessage(updated: LogMessage) {
    setMessages((prev) =>
      prev.map((m) => (m.id === updated.id ? { ...m, ...updated } : m)),
    );
  }

  async function onPromote(m: LogMessage) {
    const out = await promoteMessage(m.id);
    patchMessage({ ...m, ...out.message });
    setUndoLeft((prev) => ({ ...prev, [m.id]: UNDO_SECONDS }));
  }

  async function onUndo(m: LogMessage) {
    const out = await undoPromoteMessage(m.id);
    patchMessage({ ...m, ...out.message });
    setUndoLeft((prev) => {
      const next = { ...prev };
      delete next[m.id];
      return next;
    });
  }

  async function onDismiss(m: LogMessage) {
    const out = await dismissMessageGlow(m.id);
    patchMessage({ ...m, ...out.message });
    setOpenPeekId(null);
  }

  async function onRetry(m: LogMessage) {
    try {
      const out = await reextractMessage(m.id);
      patchMessage({ ...m, ...out.message });
    } catch (e) {
      console.error("reextract failed", e);
    }
  }

  return (
    <div
      data-testid="chat-log-view"
      style={{
        fontFamily: FONT,
        height: "100%",
        overflowY: "auto",
        padding: "24px 0 48px",
        background: "var(--gooni-bg, #FFFFFF)",
      }}
    >
      <AmbientOverlay />
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 20px" }}>
        <div style={{
          fontSize: 12, fontWeight: 600, letterSpacing: 1.2,
          textTransform: "uppercase", color: "var(--gooni-muted, #8E8E93)",
          marginBottom: 16,
        }}>
          log
        </div>

        {loading && messages.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)" }}>Loading…</div>
        ) : messages.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--gooni-muted, #8E8E93)", lineHeight: 1.6 }}>
            Nothing yet. Every thought — web, WhatsApp, Telegram — lands here.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {messages.map((m) => (
              <LogRow
                key={m.id}
                message={m}
                peekOpen={openPeekId === m.id}
                undoSecondsLeft={undoLeft[m.id]}
                onTogglePeek={() =>
                  setOpenPeekId((cur) => (cur === m.id ? null : m.id))
                }
                onPromote={() => void onPromote(m)}
                onUndo={() => void onUndo(m)}
                onDismiss={() => void onDismiss(m)}
                onRetry={() => void onRetry(m)}
              />
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function LogRow({
  message: m,
  peekOpen,
  undoSecondsLeft,
  onTogglePeek,
  onPromote,
  onUndo,
  onDismiss,
  onRetry,
}: {
  message: LogMessage;
  peekOpen: boolean;
  undoSecondsLeft: number | undefined;
  onTogglePeek: () => void;
  onPromote: () => void;
  onUndo: () => void;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  const preview = m.signal_preview ?? null;
  const status = preview?.status ?? "pending";
  const glowing = Boolean(m.has_actionable_signal) && status === "pending";
  const extractFailed = status === "extract_failed";
  const justPromoted = status === "promoted" && undoSecondsLeft !== undefined;
  const isUser = m.role === "user";
  const badge = SOURCE_BADGE[m.source];

  return (
    <div>
      <div
        style={{
          display: "flex", alignItems: "flex-start", gap: 10,
          padding: "7px 8px", borderRadius: 8,
          background: peekOpen ? "rgba(10,132,255,0.05)" : "transparent",
        }}
      >
        {/* Gutter — the glow dot. 16px lane keeps rows aligned dot or not. */}
        <div style={{ width: 16, display: "flex", justifyContent: "center", paddingTop: 7 }}>
          {glowing ? (
            <button
              data-testid={`glow-dot-${m.id}`}
              onClick={onTogglePeek}
              title="Gooni noticed a commitment — tap to peek"
              aria-label="Actionable signal"
              style={{
                width: 12, height: 12, padding: 0, borderRadius: 999,
                border: "none", cursor: "pointer",
                background: "var(--gooni-glow-dot, #0A84FF)",
                boxShadow: "0 0 6px 1px var(--gooni-glow-dot, rgba(10,132,255,0.55))",
              }}
            />
          ) : status === "promoted" ? (
            <Check size={11} strokeWidth={2.6} color="#15803D" style={{ marginTop: 1 }} />
          ) : extractFailed ? (
            <button
              data-testid={`retry-dot-${m.id}`}
              onClick={onRetry}
              title="Gooni couldn't process this one — tap to retry"
              aria-label="Extraction failed — retry"
              style={{
                width: 12, height: 12, padding: 0, borderRadius: 999,
                border: "none", cursor: "pointer",
                background: "#D97706",
                boxShadow: "0 0 6px 1px rgba(217,119,6,0.45)",
              }}
            />
          ) : null}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            display: "flex", alignItems: "baseline", gap: 8,
            fontSize: 11, color: "var(--gooni-muted, #8E8E93)", marginBottom: 2,
          }}>
            <span style={{ fontWeight: 600 }}>
              {isUser ? "daniel" : "gooni"}
            </span>
            {badge && (
              <span style={{
                fontWeight: 700, fontSize: 9, letterSpacing: 0.8,
                textTransform: "uppercase", padding: "1px 5px",
                borderRadius: 4, background: "rgba(0,0,0,0.06)",
              }}>
                {badge}
              </span>
            )}
            <span>{timeLabel(m.created_at)}</span>
          </div>
          <div style={{
            fontSize: 13.5, lineHeight: 1.5, whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            color: isUser
              ? "var(--gooni-text, #1C1C1E)"
              : "var(--gooni-muted-strong, #55555A)",
          }}>
            {m.content}
          </div>
        </div>
      </div>

      {/* Peek panel — Gooni's parse + Promote / Dismiss. */}
      {peekOpen && glowing && preview && (
        <div
          data-testid={`peek-panel-${m.id}`}
          style={{
            margin: "2px 8px 8px 34px", padding: "10px 12px",
            borderRadius: 10, border: "1px solid rgba(10,132,255,0.25)",
            background: "rgba(10,132,255,0.05)",
          }}
        >
          {preview.signals.map((s, i) => {
            const cad = cadenceLabel(s);
            return (
              <div key={i} style={{ marginBottom: i < preview.signals.length - 1 ? 8 : 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--gooni-text, #1C1C1E)" }}>
                  {s.summary || s.utterance}
                </div>
                <div style={{
                  display: "flex", gap: 8, marginTop: 3, flexWrap: "wrap",
                  fontSize: 11, color: "var(--gooni-muted, #8E8E93)",
                }}>
                  {cad && (
                    <span style={{
                      fontWeight: 600, padding: "1px 7px", borderRadius: 999,
                      background: "rgba(10,132,255,0.10)", color: ctok.accent,
                    }}>
                      {cad}
                    </span>
                  )}
                  {(s.due_date || s.due_hint) && <span>due {s.due_date || s.due_hint}</span>}
                  {s.is_important && <span style={{ color: "#D97706", fontWeight: 600 }}>important</span>}
                </div>
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <PeekBtn
              testId={`promote-${m.id}`}
              label="Promote"
              onClick={onPromote}
              primary
            >
              <Check size={12} strokeWidth={2.4} />
            </PeekBtn>
            <PeekBtn testId={`dismiss-${m.id}`} label="Dismiss" onClick={onDismiss}>
              <X size={12} strokeWidth={2.4} />
            </PeekBtn>
          </div>
        </div>
      )}

      {/* Undo strip — visible for UNDO_SECONDS after a promote. */}
      {justPromoted && (
        <div style={{
          margin: "2px 8px 8px 34px", display: "flex", alignItems: "center", gap: 8,
          fontSize: 12, color: "var(--gooni-muted, #8E8E93)",
        }}>
          <span style={{ color: "#15803D", fontWeight: 600 }}>promoted</span>
          <button
            data-testid={`undo-${m.id}`}
            onClick={onUndo}
            style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              fontSize: 12, fontWeight: 600, color: ctok.accent,
              background: "transparent", border: "none", cursor: "pointer", padding: 0,
            }}
          >
            <RotateCcw size={11} strokeWidth={2.2} />
            undo ({undoSecondsLeft}s)
          </button>
        </div>
      )}
    </div>
  );
}

function PeekBtn({
  label,
  onClick,
  children,
  primary = false,
  testId,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  primary?: boolean;
  testId?: string;
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        fontSize: 12, fontWeight: 600, padding: "5px 12px",
        borderRadius: 8, cursor: "pointer",
        border: primary ? "none" : "1px solid rgba(0,0,0,0.10)",
        background: primary ? ctok.accent : "var(--gooni-card, #FFFFFF)",
        color: primary ? "#FFFFFF" : "var(--gooni-text, #1C1C1E)",
      }}
    >
      {children}
      {label}
    </button>
  );
}
