import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Maximize2, X } from "lucide-react";
import { FONT } from "../../ui";
import {
  fetchCalendarEvents,
  fetchFocusDashboard,
  fetchLeetcodeToday,
  fetchTrackableDays,
  fetchTrackables,
  fetchWhoopToday,
  type CalendarEvent,
  type FocusDashboard as FocusDashboardData,
  type FocusReminder,
  type LeetcodeToday,
  type Trackable,
  type TrackableDay,
  type WhoopToday,
} from "../../services/api";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { useWidgetOverlayStore } from "../../stores/useWidgetOverlayStore";
import { LogTable } from "../ambient/LogTable";
import { FOCUS_PALETTES, type FocusPalette } from "./focusPalette";
import { FocusStream } from "./FocusStream";
import { fmtPromiseMeta, fmtTime, fmtWeekday } from "./notchMerge";

// The focus kiosk / home. The CENTRE is the arcs canvas (FocusStream, the
// chronological said-vs-done timeline). The left rail holds what matters right
// now, FLOWING top-down (no bottom-pin — a rail that ends early beats one
// stretched around a dead gap):
//   promises (said-vs-done state) · reminders · schedule · streaks · feeds
// Times live UNDER each line as metadata, not in a right column that squeezed
// the text into a mid-word ellipsis. Poll to stay live; the display IS the
// proactivity.

const REFRESH_MS = 25_000;
const STREAK_TRAIL = 5; // trailing days shown per streak column
const STREAK_PER_PAGE = 4; // columns visible before the ‹ › pager

interface StreakCol {
  t: Trackable;
  days: TrackableDay[]; // newest-first, gap-filled; days[0] = today
}

// Mirror LogDots.isDaily: the daily-glance set — boolean habits + key numbers,
// minus the json feeds (whoop/leetcode), device telemetry (shortcuts),
// walled-off focus-cam, and the freeform "note".
function isStreak(t: Trackable): boolean {
  if (t.kind === "json") return false;
  if (t.source === "whoop" || t.source === "leetcode") return false;
  if (t.source === "shortcuts" || t.source === "focus_cam") return false;
  if (t.name === "note") return false;
  return true;
}

function todayWindowISO(): { startISO: string; endISO: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

export function FocusDashboard() {
  const theme = useGooniThemeStore((s) => s.theme);
  const pal = FOCUS_PALETTES[theme];
  const openWidget = useWidgetOverlayStore((s) => s.open);

  const [data, setData] = useState<FocusDashboardData | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [streaks, setStreaks] = useState<StreakCol[]>([]);
  const [whoop, setWhoop] = useState<WhoopToday | null>(null);
  const [lc, setLc] = useState<LeetcodeToday | null>(null);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const streakDefsRef = useRef<Trackable[] | null>(null);

  const loadStreaks = useCallback(async () => {
    try {
      if (!streakDefsRef.current) {
        const all = (await fetchTrackables()).filter(isStreak);
        all.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "boolean" ? -1 : 1;
          if (a.is_important !== b.is_important) return a.is_important ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        streakDefsRef.current = all;
      }
      const defs = streakDefsRef.current;
      const cols = await Promise.all(
        defs.map(async (t) => ({ t, days: (await fetchTrackableDays(t.id, 1 + STREAK_TRAIL)).days })),
      );
      setStreaks(cols);
    } catch {
      /* rail stays quiet on error */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      setData(await fetchFocusDashboard());
    } catch {
      /* keep the last good frame */
    }
    try {
      const { startISO, endISO } = todayWindowISO();
      setEvents(await fetchCalendarEvents(startISO, endISO));
    } catch {
      setEvents([]); // 401 / not connected → Gooni items only, never an error
    }
    void fetchWhoopToday().then(setWhoop).catch(() => setWhoop(null));
    void fetchLeetcodeToday().then(setLc).catch(() => setLc(null));
    void loadStreaks();
  }, [loadStreaks]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  // Full-bleed kiosk — own the page ground (theme-aware) while mounted.
  useEffect(() => {
    const prev = {
      bg: document.body.style.background,
      margin: document.body.style.margin,
      overflow: document.body.style.overflow,
    };
    document.body.style.background = pal.paper;
    document.body.style.margin = "0";
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.background = prev.bg;
      document.body.style.margin = prev.margin;
      document.body.style.overflow = prev.overflow;
    };
  }, [pal.paper]);

  const reminders = data?.notch.reminders ?? [];
  const promises = data?.notch.promises ?? [];
  const sortedEvents = useMemo(
    () => [...events].sort((a, b) => (a.start || "").localeCompare(b.start || "")),
    [events],
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: pal.paper,
        color: pal.ink,
        fontFamily: FONT,
        fontSize: 12,
        overflow: "hidden",
        display: "flex",
      }}
    >
      {/* ── left rail (flows top-down; scrolls if tall) ───────────────────── */}
      <aside
        style={{
          width: 258,
          flexShrink: 0,
          borderRight: `1px solid ${pal.rule}`,
          padding: "24px 20px 28px",
          display: "flex",
          flexDirection: "column",
          gap: 22,
          overflowY: "auto",
        }}
      >
        {promises.length > 0 && (
          <RailSection label="promises" pal={pal}>
            {promises.map((p) => (
              <PromiseRow key={`p${p.id}`} p={p} pal={pal} />
            ))}
          </RailSection>
        )}

        {reminders.length > 0 && (
          <RailSection label="reminders" pal={pal}>
            {reminders.map((r: FocusReminder) => (
              <RailRow key={`r${r.id}`} title={r.content} meta={fmtTime(r.due_at)} pal={pal} />
            ))}
          </RailSection>
        )}

        {sortedEvents.length > 0 && (
          <RailSection label="schedule" pal={pal} onExpand={() => openWidget("calendar", "agenda")}>
            {sortedEvents.map((e) => (
              <RailRow
                key={`e${e.id}`}
                title={e.summary || "(untitled)"}
                meta={e.all_day ? fmtWeekday(e.start) : fmtTime(e.start)}
                pal={pal}
              />
            ))}
          </RailSection>
        )}

        <RailSection label="streaks" pal={pal} onExpand={() => setMatrixOpen(true)}>
          <StreakStrip cols={streaks} pal={pal} />
        </RailSection>

        <FeedLine whoop={whoop} lc={lc} pal={pal} />
      </aside>

      {/* ── centre: the arcs canvas ───────────────────────────────────────── */}
      <main style={{ flex: 1, position: "relative", minWidth: 0 }}>
        <FocusStream />
      </main>

      {/* activity matrix — the full editable log, "as the main page does" */}
      {matrixOpen && <MatrixOverlay onClose={() => setMatrixOpen(false)} />}
    </div>
  );
}

// ── rail scaffolding ──────────────────────────────────────────────────────────

function SectionLabel({
  children,
  pal,
  onExpand,
}: {
  children: React.ReactNode;
  pal: FocusPalette;
  onExpand?: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 10,
        color: pal.ink3,
        fontSize: 10.5,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}
    >
      <span>{children}</span>
      {onExpand && (
        <button
          onClick={onExpand}
          aria-label="Expand"
          title="Expand"
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            color: pal.ink3,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = pal.ink)}
          onMouseLeave={(e) => (e.currentTarget.style.color = pal.ink3)}
        >
          <Maximize2 size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

function RailSection({
  label,
  pal,
  onExpand,
  children,
}: {
  label: string;
  pal: FocusPalette;
  onExpand?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <SectionLabel pal={pal} onExpand={onExpand}>
        {label}
      </SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>{children}</div>
    </div>
  );
}

// A rail line: title takes the FULL width and wraps to two lines; the time /
// meta rides UNDERNEATH as small print. No right-hand column, so nothing gets
// clipped mid-word.
function RailRow({
  title,
  meta,
  pal,
  tone = "normal",
  metaWarn = false,
}: {
  title: string;
  meta?: string;
  pal: FocusPalette;
  tone?: "normal" | "warn";
  metaWarn?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span
        style={{
          fontSize: 12.5,
          lineHeight: 1.35,
          color: tone === "warn" ? pal.warn : pal.ink,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {title}
      </span>
      {meta && (
        <span
          style={{
            fontSize: 11,
            color: metaWarn ? pal.warn : pal.ink3,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {meta}
        </span>
      )}
    </div>
  );
}

// A promise renders its said-vs-done STATE in the meta line: active shows who
// it's owed to + age; broken flips the whole row to warn + "lasted Nd" — the
// gap rendering itself instead of being narrated.
function PromiseRow({ p, pal }: { p: FocusReminder; pal: FocusPalette }) {
  if (p.state === "broken") {
    return (
      <RailRow
        title={p.content}
        meta={`broke · lasted ${p.lasted_days}d`}
        pal={pal}
        tone="warn"
        metaWarn
      />
    );
  }
  return <RailRow title={p.content} meta={fmtPromiseMeta(p.owed_to, p.age_days)} pal={pal} />;
}

// ── streak strip (paged) ──────────────────────────────────────────────────────

function StreakStrip({ cols, pal }: { cols: StreakCol[]; pal: FocusPalette }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(cols.length / STREAK_PER_PAGE));
  const clamped = Math.min(page, pages - 1);
  const slice = cols.slice(clamped * STREAK_PER_PAGE, clamped * STREAK_PER_PAGE + STREAK_PER_PAGE);

  if (cols.length === 0) {
    return <div style={{ color: pal.ink3, fontSize: 11 }}>nothing tracked yet</div>;
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-around", alignItems: "flex-end", minHeight: 96 }}>
        {slice.map((c) => (
          <StreakColumn key={c.t.id} col={c} pal={pal} />
        ))}
      </div>
      {pages > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14, marginTop: 10 }}>
          <PagerBtn dir="left" pal={pal} disabled={clamped === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} />
          <span style={{ color: pal.ink3, fontSize: 10, letterSpacing: 1 }}>
            {clamped + 1}/{pages}
          </span>
          <PagerBtn
            dir="right"
            pal={pal}
            disabled={clamped >= pages - 1}
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
          />
        </div>
      )}
    </div>
  );
}

function PagerBtn({
  dir,
  pal,
  disabled,
  onClick,
}: {
  dir: "left" | "right";
  pal: FocusPalette;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === "left" ? "Previous streaks" : "More streaks"}
      style={{
        width: 20,
        height: 20,
        borderRadius: 6,
        border: "none",
        background: "transparent",
        cursor: disabled ? "default" : "pointer",
        color: pal.ink3,
        opacity: disabled ? 0.3 : 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
      }}
    >
      {dir === "left" ? <ChevronLeft size={15} strokeWidth={2} /> : <ChevronRight size={15} strokeWidth={2} />}
    </button>
  );
}

// One trackable as a vertical dot-trail (oldest at top) + today's marker +
// name. Booleans read as filled/empty rings; numbers show today's value.
function StreakColumn({ col, pal }: { col: StreakCol; pal: FocusPalette }) {
  const { t, days } = col;
  const todayVal = days[0]?.value;
  const trail = days.slice(1, 1 + STREAK_TRAIL).slice().reverse(); // oldest → newest
  const n = trail.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 46 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, marginBottom: 6 }}>
        {trail.map((d, i) => {
          const recency = n <= 1 ? 1 : i / (n - 1);
          const size = 4 + recency * 3;
          const did = t.kind === "boolean" ? d.value === true : d.value != null;
          return (
            <span
              key={d.date}
              title={`${d.date}: ${d.value ?? "—"}`}
              style={{
                width: size,
                height: size,
                borderRadius: 999,
                boxSizing: "border-box",
                background: did ? pal.accent : "transparent",
                opacity: did ? 0.25 + recency * 0.55 : 0.5,
                border: did ? "none" : `1px solid ${pal.ink3}`,
              }}
            />
          );
        })}
      </div>

      {/* today marker */}
      {t.kind === "boolean" ? (
        todayVal === true ? (
          <span style={{ color: pal.accent, display: "inline-flex", alignItems: "center" }}>
            <Check size={13} strokeWidth={2.4} />
          </span>
        ) : (
          <span
            style={{
              width: 13,
              height: 13,
              borderRadius: 999,
              boxSizing: "border-box",
              border: `1.5px solid ${pal.ink3}`,
            }}
          />
        )
      ) : (
        <span style={{ fontSize: 12.5, fontWeight: 600, color: typeof todayVal === "number" ? pal.ink : pal.ink3 }}>
          {typeof todayVal === "number" ? Math.round(todayVal) : "–"}
        </span>
      )}

      <span
        style={{
          fontSize: 9.5,
          color: pal.ink3,
          marginTop: 7,
          maxWidth: 46,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          letterSpacing: 0.2,
        }}
        title={t.name}
      >
        {t.name}
      </span>
    </div>
  );
}

// ── passive feeds (subtle) ────────────────────────────────────────────────────

function FeedLine({
  whoop,
  lc,
  pal,
}: {
  whoop: WhoopToday | null;
  lc: LeetcodeToday | null;
  pal: FocusPalette;
}) {
  const whoopBits: string[] = [];
  if (whoop && whoop.date) {
    if (whoop.recovery_score != null) whoopBits.push(`rec ${Math.round(whoop.recovery_score)}`);
    if (whoop.strain != null) whoopBits.push(`strain ${(Math.round(whoop.strain * 10) / 10).toFixed(1)}`);
    if (whoop.sleep_minutes != null) whoopBits.push(`${Math.round((whoop.sleep_minutes / 60) * 10) / 10}h`);
  }
  const lcBits: string[] = [];
  if (lc && lc.available) {
    if (lc.today_count != null) lcBits.push(`${lc.today_count} today`);
    if (lc.streak != null) lcBits.push(`${lc.streak} streak`);
  }
  if (whoopBits.length === 0 && lcBits.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 10.5, color: pal.ink3 }}>
      {whoopBits.length > 0 && (
        <div>
          <FeedTag pal={pal}>whoop</FeedTag> {whoopBits.join(" · ")}
          {whoop?.day_label ? <span style={{ color: pal.warn }}> · {whoop.day_label}</span> : null}
        </div>
      )}
      {lcBits.length > 0 && (
        <div>
          <FeedTag pal={pal}>leetcode</FeedTag> {lcBits.join(" · ")}
        </div>
      )}
    </div>
  );
}

function FeedTag({ children, pal }: { children: React.ReactNode; pal: FocusPalette }) {
  return (
    <span style={{ letterSpacing: "0.1em", textTransform: "uppercase", fontSize: 9, color: pal.ink3, opacity: 0.75 }}>
      {children}
    </span>
  );
}

// ── activity matrix overlay ───────────────────────────────────────────────────

function MatrixOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(3px)",
        WebkitBackdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: FONT,
      }}
    >
      <div
        style={{
          position: "relative",
          width: "min(1120px, 94vw)",
          height: "min(80vh, 640px)",
          borderRadius: 20,
          overflow: "hidden",
          background: "color-mix(in srgb, rgb(var(--gooni-surf, 11 15 13)) 62%, transparent)",
          backdropFilter: "blur(22px)",
          WebkitBackdropFilter: "blur(22px)",
          border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.10)",
          boxShadow: "0 20px 70px rgba(0,0,0,0.55)",
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute",
            top: 12,
            right: 14,
            zIndex: 3,
            width: 26,
            height: 26,
            borderRadius: 8,
            cursor: "pointer",
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid rgb(var(--gooni-ink, 244 245 244) / 0.12)",
            background: "rgb(var(--gooni-surf, 11 15 13) / 0.5)",
            color: "rgb(var(--gooni-ink, 244 245 244) / 0.5)",
          }}
        >
          <X size={14} strokeWidth={1.9} />
        </button>
        <LogTable />
      </div>
    </div>
  );
}
