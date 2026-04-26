import { useEffect, useState } from "react";
import { useFocusesStore } from "../stores/useFocusesStore";
import { useGooniStore } from "../stores/useGooniStore";
import { useConversationsStore } from "../stores/useConversationsStore";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function dismissKey(focusId: number): string {
  return `gooni-focus-dismiss-${focusId}-${todayKey()}`;
}

export function FocusCheckinCard() {
  const { staleFocuses, fetchStale, heartbeat } = useFocusesStore();
  const isOpen = useGooniStore((s) => s.isOpen);
  const toggle = useGooniStore((s) => s.toggle);
  const newChat = useConversationsStore((s) => s.newChat);
  const send = useConversationsStore((s) => s.send);

  const [dismissed, setDismissed] = useState<Set<number>>(new Set());

  useEffect(() => {
    fetchStale();
  }, [fetchStale]);

  // Pull today's dismissed focus IDs from localStorage on mount.
  useEffect(() => {
    const ids = new Set<number>();
    for (const f of staleFocuses) {
      if (localStorage.getItem(dismissKey(f.id))) ids.add(f.id);
    }
    setDismissed(ids);
  }, [staleFocuses]);

  const visible = staleFocuses.filter((f) => !dismissed.has(f.id));
  if (visible.length === 0) return null;

  const focus = visible[0]; // surface one at a time — quietest possible nudge
  const days = focus.days_since_activity;
  const heat =
    days === null
      ? "you haven't started yet"
      : days === 1
      ? "1 day ago"
      : `${days} days ago`;

  async function talkThrough() {
    newChat();
    if (!isOpen) toggle();
    const seed = `Hey — let's talk about "${focus.name}". What's the latest?`;
    try {
      await send(seed);
    } catch (e) {
      console.error(e);
    }
  }

  async function tap() {
    try {
      await heartbeat(focus.id);
    } catch (e) {
      console.error(e);
    }
  }

  function dismiss() {
    localStorage.setItem(dismissKey(focus.id), "1");
    setDismissed((s) => new Set(s).add(focus.id));
  }

  return (
    <div
      style={{
        background: "rgba(250, 204, 21, 0.08)",
        border: "1px solid rgba(250, 204, 21, 0.35)",
        borderRadius: 12,
        padding: "12px 14px",
        marginBottom: 22,
        fontFamily: FONT,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13 }}>·</span>
        <span style={{
          fontSize: 11, color: "#A16207", letterSpacing: 0.6, textTransform: "uppercase",
        }}>
          check-in
        </span>
      </div>
      <p style={{ fontSize: 13.5, color: "#3C3C43", margin: "0 0 10px", lineHeight: 1.5 }}>
        You haven't worked on <strong>{focus.name}</strong> in {heat}. What's blocking?
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={talkThrough} style={primaryBtn()}>Talk it through</button>
        <button onClick={tap} style={ghostBtn()}>I worked on it</button>
        <button onClick={dismiss} style={subtleBtn()}>Dismiss</button>
      </div>
    </div>
  );
}

function primaryBtn(): React.CSSProperties {
  return {
    background: "#1C1C1E", color: "#fff",
    border: "none", borderRadius: 6, padding: "6px 12px",
    fontFamily: FONT, fontSize: 12, fontWeight: 500, cursor: "pointer",
  };
}

function ghostBtn(): React.CSSProperties {
  return {
    background: "transparent", color: "#3C3C43",
    border: "1px solid rgba(0,0,0,0.15)", borderRadius: 6, padding: "6px 12px",
    fontFamily: FONT, fontSize: 12, cursor: "pointer",
  };
}

function subtleBtn(): React.CSSProperties {
  return {
    background: "transparent", color: "#8E8E93",
    border: "none", borderRadius: 6, padding: "6px 8px",
    fontFamily: FONT, fontSize: 12, cursor: "pointer",
  };
}
