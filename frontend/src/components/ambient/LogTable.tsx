import { useCallback, useEffect, useRef, useState } from "react";
import { FONT } from "../../ui";
import { GREEN } from "./wavePath";
import {
  fetchTrackableDays,
  fetchTrackables,
  logTrackable,
  type Trackable,
} from "../../services/api";

// The log's expanded view: the whole trackable matrix (dates × trackables),
// every cell editable — including historical days. For when you want to fix up
// many things at once, not just today. Booleans toggle; numbers type. Writes go
// straight to the (trackable, date) cell via logTrackable replace=true.
//
// This is an INLINE body — LogDots hosts it inside the shared morphing card, so
// no backdrop/close of its own (the parent owns chrome + open/close).

const DAYS = 14;

function isDaily(t: Trackable): boolean {
  if (t.kind === "json") return false;
  if (t.source === "whoop" || t.source === "leetcode") return false;
  if (t.name === "note") return false;
  return true;
}

type Cell = boolean | number | null;

export function LogTable() {
  const [cols, setCols] = useState<Trackable[]>([]);
  const [dates, setDates] = useState<string[]>([]);
  const [cells, setCells] = useState<Record<number, Record<string, Cell>>>({});
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<{ tid: number; date: string } | null>(null);
  const [draft, setDraft] = useState("");
  const editRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const all = (await fetchTrackables()).filter(isDaily);
      all.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "boolean" ? -1 : 1;
        if (a.is_important !== b.is_important) return a.is_important ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const withDays = await Promise.all(
        all.map(async (t) => ({ t, days: (await fetchTrackableDays(t.id, DAYS)).days })),
      );
      let spine: string[] = [];
      const grid: Record<number, Record<string, Cell>> = {};
      for (const { t, days } of withDays) {
        if (days.length > spine.length) spine = days.map((d) => d.date);
        grid[t.id] = {};
        for (const d of days) grid[t.id][d.date] = (typeof d.value === "boolean" || typeof d.value === "number") ? d.value : null;
      }
      setCols(all);
      setDates(spine);
      setCells(grid);
    } catch {
      /* quiet */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

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
    setEdit({ tid, date });
    setDraft(typeof v === "number" ? String(v) : "");
    requestAnimationFrame(() => editRef.current?.focus());
  }

  function commitNum() {
    if (!edit) return;
    const { tid, date } = edit;
    const n = parseFloat(draft);
    setEdit(null);
    if (Number.isNaN(n)) return;
    setCell(tid, date, n);
    void logTrackable(tid, { value_numeric: n, replace: true, date }).catch(() => void load());
  }

  return (
    <div style={{ width: "100%", height: "100%", overflow: "auto", padding: "22px 24px", boxSizing: "border-box" }}>
      {loading ? (
        <div style={{ color: "rgba(244,245,244,0.35)", fontSize: 13, padding: 20 }}>loading…</div>
      ) : (
        <table style={{ borderCollapse: "separate", borderSpacing: 0, color: "#F4F5F4", margin: "0 auto" }}>
          <thead>
            <tr>
              <th style={{ ...thBase, textAlign: "left", position: "sticky", left: 0, background: "rgba(11,15,13,0.9)" }} />
              {cols.map((t) => (
                <th key={t.id} style={thBase} title={t.name}>{t.name}</th>
              ))}
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
              </tr>
            ))}
          </tbody>
        </table>
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
