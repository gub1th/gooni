import { useCallback, useEffect, useRef, useState } from "react";
import { Anchor, Pin, X } from "lucide-react";
import { FONT, frostInk, z } from "../ui";
import {
  fetchOverlay,
  searchNoteTitles,
  setOverlayAnchorNote,
  type OverlayData,
  type OverlayHorizonEntry,
  type OverlayTrackableEntry,
} from "../services/api";

// Ambient overlay (Slice 4) — zero visual footprint by default. A subtle
// top-right toggle; hover/focus summons translucent frosted panels that
// fade in from the screen edges (visionOS/Clueless aesthetic), showing
// what matters right now. Cursor leaves → 200ms fade out. Four zones,
// each hidden when empty:
//   left  — action horizon (deterministic promise cascade) + anchor note
//   right — trackables today + whoop-select
// All ranking is server-side + deterministic (see overlay_service.py);
// every entry carries a `reason` so nothing on this surface is magic.

const FADE_MS = 200;
const REFRESH_MS = 60_000;

const STATUS_COLOR: Record<OverlayTrackableEntry["status"], string> = {
  met: "#15803D",
  missed: "#B91C1C",
  logged: "#0A84FF",
  pending: "#8E8E93",
};

const REASON_LABEL: Record<OverlayHorizonEntry["reason"], string> = {
  overdue: "overdue",
  due_soon: "due soon",
  important: "important",
};

export function AmbientOverlay() {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false); // drives the fade
  const [data, setData] = useState<OverlayData | null>(null);
  const closeTimer = useRef<number | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await fetchOverlay());
    } catch {
      /* ambient surface — never throw at the user */
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = window.setInterval(() => void reload(), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [reload]);

  function summon() {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
    // Two-frame mount → fade-in so the transition actually runs.
    requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    void reload();
  }

  function retreat() {
    setVisible(false);
    closeTimer.current = window.setTimeout(() => setOpen(false), FADE_MS);
  }

  const horizon = data?.action_horizon ?? [];
  const trackables = data?.trackables_today ?? [];
  const anchor = data?.anchor ?? null;
  const whoop = data?.whoop_select ?? [];
  const leftEmpty = horizon.length === 0 && !anchor;
  const rightEmpty = trackables.length === 0 && whoop.length === 0;

  return (
    <div style={{ fontFamily: FONT }}>
      {/* Corner toggle — visible but non-intrusive. Hover or keyboard
          focus summons the overlay. */}
      <button
        aria-label="Ambient overlay"
        title="What matters right now"
        onMouseEnter={summon}
        onFocus={summon}
        onClick={() => (open ? retreat() : summon())}
        style={{
          // Clears the shell's corner cluster, which floats above every surface
          // — it used to sit directly on top of the light/dark toggle.
          position: "fixed",
          top: "calc(var(--gooni-bar-h, 0px) + 22px)",
          right: "calc(16px + var(--gooni-corner-w, 180px))",
          zIndex: z.overlay + 1,
          width: 26, height: 26, borderRadius: 999, padding: 0,
          border: `1px solid ${frostInk.hairline}`,
          background: frostInk.card,
          color: frostInk.muted,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", opacity: 0.65,
        }}
      >
        <Anchor size={13} strokeWidth={1.8} />
      </button>

      {open && (
        <div
          onMouseLeave={retreat}
          style={{
            position: "fixed", inset: 0, zIndex: z.overlay,
            pointerEvents: "auto",
            opacity: visible ? 1 : 0,
            transition: `opacity ${FADE_MS}ms ease`,
          }}
        >
          {/* click-anywhere-empty closes */}
          <div onClick={retreat} style={{ position: "absolute", inset: 0 }} />

          {!leftEmpty && (
            <FrostPanel side="left" visible={visible}>
              {horizon.length > 0 && (
                <Zone label="action horizon">
                  {horizon.map((p) => (
                    <div key={p.id} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--gooni-text, #1C1C1E)" }}>
                        {p.summary || p.utterance}
                      </div>
                      <div style={{ fontSize: 11, color: reasonColor(p.reason) }}>
                        {REASON_LABEL[p.reason]}
                        {p.inferred_due ? ` · ${dueLabel(p.inferred_due)}` : ""}
                      </div>
                    </div>
                  ))}
                </Zone>
              )}
              <AnchorZone anchor={anchor} onChanged={() => void reload()} />
            </FrostPanel>
          )}

          {!rightEmpty && (
            <FrostPanel side="right" visible={visible}>
              {trackables.length > 0 && (
                <Zone label="trackables today">
                  {trackables.map((t) => (
                    <div
                      key={t.id}
                      title={t.reason}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        marginBottom: 6, fontSize: 13,
                      }}
                    >
                      <span style={{
                        width: 7, height: 7, borderRadius: 999,
                        background: STATUS_COLOR[t.status], flexShrink: 0,
                      }} />
                      <span style={{ color: "var(--gooni-text, #1C1C1E)", flex: 1 }}>
                        {t.name}
                      </span>
                      <span style={{ color: "var(--gooni-muted, #8E8E93)", fontSize: 12 }}>
                        {formatValue(t)}
                      </span>
                    </div>
                  ))}
                </Zone>
              )}
              {whoop.length > 0 && (
                <Zone label="whoop">
                  {whoop.map((w) => (
                    <div key={w.id} style={{
                      display: "flex", justifyContent: "space-between",
                      marginBottom: 6, fontSize: 13,
                    }}>
                      <span style={{ color: "var(--gooni-text, #1C1C1E)" }}>{w.name}</span>
                      <span style={{ color: "var(--gooni-muted, #8E8E93)" }}>
                        {w.value == null ? "—" : String(w.value)}{w.unit ? ` ${w.unit}` : ""}
                      </span>
                    </div>
                  ))}
                </Zone>
              )}
            </FrostPanel>
          )}
        </div>
      )}
    </div>
  );
}

function reasonColor(reason: OverlayHorizonEntry["reason"]): string {
  if (reason === "overdue") return "#B91C1C";
  if (reason === "due_soon") return "#D97706";
  return "#0A84FF";
}

function dueLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const hrs = (d.getTime() - Date.now()) / 36e5;
  if (hrs < 0) return `${Math.round(-hrs)}h late`;
  if (hrs < 24) return `in ${Math.round(hrs)}h`;
  return `in ${Math.round(hrs / 24)}d`;
}

function formatValue(t: OverlayTrackableEntry): string {
  if (t.value == null) return "—";
  if (typeof t.value === "boolean") return t.value ? "✓" : "—";
  if (typeof t.value === "number") {
    const v = `${Math.round(t.value * 10) / 10}`;
    const target = t.target != null ? ` / ${t.target}` : "";
    return `${v}${target}${t.unit ? ` ${t.unit}` : ""}`;
  }
  return "logged";
}

function FrostPanel({
  side,
  visible,
  children,
}: {
  side: "left" | "right";
  visible: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: "absolute", top: 0, bottom: 0, [side]: 0,
        width: 280, maxWidth: "42vw",
        padding: "56px 20px 24px",
        overflowY: "auto",
        background: "color-mix(in srgb, var(--gooni-card, #FFFFFF) 62%, transparent)",
        backdropFilter: `blur(var(--gooni-overlay-blur, 18px))`,
        WebkitBackdropFilter: `blur(var(--gooni-overlay-blur, 18px))`,
        borderRight: side === "left" ? "1px solid var(--gooni-border, rgba(0,0,0,0.06))" : undefined,
        borderLeft: side === "right" ? "1px solid var(--gooni-border, rgba(0,0,0,0.06))" : undefined,
        transform: visible ? "translateX(0)" : `translateX(${side === "left" ? "-14px" : "14px"})`,
        transition: `transform ${FADE_MS}ms ease`,
      }}
    >
      {children}
    </div>
  );
}

function Zone({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: 1.4,
        textTransform: "uppercase", color: "var(--gooni-muted, #8E8E93)",
        marginBottom: 8,
      }}>
        {label}
      </div>
      {children}
    </div>
  );
}

// Anchor zone — the pinned north-star Note + the picker that persists
// the selection on Settings.
function AnchorZone({
  anchor,
  onChanged,
}: {
  anchor: { id: number; title: string | null; excerpt: string | null } | null;
  onChanged: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: number; title: string | null }[]>([]);

  useEffect(() => {
    if (!picking || query.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = window.setTimeout(async () => {
      try {
        setResults(await searchNoteTitles(query, 6));
      } catch {
        setResults([]);
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [picking, query]);

  async function pick(noteId: number | null) {
    await setOverlayAnchorNote(noteId);
    setPicking(false);
    setQuery("");
    onChanged();
  }

  return (
    <Zone label="anchor">
      {anchor ? (
        <div>
          <div style={{
            display: "flex", alignItems: "flex-start", gap: 6,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--gooni-text, #1C1C1E)" }}>
                {anchor.title || "(untitled)"}
              </div>
              {anchor.excerpt && (
                <div style={{
                  fontSize: 12, color: "var(--gooni-muted, #8E8E93)",
                  marginTop: 3, lineHeight: 1.5,
                  display: "-webkit-box", WebkitLineClamp: 4,
                  WebkitBoxOrient: "vertical", overflow: "hidden",
                }}>
                  {anchor.excerpt}
                </div>
              )}
            </div>
            <button
              onClick={() => void pick(null)}
              title="Unpin anchor"
              aria-label="Unpin anchor note"
              style={{
                border: "none", background: "transparent", cursor: "pointer",
                color: "var(--gooni-muted, #8E8E93)", padding: 2,
              }}
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        </div>
      ) : picking ? (
        <div>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search notes…"
            style={{
              width: "100%", fontSize: 12, padding: "5px 8px",
              borderRadius: 6, border: "1px solid var(--gooni-border, rgba(0,0,0,0.12))",
              background: "var(--gooni-input-bg, #FFFFFF)",
              color: "var(--gooni-text, #1C1C1E)", outline: "none",
              fontFamily: FONT,
            }}
          />
          {results.map((r) => (
            <button
              key={r.id}
              onClick={() => void pick(r.id)}
              style={{
                display: "block", width: "100%", textAlign: "left",
                fontSize: 12, padding: "5px 8px", marginTop: 2,
                borderRadius: 6, border: "none", cursor: "pointer",
                background: "transparent", color: "var(--gooni-text, #1C1C1E)",
                fontFamily: FONT,
              }}
            >
              {r.title || "(untitled)"}
            </button>
          ))}
        </div>
      ) : (
        <button
          onClick={() => setPicking(true)}
          style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            fontSize: 12, fontWeight: 600, padding: "4px 10px",
            borderRadius: 8, cursor: "pointer",
            border: "1px dashed var(--gooni-border, rgba(0,0,0,0.18))",
            background: "transparent", color: "var(--gooni-muted, #8E8E93)",
            fontFamily: FONT,
          }}
        >
          <Pin size={11} strokeWidth={2} />
          pin a note
        </button>
      )}
    </Zone>
  );
}
