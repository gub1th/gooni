import { useEffect, useRef, useState } from "react";
import { Smile } from "lucide-react";
import {
  fetchReactions,
  toggleReaction,
  type ReactionBucket,
  type ReactionTarget,
} from "../services/api";
import { getReactorId } from "../utils/reactorId";

// Confluence-style reaction bar. Always shows a baseline starter set
// (❤️ 🔥 👍) even at zero count so first-time viewers have an obvious
// click affordance. Other emojis appear once anyone has used them. The
// "+" trigger opens a picker with a wider set so the bar doesn't dump
// 16 zero-count pills on every page.
const STARTER_EMOJIS = ["❤️", "🔥", "👍"];

// Wider picker set. Keep this list deliberately small — adding more is
// fine but the bar should feel curated, not like a full emoji keyboard.
const PICKER_EMOJIS = [
  "❤️", "🔥", "👍", "😂", "👀", "🎉",
  "💀", "🤝", "🙌", "💯", "🧠", "🚀",
  "👏", "🤔", "🥲", "✨",
];

type PillView = ReactionBucket & { starter?: boolean };

function mergeWithStarters(rows: ReactionBucket[]): PillView[] {
  const byEmoji = new Map(rows.map((r) => [r.emoji, r]));
  const out: PillView[] = [];
  // Render starters first (in fixed order) so the bar's left edge is
  // predictable across notes.
  for (const e of STARTER_EMOJIS) {
    const r = byEmoji.get(e);
    out.push({
      emoji: e,
      count: r?.count ?? 0,
      reacted_by_me: r?.reacted_by_me ?? false,
      starter: true,
    });
    byEmoji.delete(e);
  }
  // Then any non-starter emojis with count > 0, sorted by count desc.
  const extras = Array.from(byEmoji.values()).sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
  for (const r of extras) {
    if (r.count > 0) out.push(r);
  }
  return out;
}

export function ReactionBar({
  targetType,
  targetId,
  compact = false,
}: {
  targetType: ReactionTarget;
  targetId: number;
  // When true, render in a tighter footprint suited for comment rows.
  compact?: boolean;
}) {
  const [rows, setRows] = useState<ReactionBucket[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const reactorId = getReactorId();

  useEffect(() => {
    let cancelled = false;
    fetchReactions(targetType, targetId, reactorId)
      .then((r) => { if (!cancelled) setRows(r); })
      .catch(() => { /* silent — empty bar is fine */ });
    return () => { cancelled = true; };
  }, [targetType, targetId, reactorId]);

  // Close picker on outside click.
  useEffect(() => {
    if (!pickerOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!pickerRef.current) return;
      if (!pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [pickerOpen]);

  async function react(emoji: string) {
    if (pending) return;
    setPending(true);
    try {
      const next = await toggleReaction(targetType, targetId, emoji, reactorId);
      setRows(next);
    } catch (e) {
      console.warn("[ReactionBar] toggle failed", e);
    } finally {
      setPending(false);
    }
  }

  const pills = mergeWithStarters(rows);
  const pillSize = compact ? 22 : 26;
  const fontSize = compact ? 12 : 13;
  const countSize = compact ? 10.5 : 11;

  return (
    <div
      style={{
        display: "inline-flex", alignItems: "center", flexWrap: "wrap",
        gap: 4,
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      {pills.map((p) => {
        // Zero-count starters render dimmed so they don't visually
        // compete with reacted pills; click pops them to full opacity.
        const dim = p.starter && p.count === 0;
        return (
          <button
            key={p.emoji}
            onClick={() => react(p.emoji)}
            disabled={pending}
            title={p.reacted_by_me ? "Click to remove your reaction" : "React"}
            style={{
              display: "inline-flex", alignItems: "center", gap: 3,
              height: pillSize,
              padding: "0 7px",
              borderRadius: 999,
              border: `1px solid ${p.reacted_by_me ? "rgba(15,110,86,0.55)" : "rgba(15,23,42,0.10)"}`,
              background: p.reacted_by_me ? "rgba(15,110,86,0.10)" : (dim ? "transparent" : "rgba(15,23,42,0.035)"),
              color: p.reacted_by_me ? "#0F6E56" : "#475569",
              cursor: pending ? "wait" : "pointer",
              fontSize,
              opacity: dim ? 0.6 : 1,
              transition: "background 0.12s, opacity 0.12s, border-color 0.12s",
              fontVariantNumeric: "tabular-nums",
              lineHeight: 1,
            }}
            onMouseEnter={(e) => {
              if (!p.reacted_by_me) (e.currentTarget as HTMLButtonElement).style.opacity = "1";
            }}
            onMouseLeave={(e) => {
              if (dim && !p.reacted_by_me) (e.currentTarget as HTMLButtonElement).style.opacity = "0.6";
            }}
          >
            <span aria-hidden>{p.emoji}</span>
            {p.count > 0 && (
              <span style={{ fontSize: countSize, fontWeight: 600 }}>{p.count}</span>
            )}
          </button>
        );
      })}

      <div ref={pickerRef} style={{ position: "relative" }}>
        <button
          onClick={() => setPickerOpen((o) => !o)}
          title="Add reaction"
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: pillSize, height: pillSize,
            padding: 0,
            borderRadius: 999,
            border: "1px dashed rgba(15,23,42,0.18)",
            background: "transparent",
            color: "var(--gooni-faint, #94A3B8)",
            cursor: "pointer",
          }}
        >
          <Smile size={compact ? 12 : 13} />
        </button>
        {pickerOpen && (
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              left: 0,
              zIndex: 30,
              background: "var(--gooni-card, #fff)",
              borderRadius: 10,
              padding: 6,
              boxShadow: "0 8px 22px rgba(15,23,42,0.14), 0 1px 3px rgba(15,23,42,0.10), inset 0 0 0 0.5px rgba(15,23,42,0.06)",
              display: "grid",
              gridTemplateColumns: "repeat(8, auto)",
              gap: 2,
            }}
          >
            {PICKER_EMOJIS.map((e) => (
              <button
                key={e}
                onClick={() => { react(e); setPickerOpen(false); }}
                style={{
                  width: 28, height: 28,
                  borderRadius: 6,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  fontSize: 16,
                }}
                onMouseEnter={(ev) => ((ev.currentTarget as HTMLButtonElement).style.background = "rgba(15,23,42,0.06)")}
                onMouseLeave={(ev) => ((ev.currentTarget as HTMLButtonElement).style.background = "transparent")}
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
