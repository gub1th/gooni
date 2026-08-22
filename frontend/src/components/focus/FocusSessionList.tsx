import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { FONT } from "../../ui";
import { listFocusSessions, patchFocusSession, type ServerFocusSession } from "../../services/api";
import { fmtMinutes } from "../../services/focusTime";
import { scoreTier } from "../../services/focusScore";
import { scoreColor } from "./RecapCharts";
import type { FocusPalette } from "./focusPalette";

const HISTORY_LIMIT = 10;

/**
 * Recent SESSIONS — replaces the old promise-attribution history
 * (`FocusHistory.tsx`, deleted). That view ranked PROMISES by focused
 * minutes over a week and opened a small per-promise attribution modal
 * titled "focus session"; it was the closest thing `/focus` had to a
 * sessions list, but it wasn't one — a promise worked on across three
 * sittings was one row with no way to see any single sitting's dashboard.
 * `GET /focus/attribution` (and its `Attributed*` types in `api.ts`) is
 * left in place — nothing in the frontend calls it after this change, but
 * it's additive, additional-surface plumbing rather than dead weight, and
 * deleting a working backend read on a hunch is the wrong trade for what
 * this task needs.
 *
 * Each row here IS a session — the exact unit `FocusSessionRecapView` can
 * open a full dashboard for, `?activity=1` folded in so the score can render
 * without a second request per row.
 */
export function FocusSessionList({
  pal,
  onOpen,
}: {
  pal: FocusPalette;
  onOpen: (sessionId: number) => void;
}) {
  const [sessions, setSessions] = useState<ServerFocusSession[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listFocusSessions({ limit: HISTORY_LIMIT, activity: true })
      // Only STOPPED sessions belong in a "recent sessions" list — the live
      // one (if any) already owns the whole screen as `FocusExpanded`, and a
      // paused-but-not-stopped row would be a session this view has no
      // lifecycle controls for.
      .then((rows) => { if (!cancelled) setSessions(rows.filter((s) => s.state === "stopped")); })
      .catch(() => { if (!cancelled) setErr(true); });
    return () => { cancelled = true; };
  }, []);

  if (err || (sessions && sessions.length === 0)) return null;

  return (
    <div style={{ width: "min(92vw, 460px)", margin: "28px auto 0", fontFamily: FONT }}>
      <div style={{ fontSize: 10.5, letterSpacing: 1, textTransform: "uppercase", color: pal.ink3, marginBottom: 10, textAlign: "center" }}>
        recent sessions
      </div>
      {!sessions ? (
        <div style={{ fontSize: 12, color: pal.ink3, textAlign: "center" }}>loading…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} pal={pal} onOpen={() => onOpen(s.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function whenLabel(iso: string): string {
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `yesterday, ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/**
 * One row: title (renamable inline — the pencil is a SEPARATE click target
 * from the row itself, since the row's own click opens the dashboard) ·
 * when it ran · duration · a score dot when this session was scored.
 */
function SessionRow({
  session,
  pal,
  onOpen,
}: {
  session: ServerFocusSession;
  pal: FocusPalette;
  onOpen: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const [title, setTitle] = useState(session.title);

  async function commit() {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === title) {
      setDraft(title);
      return;
    }
    const prev = title;
    setTitle(next); // optimistic — the row shouldn't wait on the round trip
    try {
      await patchFocusSession(session.id, { title: next });
    } catch {
      setTitle(prev);
      setDraft(prev);
    }
  }

  const score = session.activity?.focus_score;
  const tier = score != null ? scoreTier(score) : null;

  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%",
        padding: "2px 0", cursor: editing ? "default" : "pointer",
      }}
      onClick={editing ? undefined : onOpen}
    >
      {tier && (
        <span
          title={`focus score ${score}`}
          style={{ width: 7, height: 7, borderRadius: 999, background: scoreColor(tier, pal), flexShrink: 0 }}
        />
      )}
      {editing ? (
        <input
          autoFocus
          value={draft}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            else if (e.key === "Escape") { setDraft(title); setEditing(false); }
          }}
          style={{
            flex: 1, minWidth: 0, fontSize: 13, fontFamily: FONT, color: pal.ink2,
            background: "transparent", border: "none", borderBottom: `1px solid ${pal.rule}`,
            padding: 0, outline: "none",
          }}
        />
      ) : (
        <span
          style={{
            flex: 1, minWidth: 0, fontSize: 13, color: pal.ink2,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
          title={title}
        >
          {title}
        </span>
      )}
      <span style={{ fontSize: 11, color: pal.ink3, whiteSpace: "nowrap" }}>
        {whenLabel(session.started_at)}
      </span>
      <span style={{ fontSize: 12, color: pal.ink3, fontVariantNumeric: "tabular-nums", minWidth: 42, textAlign: "right" }}>
        {fmtMinutes(session.focused_minutes)}
      </span>
      {!editing && (
        <button
          aria-label="rename session"
          onClick={(e) => { e.stopPropagation(); setDraft(title); setEditing(true); }}
          style={{
            all: "unset", cursor: "pointer", display: "grid", placeItems: "center",
            padding: 3, color: pal.ink3, flexShrink: 0,
          }}
        >
          <Pencil size={11} />
        </button>
      )}
    </div>
  );
}
