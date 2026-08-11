import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { FONT, frostInk } from "../../ui";
import { useNowTick } from "../../hooks/useNowTick";
import { GREEN } from "./wavePath";
import { LogTable } from "./LogTable";
import { agePhrase, freshness, sleepClock } from "./whoopFreshness";
import { fmtMinutes, isReadOnlyRollup } from "../../services/focusTime";
import {
  createTrackable,
  fetchDailyNotes,
  fetchLeetcodeToday,
  fetchTrackableDays,
  fetchTrackables,
  fetchWhoopToday,
  logTrackable,
  FEED_REFRESH_MS,
  startWhoopOAuth,
  upsertDailyNote,
  type LeetcodeToday,
  type Trackable,
  type TrackableDay,
  type WhoopToday,
} from "../../services/api";

// Slice B+ — the log surface. The wave gives way to a frosted glass panel of
// trackable columns: each column is today's interactive control (a green dot
// for booleans, a value pill for numbers) with a fading history trail of past
// days stacked above. Tap a boolean to toggle; tap a number to type. "+" adds a
// trackable. Below sit read-only frosted tiles for the passive feeds (whoop,
// leetcode) — which is why this surface can retire the old stats dashboard.
// Only the current day is actionable; the trail is ambient context.

const TRAIL_DAYS = 6;

// shared dark frosted-glass recipe (home is black, so NOT the light overlay card)
const GLASS: React.CSSProperties = {
  background: "color-mix(in srgb, rgb(var(--gooni-surf, 11 15 13)) 55%, transparent)",
  backdropFilter: "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
  border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.10)",
  boxShadow: "0 18px 60px rgba(0,0,0,0.55)",
};

// Which trackables belong on the COMPACT daily-dots glance: skip json feeds
// (whoop/leetcode) and the freeform "note", keep the boolean habits + key
// numbers. Also skip `shortcuts` — iOS device events (app-opens, arrivals) are
// ambient telemetry, not priority; a handful of them crowd the single-row
// glance and bury the OG trackables (they still live in the expanded matrix +
// the activity rail's "device" events, so nothing is lost). The matrix's own
// isDaily (LogTable) deliberately keeps them — the glance is priority-only.
export function isDaily(t: Trackable): boolean {
  if (t.kind === "json") return false;
  if (t.source === "whoop" || t.source === "leetcode") return false;
  if (t.source === "shortcuts") return false;
  // focus-cam telemetry is walled off server-side (never reaches /trackables) —
  // this is belt-and-suspenders so a loosened backend filter can't leak it here.
  if (t.source === "focus_cam") return false;
  if (t.name === "note") return false;
  return true;
}

interface Row {
  t: Trackable;
  days: TrackableDay[]; // newest-first, gap-filled; today = days[0]
}

export function LogDots({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState("");
  const [addKind, setAddKind] = useState<"boolean" | "numeric">("boolean");
  const [shown, setShown] = useState(false); // drives the Y expand/contract
  const [expanded, setExpanded] = useState(false); // full editable matrix
  const [noteDraft, setNoteDraft] = useState(""); // today's daily-log note
  const [labelEditId, setLabelEditId] = useState<number | null>(null); // boolean tag editor
  const [labelDraft, setLabelDraft] = useState("");
  const editRef = useRef<HTMLInputElement | null>(null);
  const labelRef = useRef<HTMLInputElement | null>(null);

  // expand in on mount; contract out before the parent unmounts us
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const requestClose = useCallback(() => {
    setShown(false);
    window.setTimeout(onClose, 230);
  }, [onClose]);

  const load = useCallback(async () => {
    try {
      const all = (await fetchTrackables()).filter(isDaily);
      const withDays = await Promise.all(
        all.map(async (t) => ({ t, days: (await fetchTrackableDays(t.id, 1 + TRAIL_DAYS)).days })),
      );
      // booleans first, then numbers; important first within each
      withDays.sort((a, b) => {
        if (a.t.kind !== b.t.kind) return a.t.kind === "boolean" ? -1 : 1;
        if (a.t.is_important !== b.t.is_important) return a.t.is_important ? -1 : 1;
        return a.t.name.localeCompare(b.t.name);
      });
      setRows(withDays);
      // today's daily-log note (window of 1 → just today)
      try {
        const daily = await fetchDailyNotes(1);
        setNoteDraft((daily[0]?.content || "").replace(/<[^>]+>/g, "").trim() || daily[0]?.excerpt || "");
      } catch { /* ignore */ }
    } catch {
      /* surface stays quiet on error */
    } finally {
      setLoading(false);
    }
  }, []);

  // Today's date = the newest cell of any trackable row (local-day anchored,
  // gap-filled so it's always present).
  const today = rows[0]?.days[0]?.date;

  function commitTodayNote() {
    if (!today) return;
    void upsertDailyNote(today, noteDraft.trim()).catch(() => {});
  }

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    // Escape closes the log surface — but not while the table is expanded
    // (there, Escape belongs to cell-editing / the toggle button owns collapse)
    function onKey(e: KeyboardEvent) { if (e.key === "Escape" && !expanded) requestClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, expanded]);

  async function refreshRow(id: number) {
    try {
      const d = (await fetchTrackableDays(id, 1 + TRAIL_DAYS)).days;
      setRows((prev) => prev.map((r) => (r.t.id === id ? { ...r, days: d } : r)));
    } catch { /* ignore */ }
  }

  async function toggleBool(row: Row) {
    if (isReadOnlyRollup(row.t)) return;
    const cur = row.days[0]?.value === true;
    // optimistic
    setRows((prev) => prev.map((r) => (
      r.t.id === row.t.id
        ? { ...r, days: r.days.map((d, i) => (i === 0 ? { ...d, value: !cur } : d)) }
        : r
    )));
    try { await logTrackable(row.t.id, { value_boolean: !cur, replace: true }); } finally { void refreshRow(row.t.id); }
  }

  function openNumber(row: Row) {
    if (isReadOnlyRollup(row.t)) return;
    const v = row.days[0]?.value;
    setEditId(row.t.id);
    setDraft(typeof v === "number" ? String(v) : "");
    requestAnimationFrame(() => editRef.current?.focus());
  }

  async function commitNumber(row: Row) {
    const raw = draft.trim();
    setEditId(null);
    if (isReadOnlyRollup(row.t)) return;
    // Empty field clears today's cell (valueless replace deletes the row).
    if (raw === "") {
      setRows((prev) => prev.map((r) => (
        r.t.id === row.t.id
          ? { ...r, days: r.days.map((d, i) => (i === 0 ? { ...d, value: null } : d)) }
          : r
      )));
      try { await logTrackable(row.t.id, { replace: true }); } finally { void refreshRow(row.t.id); }
      return;
    }
    const n = parseFloat(raw);
    if (Number.isNaN(n)) return;
    setRows((prev) => prev.map((r) => (
      r.t.id === row.t.id
        ? { ...r, days: r.days.map((d, i) => (i === 0 ? { ...d, value: n } : d)) }
        : r
    )));
    try { await logTrackable(row.t.id, { value_numeric: n, replace: true }); } finally { void refreshRow(row.t.id); }
  }

  function openLabel(row: Row) {
    if (isReadOnlyRollup(row.t)) return;
    setLabelEditId(row.t.id);
    setLabelDraft(row.days[0]?.label ?? "");
    requestAnimationFrame(() => labelRef.current?.focus());
  }

  // Tag today's boolean day. The label rides value_json.label — but replace=true
  // collapses the day, so we MUST resend value_boolean:true or the dot goes dark.
  async function commitLabel(row: Row) {
    const text = labelDraft.trim();
    setLabelEditId(null);
    if (isReadOnlyRollup(row.t)) return;
    // optimistic
    setRows((prev) => prev.map((r) => (
      r.t.id === row.t.id
        ? { ...r, days: r.days.map((d, i) => (i === 0 ? { ...d, label: text || null } : d)) }
        : r
    )));
    const body = text
      ? { value_boolean: true, value_json: { label: text }, replace: true }
      : { value_boolean: true, replace: true };
    try { await logTrackable(row.t.id, body); } finally { void refreshRow(row.t.id); }
  }

  async function addTrackable() {
    const name = addName.trim().toLowerCase();
    if (!name) { setAdding(false); return; }
    setAdding(false);
    setAddName("");
    try {
      await createTrackable({ name, kind: addKind });
      await load();
    } catch { /* ignore */ }
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 6, fontFamily: FONT,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) requestClose(); }}
    >
      {/* animated block — expands/contracts along Y on open/close */}
      <div
        style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          transformOrigin: "center", transform: shown ? "scaleY(1)" : "scaleY(0.55)",
          opacity: shown ? 1 : 0,
          transition: "opacity 230ms ease, transform 230ms cubic-bezier(0.22,1,0.36,1)",
        }}
      >
        <div style={{
          fontSize: 10, letterSpacing: 2, textTransform: "uppercase",
          color: "rgb(var(--gooni-ink, 244 245 244) / 0.3)", marginBottom: 16, height: 12,
          opacity: expanded ? 0 : 1, transition: "opacity 200ms ease",
        }}>
          today
        </div>

        {/* the morphing card — dots ⇄ table live inside one frosted surface that
            grows/shrinks in place; the corner toggle swaps which body shows */}
        <div
          style={{
            ...GLASS, borderRadius: 24, position: "relative", overflow: "hidden",
            width: expanded ? "min(1120px, 94vw)" : "min(720px, 92vw)",
            height: expanded ? "min(80vh, 640px)" : 248,
            transition: "width 300ms cubic-bezier(0.22,1,0.36,1), height 300ms cubic-bezier(0.22,1,0.36,1)",
          }}
        >
          {/* one control: expand (arrows-out) ⇄ collapse (arrows-in) */}
          <button
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? "Collapse" : "Expand to full table"}
            style={{
              position: "absolute", top: 12, right: 14, zIndex: 3,
              width: 26, height: 26, borderRadius: 8, cursor: "pointer", padding: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.12)", background: "rgb(var(--gooni-surf, 11 15 13) / 0.5)",
              color: "rgb(var(--gooni-ink, 244 245 244) / 0.5)",
            }}
          >
            {expanded ? <Minimize2 size={13} strokeWidth={1.8} /> : <Maximize2 size={13} strokeWidth={1.8} />}
          </button>

          {/* dots layer (today's quick driver) */}
          <div
            style={{
              position: "absolute", inset: 0, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", gap: 20,
              padding: "0 30px", opacity: expanded ? 0 : 1, pointerEvents: expanded ? "none" : "auto",
              transition: "opacity 180ms ease",
            }}
          >
            {loading ? (
              <div style={{ color: "rgb(var(--gooni-ink, 244 245 244) / 0.35)", fontSize: 13 }}>loading…</div>
            ) : (
              <>
              <div style={{ display: "flex", gap: 34, alignItems: "flex-end" }}>
                {rows.map((row) => (
                  <Column
                    key={row.t.id}
                    row={row}
                    readOnly={isReadOnlyRollup(row.t)}
                    editing={editId === row.t.id}
                    draft={draft}
                    editRef={editRef}
                    onToggle={() => void toggleBool(row)}
                    onOpenNumber={() => openNumber(row)}
                    onDraft={setDraft}
                    onCommit={() => void commitNumber(row)}
                    onCancel={() => setEditId(null)}
                    labelEditing={labelEditId === row.t.id}
                    labelDraft={labelDraft}
                    labelRef={labelRef}
                    onOpenLabel={() => openLabel(row)}
                    onLabelDraft={setLabelDraft}
                    onLabelCommit={() => void commitLabel(row)}
                    onLabelCancel={() => setLabelEditId(null)}
                  />
                ))}

                {/* add trackable */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <div style={{ height: 66 }} />
                  {adding ? (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                      <input
                        autoFocus
                        value={addName}
                        onChange={(e) => setAddName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void addTrackable(); if (e.key === "Escape") setAdding(false); }}
                        placeholder="name"
                        style={{
                          width: 84, fontSize: 12, padding: "5px 8px", borderRadius: 8, textAlign: "center",
                          border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.25)", background: "rgb(var(--gooni-surf, 11 15 13) / 0.6)",
                          color: "rgb(var(--gooni-ink, 244 245 244))", outline: "none", fontFamily: FONT,
                        }}
                      />
                      <button
                        onClick={() => setAddKind((k) => (k === "boolean" ? "numeric" : "boolean"))}
                        style={{
                          fontSize: 10, padding: "2px 8px", borderRadius: 999, cursor: "pointer",
                          border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.2)", background: "transparent",
                          color: "rgb(var(--gooni-ink, 244 245 244) / 0.6)", fontFamily: FONT,
                        }}
                      >
                        {addKind === "boolean" ? "yes/no" : "number"}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setAdding(true)}
                      aria-label="Add trackable"
                      style={{
                        width: 18, height: 18, borderRadius: 999, cursor: "pointer",
                        border: "1.5px dashed rgb(var(--gooni-ink, 244 245 244) / 0.3)", background: "transparent",
                        color: "rgb(var(--gooni-ink, 244 245 244) / 0.4)", display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 13, lineHeight: 1, padding: 0,
                      }}
                    >
                      +
                    </button>
                  )}
                  <div style={{ fontSize: 11, color: "rgb(var(--gooni-ink, 244 245 244) / 0.45)", marginTop: 12 }}>add</div>
                  {/* mirror Column's tag slot so the row stays bottom-aligned */}
                  <div style={{ height: 13, marginTop: 1 }} />
                </div>
              </div>

              {/* today's note — a freeform "what happened" line under the metrics */}
              {today && (
                <div style={{ width: "min(560px, 88%)", borderTop: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.08)", paddingTop: 13 }}>
                  <input
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    onBlur={commitTodayNote}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitTodayNote(); (e.currentTarget as HTMLInputElement).blur(); } }}
                    placeholder="what happened today?"
                    spellCheck={false}
                    style={{
                      width: "100%", background: "transparent", border: "none", outline: "none",
                      color: "rgb(var(--gooni-ink, 244 245 244))", fontFamily: FONT, fontSize: 13.5, textAlign: "center", caretColor: GREEN,
                    }}
                  />
                </div>
              )}
              </>
            )}
          </div>

          {/* table layer — mounted only when expanded */}
          <div
            style={{
              position: "absolute", inset: 0, opacity: expanded ? 1 : 0,
              pointerEvents: expanded ? "auto" : "none", transition: "opacity 200ms ease 80ms",
            }}
          >
            {expanded && <LogTable />}
          </div>
        </div>

        {/* passive feed tiles — collapse + fade away when expanded */}
        <div style={{
          overflow: "hidden", maxHeight: expanded ? 0 : 160, opacity: expanded ? 0 : 1,
          transition: "max-height 280ms cubic-bezier(0.22,1,0.36,1), opacity 180ms ease",
        }}>
          {!loading && <FeedTiles />}
        </div>
      </div>
    </div>
  );
}

function Column({
  row, editing, draft, editRef, onToggle, onOpenNumber, onDraft, onCommit, onCancel,
  labelEditing, labelDraft, labelRef, onOpenLabel, onLabelDraft, onLabelCommit, onLabelCancel,
  readOnly = false,
}: {
  row: Row;
  editing: boolean;
  /** a derived rollup: still shown, never written from here */
  readOnly?: boolean;
  draft: string;
  editRef: React.RefObject<HTMLInputElement>;
  onToggle: () => void;
  onOpenNumber: () => void;
  onDraft: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  labelEditing: boolean;
  labelDraft: string;
  labelRef: React.RefObject<HTMLInputElement>;
  onOpenLabel: () => void;
  onLabelDraft: (v: string) => void;
  onLabelCommit: () => void;
  onLabelCancel: () => void;
}) {
  const { t, days } = row;
  const today = days[0]?.value;
  const todayLabel = days[0]?.label ?? null;
  // trail: past days (skip today), oldest at top
  const trail = days.slice(1, 1 + TRAIL_DAYS).slice().reverse();
  const n = trail.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      {/* history trail */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7, marginBottom: 6 }}>
        {trail.map((d, i) => {
          const recency = n <= 1 ? 1 : i / (n - 1); // 0 oldest → 1 newest
          const size = 4 + recency * 4;
          const op = 0.12 + recency * 0.32;
          const did = t.kind === "boolean" ? d.value === true : d.value != null;
          return (
            <span
              key={d.date}
              title={`${d.date}: ${d.value ?? "—"}${d.label ? ` · ${d.label}` : ""}`}
              style={{
                width: size, height: size, borderRadius: 999, boxSizing: "border-box",
                background: did ? `rgba(74,222,128,${op})` : "transparent",
                border: did ? "none" : `1px solid rgb(var(--gooni-ink, 244 245 244) / ${op * 0.7})`,
              }}
            />
          );
        })}
      </div>

      {/* today control */}
      {t.kind === "boolean" ? (
        <button
          onClick={onToggle}
          aria-label={`Toggle ${t.name}`}
          style={{
            width: 18, height: 18, borderRadius: 999, cursor: "pointer", padding: 0, boxSizing: "border-box",
            background: today === true ? GREEN : "transparent",
            border: today === true ? "none" : "1.5px solid rgb(var(--gooni-ink, 244 245 244) / 0.45)",
            boxShadow: today === true ? `0 0 10px 1px rgba(74,222,128,0.6)` : "none",
          }}
        />
      ) : readOnly ? (
        <span
          title={`${t.name} is a rollup of its own entries — read only here`}
          style={{
            minWidth: 40, padding: "4px 12px", borderRadius: 999, textAlign: "center",
            border: "1px solid transparent",
            color: "rgb(var(--gooni-ink, 244 245 244) / 0.7)", fontSize: 13, fontWeight: 600, fontFamily: FONT,
          }}
        >
          {typeof today === "number" ? fmtMinutes(today) : "–"}
        </span>
      ) : editing ? (
        <input
          ref={editRef}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onCommit(); if (e.key === "Escape") onCancel(); }}
          onBlur={onCommit}
          inputMode="decimal"
          style={{
            width: 60, fontSize: 13, fontWeight: 600, padding: "4px 8px", borderRadius: 999, textAlign: "center",
            border: `1px solid ${GREEN}`, background: "rgb(var(--gooni-surf, 11 15 13) / 0.7)", color: "rgb(var(--gooni-ink, 244 245 244))",
            outline: "none", fontFamily: FONT,
          }}
        />
      ) : (
        <button
          onClick={onOpenNumber}
          style={{
            minWidth: 40, padding: "4px 12px", borderRadius: 999, cursor: "pointer",
            border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.35)", background: "transparent",
            color: "rgb(var(--gooni-ink, 244 245 244))", fontSize: 13, fontWeight: 600, fontFamily: FONT,
          }}
        >
          {typeof today === "number" ? today : "–"}
        </button>
      )}

      <div style={{ fontSize: 11, color: "rgb(var(--gooni-ink, 244 245 244) / 0.45)", marginTop: 12, letterSpacing: 0.3 }}>
        {t.name}
      </div>

      {/* tag slot (treatment A) — a reserved sliver under every name so the row
          stays bottom-aligned; only a logged boolean fills it. Invisible until
          the dot is green, so substances/untagged days show nothing. */}
      <div style={{ height: 13, marginTop: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {t.kind === "boolean" && today === true && (
          labelEditing ? (
            <input
              ref={labelRef}
              value={labelDraft}
              onChange={(e) => onLabelDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onLabelCommit(); if (e.key === "Escape") onLabelCancel(); }}
              onBlur={onLabelCommit}
              placeholder="push"
              spellCheck={false}
              style={{
                width: 58, fontSize: 10, textAlign: "center", fontFamily: FONT,
                padding: "2px 4px", borderRadius: 6, outline: "none",
                border: `1px solid ${GREEN}`, background: "rgb(var(--gooni-surf, 11 15 13) / 0.8)", color: "rgb(var(--gooni-ink, 244 245 244))",
              }}
            />
          ) : (
            <button
              onClick={onOpenLabel}
              aria-label={todayLabel ? `Edit ${t.name} tag` : `Tag ${t.name}`}
              style={{
                fontSize: 10, letterSpacing: 0.4, fontFamily: FONT, cursor: "pointer",
                padding: "1px 4px", borderRadius: 5, border: "none", background: "transparent",
                color: todayLabel ? "rgba(74,222,128,0.72)" : "rgb(var(--gooni-ink, 244 245 244) / 0.3)",
              }}
            >
              {todayLabel || "+ tag"}
            </button>
          )
        )}
      </div>
    </div>
  );
}

// ── passive feed tiles ──────────────────────────────────────────────────────
// Read-only glass tiles for the whoop/leetcode feeds. Their data is feed-owned
// (not hand-editable), so these are display-only — the reason the log can
// absorb the old stats dashboard.

function FeedTiles() {
  const [whoop, setWhoop] = useState<WhoopToday | null | "err">(null);
  const [lc, setLc] = useState<LeetcodeToday | null | "err">(null);
  // The panel can stay open for hours; without a tick the age below is frozen
  // at mount and the 36h flip could never fire while you are looking at it.
  const now = useNowTick();

  // …and the tick alone is only half of it: an age that advances against a
  // payload fetched once at mount eventually cries "stale" about a strap that
  // resumed syncing hours ago — a live feed made to look dead, the exact
  // inverse of the bug the age exists to catch. So re-pull on the shared feed
  // cadence (the same one the kiosk polls on) and let the age describe data
  // that is actually current.
  useEffect(() => {
    let alive = true;
    // A failed whoop refetch keeps the last good reading — only the FIRST load
    // may fall through to the error/connect state. That guard is safe ONLY
    // because whoop carries a self-advancing age that eventually says "stale";
    // leetcode has no freshness signal, so holding its last payload through an
    // outage would show frozen counts forever. It clears, which is itself the
    // honest signal.
    const pull = () => {
      void fetchWhoopToday()
        .then((d) => { if (alive) setWhoop(d); })
        .catch(() => { if (alive) setWhoop((prev) => (prev === null ? "err" : prev)); });
      void fetchLeetcodeToday()
        .then((d) => { if (alive) setLc(d); })
        .catch(() => { if (alive) setLc("err"); });
    };
    pull();
    const id = window.setInterval(pull, FEED_REFRESH_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  // stale-tag: the served reading may be a day-old sleep (today's hasn't synced)
  const whoopNote = whoop && whoop !== "err" && whoop.day_label ? whoop.day_label : undefined;

  // Footer: sleep window + data age. Age comes from WHOOP's OWN record stamp
  // (source_updated_at), not our poll time — a strap that stopped syncing keeps
  // serving a frozen open-cycle strain, which without this reads as a real (bad)
  // day. Past 36h we say so loudly instead of implying the numbers are current.
  const w = whoop && whoop !== "err" && whoop.date ? whoop : null;
  const fresh = w ? freshness(w.source_updated_at, now) : null;
  const sleepWindow = w ? sleepClock(w.sleep_start_at, w.sleep_end_at) : null;
  const whoopFooter = fresh ? (
    <>
      {sleepWindow && <span>slept {sleepWindow}</span>}
      <span style={{ color: fresh.stale ? frostInk.warn : undefined }}>
        {sleepWindow ? "· " : ""}{agePhrase(fresh)}
      </span>
    </>
  ) : undefined;

  return (
    <div style={{ display: "flex", gap: 14, marginTop: 16 }}>
      <FeedTile title="whoop" note={whoopNote} footer={whoopFooter}>
        {whoop === null ? (
          <Dim>…</Dim>
        ) : whoop === "err" || !whoop.date ? (
          <button
            onClick={() => void startWhoopOAuth().then((r) => { window.location.href = r.authorize_url; }).catch(() => {})}
            style={connectBtn}
          >
            connect
          </button>
        ) : (
          <>
            <Metric label="recovery" value={fmtPct(whoop.recovery_score)} accent />
            <Metric label="strain" value={fmt1(whoop.strain)} />
            <Metric label="sleep" value={whoop.sleep_minutes != null ? `${Math.round(whoop.sleep_minutes / 60 * 10) / 10}h` : "–"} />
          </>
        )}
      </FeedTile>

      <FeedTile title="leetcode">
        {lc === null ? (
          <Dim>…</Dim>
        ) : lc === "err" || !lc.available ? (
          <Dim>—</Dim>
        ) : (
          <>
            <Metric label="today" value={fmt(lc.today_count)} accent />
            <Metric label="streak" value={fmt(lc.streak)} />
            <Metric label="solved" value={fmt(lc.total_solved)} />
          </>
        )}
      </FeedTile>
    </div>
  );
}

function FeedTile({ title, note, children, footer }: {
  title: string; note?: string; children: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <div style={{ ...GLASS, borderRadius: 18, padding: "14px 18px", minWidth: 150 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 10 }}>
        <span style={{
          fontSize: 9, letterSpacing: 1.6, textTransform: "uppercase",
          color: "rgb(var(--gooni-ink, 244 245 244) / 0.35)",
        }}>
          {title}
        </span>
        {note && (
          // amber = "heads up, this reading isn't today's"
          <span style={{ fontSize: 9, letterSpacing: 0.3, color: "rgba(230,190,140,0.85)" }}>
            · {note}
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 16 }}>{children}</div>
      {footer && (
        // Sub-line under the metrics. A hairline carries the separation — no
        // shadow, per the ambient home's flat-frost rule. Ink-var alpha so the
        // rule and the muted text both invert with the theme.
        <div style={{
          marginTop: 11, paddingTop: 8,
          borderTop: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.10)",
          fontSize: 10, letterSpacing: 0.2,
          color: "rgb(var(--gooni-ink, 244 245 244) / 0.4)",
          display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap",
        }}>
          {footer}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ fontSize: 16, fontWeight: 600, color: accent ? GREEN : "rgb(var(--gooni-ink, 244 245 244))", lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 9.5, color: "rgb(var(--gooni-ink, 244 245 244) / 0.4)", letterSpacing: 0.3 }}>{label}</div>
    </div>
  );
}

function Dim({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, color: "rgb(var(--gooni-ink, 244 245 244) / 0.35)" }}>{children}</div>;
}

const connectBtn: React.CSSProperties = {
  fontSize: 11, padding: "4px 12px", borderRadius: 999, cursor: "pointer",
  border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.25)", background: "transparent",
  color: "rgb(var(--gooni-ink, 244 245 244) / 0.6)", fontFamily: FONT,
};

function fmt(v: number | null | undefined): string {
  return v == null ? "–" : String(v);
}
// one-decimal for noisy floats (whoop strain comes back like 20.700724)
function fmt1(v: number | null | undefined): string {
  return v == null ? "–" : (Math.round(v * 10) / 10).toFixed(1);
}
function fmtPct(v: number | null | undefined): string {
  return v == null ? "–" : `${Math.round(v)}`;
}
