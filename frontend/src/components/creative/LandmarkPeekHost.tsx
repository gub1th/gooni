import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FONT } from "../../ui";
import { subscribeLandmark, type LandmarkPeekState } from "./landmarkBus";
import type { Landmark } from "./landmarkPlacement";

// The DOM half of the landmark system — a sibling of <Canvas>, driven
// by landmarkBus. Two surfaces:
//
//   peek bar  — slides up when the player stands on a landmark tile.
//               Deliberately thin: title, one line, and the invitation
//               to open. Same grammar as NotePeekCard so the plaza has
//               one interaction vocabulary, not two.
//   full card — the actual portfolio content. Centred, scrollable,
//               dismissable with Esc or a click on the scrim.
//
// Both portal to document.body so they escape the Canvas stacking
// context entirely.

const DISPLAY = "'Iowan Old Style', 'Hoefler Text', Georgia, 'Times New Roman', serif";

export function LandmarkPeekHost() {
  const [state, setState] = useState<LandmarkPeekState | null>(null);
  useEffect(() => subscribeLandmark(setState), []);
  if (!state) return null;
  return (
    <>
      <LandmarkPeek
        landmark={state.expanded ? null : state.active}
        onExpand={state.onExpand}
        onDismiss={state.onDismiss}
      />
      <LandmarkCard landmark={state.expanded} onClose={state.onClose} />
    </>
  );
}

// ── peek bar ────────────────────────────────────────────────────────

function LandmarkPeek({
  landmark,
  onExpand,
  onDismiss,
}: {
  landmark: Landmark | null;
  onExpand: (l: Landmark) => void;
  onDismiss: () => void;
}) {
  const [shown, setShown] = useState<Landmark | null>(landmark);
  const [visible, setVisible] = useState(landmark !== null);

  useEffect(() => {
    if (landmark) {
      setShown(landmark);
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
      const t = setTimeout(() => setShown(null), 320);
      return () => clearTimeout(t);
    }
  }, [landmark]);

  useEffect(() => {
    if (!landmark) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onDismiss();
      if (e.key === "e" || e.key === "E" || e.key === "Enter") {
        if (landmark) onExpand(landmark);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [landmark, onExpand, onDismiss]);

  if (typeof document === "undefined" || !shown) return null;

  return createPortal(
    <div
      role="button"
      tabIndex={0}
      onClick={() => onExpand(shown)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onExpand(shown);
      }}
      style={{
        position: "fixed",
        left: "50%",
        bottom: 26,
        transform: `translateX(-50%) translateY(${visible ? "0" : "140%"})`,
        transition: "transform 300ms cubic-bezier(.22,1,.36,1), opacity 220ms ease",
        opacity: visible ? 1 : 0,
        zIndex: 900,
        width: "min(560px, calc(100vw - 32px))",
        background: "rgba(18,20,25,0.80)",
        backdropFilter: "blur(14px) saturate(160%)",
        WebkitBackdropFilter: "blur(14px) saturate(160%)",
        border: `1px solid ${hexA(shown.color, 0.45)}`,
        borderRadius: 16,
        boxShadow: `0 18px 50px rgba(0,0,0,0.5), 0 0 26px ${hexA(shown.color, 0.14)}`,
        padding: "14px 18px",
        fontFamily: FONT,
        color: "#fff",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 14,
        textAlign: "left",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: shown.color,
          boxShadow: `0 0 12px ${hexA(shown.color, 0.9)}`,
          flexShrink: 0,
        }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontFamily: DISPLAY, fontSize: 20, lineHeight: 1.2 }}>
          {shown.title}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 12.5,
            color: "rgba(255,255,255,0.62)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {shown.subtitle}
        </span>
      </span>
      <span
        style={{
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: shown.color,
          border: `1px solid ${hexA(shown.color, 0.4)}`,
          borderRadius: 999,
          padding: "5px 11px",
          flexShrink: 0,
          fontWeight: 600,
        }}
      >
        open
      </span>
    </div>,
    document.body,
  );
}

// ── full card ───────────────────────────────────────────────────────

function LandmarkCard({ landmark, onClose }: { landmark: Landmark | null; onClose: () => void }) {
  const [shown, setShown] = useState<Landmark | null>(landmark);
  const [visible, setVisible] = useState(landmark !== null);

  useEffect(() => {
    if (landmark) {
      setShown(landmark);
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
      const t = setTimeout(() => setShown(null), 260);
      return () => clearTimeout(t);
    }
  }, [landmark]);

  useEffect(() => {
    if (!landmark) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [landmark, onClose]);

  if (typeof document === "undefined" || !shown) return null;

  const p = shown.project;

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 950,
        background: `rgba(6,8,12,${visible ? 0.62 : 0})`,
        transition: "background 240ms ease",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={shown.title}
        style={{
          width: "min(600px, 100%)",
          maxHeight: "84vh",
          overflowY: "auto",
          background: "rgba(16,19,24,0.94)",
          backdropFilter: "blur(20px) saturate(150%)",
          WebkitBackdropFilter: "blur(20px) saturate(150%)",
          border: `1px solid ${hexA(shown.color, 0.34)}`,
          borderRadius: 20,
          boxShadow: `0 30px 90px rgba(0,0,0,0.6), 0 0 40px ${hexA(shown.color, 0.10)}`,
          padding: "28px 30px 26px",
          fontFamily: FONT,
          color: "#F2F0EC",
          transform: visible ? "translateY(0) scale(1)" : "translateY(14px) scale(0.985)",
          opacity: visible ? 1 : 0,
          transition: "transform 260ms cubic-bezier(.22,1,.36,1), opacity 200ms ease",
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute",
            right: 26,
            top: 24,
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.18)",
            color: "rgba(255,255,255,0.62)",
            borderRadius: 999,
            width: 30,
            height: 30,
            cursor: "pointer",
            fontSize: 15,
            lineHeight: 1,
          }}
        >
          ×
        </button>

        {p?.period && (
          <div
            style={{
              fontSize: 10.5,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: shown.color,
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            {p.period}
          </div>
        )}

        <h2 style={{ fontFamily: DISPLAY, fontSize: 34, fontWeight: 500, margin: "0 0 8px", letterSpacing: "-0.02em" }}>
          {shown.title}
        </h2>
        <p style={{ fontSize: 14.5, color: "rgba(242,240,236,0.66)", margin: "0 0 20px", lineHeight: 1.55 }}>
          {shown.subtitle}
        </p>

        {/* Screenshot hero. Sits above the stats so the eye gets the
            product before the numbers — the numbers only mean something
            once you know what the thing looks like. */}
        {p?.image && (
          <img
            src={p.image}
            alt={p.imageAlt ?? ""}
            loading="lazy"
            style={{
              display: "block",
              width: "100%",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.10)",
              marginBottom: 20,
              background: "rgba(255,255,255,0.03)",
            }}
          />
        )}

        {p?.stats && p.stats.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${Math.min(p.stats.length, 4)}, 1fr)`,
              gap: 1,
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 12,
              overflow: "hidden",
              marginBottom: 20,
            }}
          >
            {p.stats.map((s) => (
              <div key={s.label} style={{ background: "rgba(255,255,255,0.03)", padding: "13px 10px", textAlign: "center" }}>
                <div style={{ fontFamily: DISPLAY, fontSize: 22, fontVariantNumeric: "tabular-nums", color: shown.color }}>
                  {s.value}
                </div>
                <div style={{ fontSize: 10.5, color: "rgba(242,240,236,0.5)", marginTop: 3 }}>{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {p?.blurb && (
          <p style={{ fontSize: 15, lineHeight: 1.68, color: "rgba(242,240,236,0.86)", margin: "0 0 20px" }}>
            {p.blurb}
          </p>
        )}

        {/* Archive: the earlier work, as a list rather than five more
            landmarks cluttering the island. */}
        {shown.items && (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 20 }}>
            {shown.items.map((item) => (
              <div
                key={item.id}
                style={{
                  padding: "12px 2px",
                  borderBottom: "1px solid rgba(255,255,255,0.07)",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 14,
                  alignItems: "baseline",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: DISPLAY, fontSize: 17 }}>{item.name}</div>
                  <div style={{ fontSize: 12.5, color: "rgba(242,240,236,0.55)", marginTop: 2 }}>{item.tagline}</div>
                  {item.links && item.links.length > 0 && (
                    <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
                      {item.links.map((l) => (
                        <a
                          key={l.href}
                          href={l.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 11.5, color: shown.color, textDecoration: "none", borderBottom: `1px solid ${hexA(shown.color, 0.35)}` }}
                        >
                          {l.label}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 10.5, color: "rgba(242,240,236,0.38)", whiteSpace: "nowrap" }}>
                  {item.stack.join(" · ")}
                </div>
              </div>
            ))}
          </div>
        )}

        {p?.stack && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 20 }}>
            {p.stack.map((s) => (
              <span
                key={s}
                style={{
                  fontSize: 11.5,
                  padding: "5px 11px",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.14)",
                  color: "rgba(242,240,236,0.74)",
                }}
              >
                {s}
              </span>
            ))}
          </div>
        )}

        {/* Kiosk: the résumé. Opens in a new tab rather than force-
            downloading — most people want to look, not keep. */}
        {shown.href && (
          <a
            href={shown.href}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 9,
              background: shown.color,
              color: "#141210",
              padding: "11px 20px",
              borderRadius: 11,
              textDecoration: "none",
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            Open the résumé →
          </a>
        )}

        {(p?.links || shown.links) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
            {(p?.links ?? shown.links ?? []).map((l) => (
              <a
                key={l.href}
                href={l.href}
                target={l.href.startsWith("http") ? "_blank" : undefined}
                rel="noopener noreferrer"
                style={{
                  fontSize: 13,
                  padding: "9px 15px",
                  borderRadius: 10,
                  border: `1px solid ${hexA(shown.color, 0.4)}`,
                  color: shown.color,
                  textDecoration: "none",
                }}
              >
                {l.label} ↗
              </a>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** #rrggbb → rgba() at the given alpha. Landmark colours come from
 *  content as plain hex, but every use here needs transparency. */
function hexA(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return `rgba(255,255,255,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
