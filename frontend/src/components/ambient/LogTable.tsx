import { useCallback, useEffect, useRef, useState } from "react";
import { FONT } from "../../ui";
import { GREEN } from "./wavePath";
import {
  fetchDailyNotes,
  fetchTrackableDays,
  fetchTrackables,
  logTrackable,
  upsertDailyNote,
  type ApiNote,
  type Trackable,
} from "../../services/api";

// The log's expanded view: the whole trackable matrix (dates × trackables),
// every cell editable — including historical days. For when you want to fix up
// many things at once, not just today. Booleans toggle; numbers type; the
// rightmost "note" column is a per-day freeform log ("what happened") backed by
// the Note primitive. Numeric/boolean writes go to the (trackable, date) cell
// via logTrackable replace=true; note writes upsert a daily Note.
//
// Scrolls back in time: the initial window loads the recent days, and scrolling
// toward the bottom pages older windows in and appends them (infinite scroll).
//
// This is an INLINE body — LogDots hosts it inside the shared morphing card, so
// no backdrop/close of its own (the parent owns chrome + open/close).

const INITIAL_DAYS = 21;
const PAGE_DAYS = 21;
const MAX_DAYS = 730; // hard floor on how far back the scroll will page

function isDaily(t: Trackable): boolean {
  if (t.kind === "json") return false;
  if (t.source === "whoop" || t.source === "leetcode") return false;
  if (t.name === "note") return false; // the daily-note column replaces it
  return true;
}

type Cell = boolean | number | null;
type NoteCell = { id: number; text: string };

function stripHtml(html: string | null | undefined): string {
  return (html || "").replace(/<[^>]+>/g, "").trim();
}

// One day earlier, staying in plain-date space (parse + format as UTC so no
// timezone drift creeps into the YYYY-MM-DD cursor).
function isoPrevDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function dailyMapFrom(notes: ApiNote[]): Record<string, NoteCell> {
  const out: Record<string, NoteCell> = {};
  for (const n of notes) {
    if (!n.log_date) continue;
    out[n.log_date] = { id: n.id, text: stripHtml(n.content) || n.excerpt || "" };
  }
  return out;
}

export function LogTable() {
  const [cols, setCols] = useState<Trackable[]>([]);
  const [dates, setDates] = useState<string[]>([]);
  const [cells, setCells] = useState<Record<number, Record<string, Cell>>>({});
  const [notes, setNotes] = useState<Record<string, NoteCell>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  const [edit, setEdit] = useState<{ tid: number; date: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [noteEdit, setNoteEdit] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const editRef = useRef<HTMLInputElement | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const busyMore = useRef(false); // re-entrancy guard for scroll-triggered paging

  // Fetch one window (days ending at `end`) across the given columns + the
  // daily notes for the same span. Returns the spine (newest-first) + grid.
  const fetchWindow = useCallback(
    async (columns: Trackable[], days: number, end?: string) => {
      const withDays = await Promise.all(
        columns.map(async (t) => ({ t, days: (await fetchTrackableDays(t.id, days, end)).days })),
      );
      let spine: string[] = [];
      const grid: Record<number, Record<string, Cell>> = {};
      for (const { t, days: ds } of withDays) {
        if (ds.length > spine.length) spine = ds.map((d) => d.date);
        grid[t.id] = {};
        for (const d of ds) {
          grid[t.id][d.date] =
            typeof d.value === "boolean" || typeof d.value === "number" ? d.value : null;
        }
      }
      const daily = dailyMapFrom(await fetchDailyNotes(days, end));
      return { spine, grid, daily };
    },
    [],
  );

  const load = useCallback(async () => {
    try {
      const all = (await fetchTrackables()).filter(isDaily);
      all.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "boolean" ? -1 : 1;
        if (a.is_important !== b.is_important) return a.is_important ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const { spine, grid, daily } = await fetchWindow(all, INITIAL_DAYS);
      setCols(all);
      setDates(spine);
      setCells(grid);
      setNotes(daily);
    } catch {
      /* quiet */
    } finally {
      setLoading(false);
    }
  }, [fetchWindow]);

  useEffect(() => { void load(); }, [load]);

  const loadMore = useCallback(async () => {
    if (busyMore.current || exhausted || loading) return;
    if (dates.length === 0 || dates.length >= MAX_DAYS) {
      if (dates.length >= MAX_DAYS) setExhausted(true);
      return;
    }
    busyMore.current = true;
    setLoadingMore(true);
    try {
      const end = isoPrevDay(dates[dates.length - 1]);
      const { spine, grid, daily } = await fetchWindow(cols, PAGE_DAYS, end);
      // Nothing but empty cells + no notes in this window → we've paged past
      // all recorded history; stop asking. (fill=true always returns a full
      // window, so day-count can't signal the end — data presence does.)
      const hasData =
        Object.keys(daily).length > 0 ||
        Object.values(grid).some((col) => Object.values(col).some((v) => v != null));
      setDates((prev) => [...prev, ...spine.filter((d) => !prev.includes(d))]);
      setCells((prev) => {
        const next = { ...prev };
        for (const tid of Object.keys(grid)) {
          next[Number(tid)] = { ...next[Number(tid)], ...grid[Number(tid)] };
        }
        return next;
      });
      setNotes((prev) => ({ ...daily, ...prev }));
      if (!hasData) setExhausted(true);
    } catch {
      /* quiet — scroll can retry */
    } finally {
      setLoadingMore(false);
      busyMore.current = false;
    }
  }, [cols, dates, exhausted, loading, fetchWindow]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 140) void loadMore();
  }

  function setCell(tid: number, date: string, v: Cell) {
    setCells((prev) => ({ ...prev, [tid]: { ...prev[tid], [date]: v } }));
  }

  function toggleBool(tid: number, date: string) {
    const cur = cells[tid]?.[date] === true;
    setCell(tid, date, !cur);
    void logTrackable(tid, { value_boolean: !cur, replace: true, date }).catch(() => void load());
  }

  function openNum(tid: number, date: string) {
    const v = cells[tid]?.[date];
    setNoteEdit(null);
    setEdit({ tid, date });
    setDraft(typeof v === "number" ? String(v) : "");
    requestAnimationFrame(() => editRef.current?.focus());
  }

  function commitNum() {
    if (!edit) return;
    const { tid, date } = edit;
    const raw = draft.trim();
    setEdit(null);
    // Empty field = clear the cell: a valueless replace deletes the day's rows
    // server-side and the cell falls back to "–". (The old code did
    // parseFloat("") = NaN → return, so clearing silently no-op'd and a stuck
    // value like 2100 could never be removed.)
    if (raw === "") {
      setCell(tid, date, null);
      void logTrackable(tid, { replace: true, date }).catch(() => void load());
      return;
    }
    const n = parseFloat(raw);
    if (Number.isNaN(n)) return; // non-empty garbage → cancel, keep old value
    setCell(tid, date, n);
    void logTrackable(tid, { value_numeric: n, replace: true, date }).catch(() => void load());
  }

  function openNote(date: string) {
    setEdit(null);
    setNoteEdit(date);
    setNoteDraft(notes[date]?.text ?? "");
    requestAnimationFrame(() => noteRef.current?.focus());
  }

  function commitNote() {
    if (noteEdit == null) return;
    const date = noteEdit;
    const text = noteDraft.trim();
    setNoteEdit(null);
    // optimistic
    setNotes((prev) => {
      const next = { ...prev };
      if (text === "") delete next[date];
      else next[date] = { id: prev[date]?.id ?? -1, text };
      return next;
    });
    void upsertDailyNote(date, text)
      .then((r) => {
        if (r && "id" in r) {
          const n = r as ApiNote;
          setNotes((prev) => ({ ...prev, [date]: { id: n.id, text: stripHtml(n.content) || text } }));
        }
      })
      .catch(() => void load());
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      style={{ width: "100%", height: "100%", overflow: "auto", padding: "22px 24px", boxSizing: "border-box" }}
    >
      {loading ? (
        <div style={{ color: "rgba(244,245,244,0.35)", fontSize: 13, padding: 20 }}>loading…</div>
      ) : (
        <table style={{ borderCollapse: "separate", borderSpacing: 0, color: "#F4F5F4", margin: 0 }}>
          <thead>
            <tr>
              <th style={{ ...thBase, textAlign: "left", position: "sticky", left: 0, background: "rgba(11,15,13,0.9)" }} />
              {cols.map((t) => (
                <th key={t.id} style={thBase} title={t.name}>{t.name}</th>
              ))}
              <th style={{ ...thBase, textAlign: "left" }}>note</th>
            </tr>
          </thead>
          <tbody>
            {dates.map((date, ri) => (
              <tr key={date}>
                <td style={{
                  ...tdBase, textAlign: "left", position: "sticky", left: 0, whiteSpace: "nowrap",
                  background: "rgba(11,15,13,0.9)", color: ri === 0 ? GREEN : "rgba(244,245,244,0.5)", fontWeight: ri === 0 ? 600 : 400,
                }}>
                  {ri === 0 ? "today" : date.slice(5).replace("-", "/")}
                </td>
                {cols.map((t) => {
                  const v = cells[t.id]?.[date] ?? null;
                  const editing = edit?.tid === t.id && edit?.date === date;
                  return (
                    <td key={t.id} style={tdBase}>
                      {t.kind === "boolean" ? (
                        <button
                          onClick={() => toggleBool(t.id, date)}
                          aria-label={`${t.name} ${date}`}
                          style={{
                            width: 16, height: 16, borderRadius: 999, cursor: "pointer", padding: 0, boxSizing: "border-box",
                            background: v === true ? GREEN : "transparent",
                            border: v === true ? "none" : "1.5px solid rgba(244,245,244,0.35)",
                            boxShadow: v === true ? "0 0 8px 1px rgba(74,222,128,0.5)" : "none",
                          }}
                        />
                      ) : editing ? (
                        <input
                          ref={editRef}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") commitNum(); if (e.key === "Escape") setEdit(null); }}
                          onBlur={commitNum}
                          inputMode="decimal"
                          style={{
                            width: 48, fontSize: 12.5, fontWeight: 600, padding: "3px 6px", borderRadius: 7, textAlign: "center",
                            border: `1px solid ${GREEN}`, background: "rgba(11,15,13,0.8)", color: "#F4F5F4", outline: "none", fontFamily: FONT,
                          }}
                        />
                      ) : (
                        <button
                          onClick={() => openNum(t.id, date)}
                          style={{
                            minWidth: 40, padding: "3px 8px", borderRadius: 7, cursor: "pointer",
                            border: "1px solid transparent", background: "transparent",
                            color: v == null ? "rgba(244,245,244,0.25)" : "#F4F5F4", fontSize: 12.5, fontWeight: 600, fontFamily: FONT,
                          }}
                        >
                          {typeof v === "number" ? v : "–"}
                        </button>
                      )}
                    </td>
                  );
                })}
                {/* daily-log note cell — freeform "what happened", backed by a Note */}
                <td style={{ ...tdBase, textAlign: "left" }}>
                  {noteEdit === date ? (
                    <textarea
                      ref={noteRef}
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitNote(); }
                        if (e.key === "Escape") setNoteEdit(null);
                      }}
                      onBlur={commitNote}
                      rows={1}
                      placeholder="…"
                      style={{
                        width: 240, minHeight: 26, fontSize: 12.5, padding: "4px 8px", borderRadius: 7, resize: "vertical",
                        border: `1px solid ${GREEN}`, background: "rgba(11,15,13,0.8)", color: "#F4F5F4", outline: "none", fontFamily: FONT, lineHeight: 1.4,
                      }}
                    />
                  ) : (
                    <button
                      onClick={() => openNote(date)}
                      title={notes[date]?.text || "add a note"}
                      style={{
                        maxWidth: 260, textAlign: "left", padding: "3px 8px", borderRadius: 7, cursor: "text",
                        border: "1px solid transparent", background: "transparent", fontFamily: FONT, fontSize: 12.5,
                        color: notes[date]?.text ? "rgba(244,245,244,0.85)" : "rgba(244,245,244,0.25)",
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block",
                      }}
                    >
                      {notes[date]?.text || "–"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!loading && (loadingMore || exhausted) && (
        <div style={{ textAlign: "center", padding: "12px 0 4px", fontSize: 11, color: "rgba(244,245,244,0.3)" }}>
          {loadingMore ? "loading…" : "beginning of log"}
        </div>
      )}
    </div>
  );
}

const thBase: React.CSSProperties = {
  padding: "8px 10px", fontSize: 10.5, fontWeight: 500, letterSpacing: 0.4,
  textTransform: "lowercase", color: "rgba(244,245,244,0.5)", textAlign: "center",
  borderBottom: "1px solid rgba(244,245,244,0.1)", whiteSpace: "nowrap",
};
const tdBase: React.CSSProperties = {
  padding: "5px 10px", textAlign: "center", fontSize: 12.5,
  borderBottom: "1px solid rgba(244,245,244,0.05)",
};
