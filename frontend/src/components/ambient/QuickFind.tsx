import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Activity, Bell, Brain, CircleCheck, FileText, Search } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FONT, frost, frostInk, z } from "../../ui";
import {
  fetchFocusDashboard,
  fetchMemories,
  fetchPromises,
  fetchTrackables,
  searchNoteTitles,
  searchNotes,
  type ApiMemory,
  type ApiNote,
  type ApiPromise,
  type FocusReminder,
  type Trackable,
} from "../../services/api";

// QuickFind — the ONE search surface on the ambient home. It replaced the
// dropdown that used to hang off the capture box: recall and capture were
// fighting over the same textarea (every captured thought ran a search), so
// search moved out to its own bar at the top and the box went back to being
// purely a place to say something.
//
// It searches MORE than notes. Each hit carries its kind — icon + pill, in the
// kind's colour — so a mixed list stays readable at a glance.
//
// Sources, and why each is fetched the way it is:
//   note       → server search: cheap title-substring per keystroke, semantic
//                (embeddings) on a pause. Same two routes the old dropdown used.
//   promise /  → BOTH commitment stores: the focus dashboard's rows
//   reminder     (`type: reminder|promise`) and the v2 `Promise` table that
//                chat-glow promotion writes. Each is one small payload pulled
//                ONCE into a cache and filtered locally — neither has a
//                server-side search route, and a hit in either is still a hit.
//   trackable  → same deal: one small list, filtered locally.
//   memory     → server-side `q` filter, debounced with the semantic pass.

const KIND_COLOR = {
  // Kind identity, NOT the app accent. The token file's "green is the only
  // accent" rule is about emphasis; these five are labels — a note has to read
  // as a note next to a promise, and hue is the only glanceable channel left.
  note: "#3B82F6",
  promise: "#4ADE80",
  reminder: "#A78BFA",
  memory: "#E879F9",
  trackable: "#E0A83E",
} as const;

type Kind = keyof typeof KIND_COLOR;

const KIND_ICON: Record<Kind, LucideIcon> = {
  note: FileText,
  promise: CircleCheck,
  reminder: Bell,
  memory: Brain,
  trackable: Activity,
};

interface Hit {
  key: string; // `${kind}:${id}` — dedupe across the instant + debounced passes
  kind: Kind;
  title: string;
  sub?: string | null;
  // Fixed source ordering (see GROUP): local exact matches beat semantic ones.
  group: number;
  open: () => void;
}

const GROUP = { title: 0, said: 1, trackable: 2, memory: 3, semantic: 4 } as const;

const MAX_HITS = 8;
const DEBOUNCE_MS = 240;
const CACHE_TTL_MS = 45_000;
const BAR_W = "min(434px, 88vw)"; // ~30% down from the first pass — it was shouting

function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function matches(hay: string | null | undefined, q: string): boolean {
  return clean(hay).toLowerCase().includes(q);
}

// One-line meta for a reminder row: who it's owed to + when it's due.
function reminderSub(r: FocusReminder): string {
  const bits: string[] = [];
  if (r.owed_to) bits.push(`owed to ${r.owed_to}`);
  if (r.due_at && !r.due_is_default) {
    const d = new Date(r.due_at);
    if (!Number.isNaN(d.getTime())) {
      bits.push(d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    }
  }
  if (r.state !== "active") bits.push(r.state);
  return bits.join(" · ");
}

export function QuickFind({
  hidden,
  onOpenNote,
  onOpenTrackables,
}: {
  hidden?: boolean;
  onOpenNote: (note: ApiNote) => void;
  /** trackable hit → open the log matrix, which is home-local state */
  onOpenTrackables: () => void;
}) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [titleNotes, setTitleNotes] = useState<ApiNote[]>([]);
  const [semanticNotes, setSemanticNotes] = useState<ApiNote[]>([]);
  const [memories, setMemories] = useState<ApiMemory[]>([]);

  // locally-filtered caches
  const [reminders, setReminders] = useState<FocusReminder[]>([]);
  const [promises, setPromises] = useState<ApiPromise[]>([]);
  const [trackables, setTrackables] = useState<Trackable[]>([]);
  const cachedAt = useRef(0);

  const debounceRef = useRef<number | null>(null);
  const blurRef = useRef<number | null>(null);
  const seq = useRef(0); // drop responses from stale keystrokes

  const loadCaches = useCallback(async () => {
    if (Date.now() - cachedAt.current < CACHE_TTL_MS) return;
    cachedAt.current = Date.now();
    const [dash, tr, pr] = await Promise.allSettled([
      fetchFocusDashboard(),
      fetchTrackables(),
      fetchPromises({ state: "active", limit: 200 }),
    ]);
    if (dash.status === "fulfilled") {
      const d = dash.value;
      const rows = [
        ...Object.values(d.short_term ?? {}).flat(),
        ...(d.long_term ?? []),
      ];
      const byId = new Map<number, FocusReminder>();
      for (const r of rows) byId.set(r.id, r);
      setReminders([...byId.values()]);
    }
    if (tr.status === "fulfilled") setTrackables(tr.value);
    if (pr.status === "fulfilled") setPromises(pr.value);
  }, []);

  useEffect(() => {
    void loadCaches();
  }, [loadCaches]);

  // ⌘K / ctrl+K anywhere on the home → jump into the bar.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Two-speed search: title-substring fires per keystroke (no embedding call),
  // semantic + memory ride a short pause so typing doesn't spray requests.
  useEffect(() => {
    const query = q.trim();
    const s = ++seq.current;
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (!query) {
      setTitleNotes([]);
      setSemanticNotes([]);
      setMemories([]);
      return;
    }
    void searchNoteTitles(query, 6)
      .then((r) => { if (s === seq.current) setTitleNotes(r); })
      .catch(() => {});
    debounceRef.current = window.setTimeout(() => {
      void searchNotes(query, 6)
        .then((r) => { if (s === seq.current) setSemanticNotes(r); })
        .catch(() => {});
      void fetchMemories({ q: query, limit: 5 })
        .then((r) => { if (s === seq.current) setMemories(r.memories); })
        .catch(() => {});
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [q]);

  // Commitments live on the dashboard at "/" — the index route's search params
  // are all optional but typed-required, hence the explicit undefineds.
  const goDash = useCallback(() => {
    void navigate({
      to: "/",
      search: { note: undefined, conv: undefined, audit: undefined, segment: undefined, view: undefined },
    });
  }, [navigate]);

  const hits = useMemo<Hit[]>(() => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const out: Hit[] = [];

    const pushNote = (n: ApiNote, group: number) => {
      out.push({
        key: `note:${n.id}`,
        kind: "note",
        title: clean(n.title) || "untitled",
        sub: clean(n.excerpt) || null,
        group,
        open: () => onOpenNote(n),
      });
    };

    for (const n of titleNotes) pushNote(n, GROUP.title);

    for (const r of reminders) {
      if (!matches(r.content, query)) continue;
      out.push({
        key: `reminder:${r.id}`,
        kind: r.type === "promise" ? "promise" : "reminder",
        title: clean(r.content),
        sub: reminderSub(r) || null,
        group: GROUP.said,
        open: goDash,
      });
    }

    for (const p of promises) {
      const text = clean(p.summary) || clean(p.utterance);
      if (!matches(text, query)) continue;
      out.push({
        key: `promise:${p.id}`,
        kind: "promise",
        title: text,
        sub: p.cadence === "once" ? null : p.cadence.replace(/_/g, " "),
        group: GROUP.said,
        open: goDash,
      });
    }

    for (const t of trackables) {
      if (!matches(t.name, query)) continue;
      out.push({
        key: `trackable:${t.id}`,
        kind: "trackable",
        title: t.name,
        sub: [t.kind, t.unit].filter(Boolean).join(" · ") || null,
        group: GROUP.trackable,
        open: onOpenTrackables,
      });
    }

    for (const m of memories) {
      out.push({
        key: `memory:${m.id}`,
        kind: "memory",
        title: clean(m.content),
        sub: m.type ?? null,
        group: GROUP.memory,
        open: () => void navigate({ to: "/memories", search: { focus: undefined } }),
      });
    }

    for (const n of semanticNotes) pushNote(n, GROUP.semantic);

    const seen = new Set<string>();
    return out
      .filter((h) => (seen.has(h.key) ? false : (seen.add(h.key), true)))
      .sort((a, b) => a.group - b.group)
      .slice(0, MAX_HITS);
  }, [q, titleNotes, semanticNotes, memories, reminders, promises, trackables, navigate, goDash, onOpenNote, onOpenTrackables]);

  useEffect(() => { setActiveIdx(0); }, [q]);

  function close() {
    setOpen(false);
    setActiveIdx(0);
  }

  function commit(hit: Hit | undefined) {
    if (!hit) return;
    hit.open();
    setQ("");
    close();
    inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && hits.length) {
      e.preventDefault();
      setActiveIdx((i) => Math.min(hits.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp" && hits.length) {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      commit(hits[activeIdx]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (q) { setQ(""); return; }
      close();
      inputRef.current?.blur();
    }
  }

  const showPanel = open && q.trim().length > 0;

  return (
    <div
      data-quickfind
      style={{
        position: "fixed", top: 14, left: "50%", transform: "translateX(-50%)",
        width: BAR_W, zIndex: z.overlay - 10, fontFamily: FONT,
        opacity: hidden ? 0 : 1,
        pointerEvents: hidden ? "none" : "auto",
        transition: "opacity 220ms ease",
      }}
    >
      {/* the bar — a glyph and a caret, nothing else. No placeholder copy, no
          ⌘K hint, no shadow: at rest this should read as a seam in the void,
          not a control asking to be used. */}
      <div
        onClick={() => inputRef.current?.focus()}
        style={{
          display: "flex", alignItems: "center", gap: 7,
          height: 34, padding: "0 13px", borderRadius: 999, cursor: "text",
          ...frost.chrome,
          border: `1px solid ${frostInk.border}`,
        }}
      >
        <Search size={12} color={frostInk.faint} strokeWidth={1.8} />
        <input
          ref={inputRef}
          value={q}
          aria-label="quickfind"
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => { setOpen(true); void loadCaches(); }}
          onBlur={() => {
            // let a row's click land first (rows also preventDefault on mousedown)
            if (blurRef.current) window.clearTimeout(blurRef.current);
            blurRef.current = window.setTimeout(close, 140);
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none",
            fontFamily: FONT, fontSize: 12.5, color: frostInk.text, caretColor: "#4ADE80",
          }}
        />
      </div>

      {/* results */}
      {showPanel && (
        <div
          style={{
            marginTop: 6, padding: 6, borderRadius: 20,
            display: "flex", flexDirection: "column", gap: 2,
            ...frost.panel,
            border: `1px solid ${frostInk.border}`,
          }}
        >
          {hits.length === 0 && (
            <div style={{ padding: "9px 11px", fontSize: 11.5, color: frostInk.faint }}>
              nothing found
            </div>
          )}
          {hits.map((h, i) => {
            const c = KIND_COLOR[h.kind];
            const Icon = KIND_ICON[h.kind];
            return (
              <button
                key={h.key}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => commit(h)}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%",
                  padding: "6px 8px", borderRadius: 14, border: "none", cursor: "pointer",
                  textAlign: "left", fontFamily: FONT,
                  background: i === activeIdx ? frostInk.hover : "transparent",
                }}
              >
                <span
                  style={{
                    flexShrink: 0, width: 24, height: 24, borderRadius: 10,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: `color-mix(in srgb, ${c} 15%, transparent)`,
                  }}
                >
                  <Icon size={12} color={c} strokeWidth={1.9} />
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
                  <span style={{
                    fontSize: 12, fontWeight: 500, color: frostInk.text,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {h.title}
                  </span>
                  {h.sub && (
                    <span style={{
                      fontSize: 10.5, color: frostInk.faint,
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}>
                      {h.sub}
                    </span>
                  )}
                </span>
                <span
                  style={{
                    flexShrink: 0, padding: "1px 7px", borderRadius: 999, fontSize: 9.5,
                    letterSpacing: 0.3, color: c,
                    background: `color-mix(in srgb, ${c} 12%, transparent)`,
                  }}
                >
                  {h.kind}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
