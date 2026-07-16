import { useCallback, useEffect, useRef, useState } from "react";
import { SearchCheck } from "lucide-react";
import { FONT } from "../../ui";
import { fetchActivity, type ActivityItem } from "../../services/api";
import { TurnTracePanel } from "./TurnTracePanel";

// The always-on activity rail — the unified "true log" (PRD note #397) rendered
// down the right edge: chats (every channel) + notes + promise events +
// trackables (Whoop/LeetCode ride in as trackables), newest at the top. Scroll
// down = back in time (infinite, paginated via the `before` cursor); a 20s poll
// prepends anything new. Bare text on the void (no frost) with a hairline
// separator + soft top/bottom fade. Assistant turns keep the per-turn audit
// affordance (→ TurnTracePanel) ported from the recent-chat ribbon this rail
// replaces — one log surface, not three.

export const RAIL_W = 300;
const POLL_MS = 20_000;
const PAGE = 40;
const OLDER_PAGE = 30;

const SOURCE_BADGE: Record<string, string> = { whatsapp: "wa", telegram: "tg", imessage: "im" };
const GREEN = "rgba(74,222,128,";

function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function labelFor(it: ActivityItem): { label: string; color: string } {
  switch (it.kind) {
    case "message":
      return it.role === "assistant"
        ? { label: "gooni", color: GREEN + "0.75)" }
        : { label: SOURCE_BADGE[it.source ?? ""] ?? "you", color: "rgba(244,245,244,0.42)" };
    case "note":
      return { label: it.verb === "edited" ? "note ·edit" : "note", color: "rgba(150,180,255,0.6)" };
    case "promise":
      return {
        label: `promise ${it.verb ?? ""}`.trim(),
        color: it.state === "kept" ? GREEN + "0.8)"
          : it.state === "broken" ? "rgba(248,150,150,0.75)"
          : "rgba(244,245,244,0.42)",
      };
    case "trackable":
      return { label: "logged", color: GREEN + "0.5)" };
    default:
      return { label: "", color: "rgba(244,245,244,0.42)" };
  }
}

function Row({ item, onAudit }: { item: ActivityItem; onAudit: () => void }) {
  const meta = labelFor(item);
  const canAudit = item.kind === "message" && item.role === "assistant" && !!item.has_trace;
  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 3, paddingRight: canAudit ? 20 : 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: meta.color, flexShrink: 0 }}>
          {meta.label}
        </span>
        <span style={{ fontSize: 9.5, color: "rgba(244,245,244,0.25)", marginLeft: "auto", flexShrink: 0 }}>
          {ago(item.at)}
        </span>
      </div>
      <div style={{
        fontSize: 12.5, lineHeight: 1.45, color: "rgba(244,245,244,0.82)",
        display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden",
      }}>
        {item.text || "…"}
      </div>
      {canAudit && (
        <button
          aria-label="Audit this turn"
          title="Inspect the trace for this turn"
          onClick={onAudit}
          style={{
            position: "absolute", top: 0, right: 0, width: 20, height: 20, padding: 0,
            border: "none", background: "transparent", cursor: "pointer", color: GREEN + "0.7)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <SearchCheck size={12} />
        </button>
      )}
    </div>
  );
}

export function ActivityRail({ hidden }: { hidden?: boolean }) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [traceId, setTraceId] = useState<number | null>(null);
  const loadingOlder = useRef(false);
  const seen = useRef<Set<string>>(new Set());

  // initial load + poll: prepend anything unseen at the top
  useEffect(() => {
    let cancelled = false;
    async function loadNewest() {
      try {
        const rows = await fetchActivity({ limit: PAGE });
        if (cancelled) return;
        setItems((prev) => {
          if (prev.length === 0) {
            seen.current = new Set(rows.map((r) => r.key));
            return rows;
          }
          const fresh = rows.filter((r) => !seen.current.has(r.key));
          if (fresh.length === 0) return prev;
          fresh.forEach((r) => seen.current.add(r.key));
          return [...fresh, ...prev].sort((a, b) => (a.at < b.at ? 1 : -1));
        });
      } catch {
        /* transient — keep last good */
      }
    }
    void loadNewest();
    const iv = window.setInterval(loadNewest, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, []);

  const loadOlder = useCallback(async () => {
    if (loadingOlder.current || !hasMore || items.length === 0) return;
    loadingOlder.current = true;
    try {
      const before = items[items.length - 1].at;
      const older = await fetchActivity({ before, limit: OLDER_PAGE });
      const fresh = older.filter((r) => !seen.current.has(r.key));
      if (fresh.length === 0) {
        setHasMore(false);
        return;
      }
      fresh.forEach((r) => seen.current.add(r.key));
      setItems((prev) => [...prev, ...fresh]);
    } catch {
      /* transient */
    } finally {
      loadingOlder.current = false;
    }
  }, [hasMore, items]);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 220) void loadOlder();
  }

  if (hidden) return null;

  return (
    <>
      <div
        data-activity-rail
        onScroll={onScroll}
        style={{
          position: "fixed", top: 0, right: 0, bottom: 0, width: RAIL_W, zIndex: 6,
          fontFamily: FONT, overflowY: "auto", overflowX: "hidden",
          padding: "54px 18px 40px 18px",
          borderLeft: "1px solid rgba(244,245,244,0.06)",
          maskImage: "linear-gradient(to bottom, transparent 0, #000 46px, #000 calc(100% - 24px), transparent 100%)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0, #000 46px, #000 calc(100% - 24px), transparent 100%)",
        }}
      >
        <div style={{ fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: "rgba(244,245,244,0.28)", marginBottom: 14 }}>
          log
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {items.map((it) => (
            <Row key={it.key} item={it} onAudit={() => it.message_id && setTraceId(it.message_id)} />
          ))}
          {items.length === 0 && (
            <div style={{ fontSize: 12, color: "rgba(244,245,244,0.3)" }}>nothing yet</div>
          )}
          {!hasMore && items.length > 0 && (
            <div style={{ fontSize: 10.5, color: "rgba(244,245,244,0.22)", textAlign: "center", paddingTop: 6 }}>
              — beginning —
            </div>
          )}
        </div>
      </div>
      {traceId != null && <TurnTracePanel messageId={traceId} onClose={() => setTraceId(null)} />}
    </>
  );
}
