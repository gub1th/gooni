import { useState } from "react";
import { FONT } from "../../ui";
import { FOCUS_PALETTES } from "./focusPalette";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { type SessionEvidence } from "../../services/api";
import { parseServerDate } from "../../utils/date";
import { kindLabel } from "./focusDetectionKinds";

// The right-rail evidence strip. Deliberately NOT a filmstrip of every frame
// the sidecar ever saw — evidence frames are only the ones the sidecar chose to
// KEEP because a detection fired (phone, vape, distracted…), so every thumbnail
// here already means something. A quiet session shows nothing, which is itself
// the honest answer (the treatment rule the ambient home follows for the same
// reason: an always-something slot stops being read).
//
// It no longer fetches. Frames arrive already scoped to THIS session, from the
// one `/focus/session-activity` poll `FocusExpanded` runs — before that it read
// `/focus/cam/evidence` (the last few DAYS) and filtered client-side, which is
// the same three-scopes problem the footer had.

function timeLabel(iso: string | null): string {
  const d = iso ? parseServerDate(iso) : null;
  if (!d) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

interface Props {
  /** THIS session's evidence frames, newest first — already window-scoped by
   *  the backend, so there is nothing left to filter here. */
  items: SessionEvidence[];
}

export function FocusEvidenceGallery({ items }: Props) {
  const theme = useGooniThemeStore((s) => s.theme);
  const pal = FOCUS_PALETTES[theme];
  const [enlarged, setEnlarged] = useState<SessionEvidence | null>(null);

  if (items.length === 0) return null;

  return (
    <div
      style={{
        position: "absolute", top: 24, bottom: 24, right: 24, width: 116,
        display: "flex", flexDirection: "column", gap: 10, overflowY: "auto",
        fontFamily: FONT,
      }}
    >
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", color: pal.ink3 }}>
        EVIDENCE
      </div>
      {items.map((it) => (
        <button
          key={it.id}
          onClick={() => setEnlarged(it)}
          style={{
            all: "unset", cursor: "pointer", position: "relative",
            borderRadius: 10, overflow: "hidden", border: `1px solid ${pal.rule}`,
            transition: "transform 150ms ease, box-shadow 150ms ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = "scale(1.06)";
            e.currentTarget.style.boxShadow = pal.liftSm;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "scale(1)";
            e.currentTarget.style.boxShadow = "none";
          }}
        >
          {it.frame ? (
            <img
              src={it.frame}
              alt={kindLabel(it.kind) || "evidence"}
              style={{ display: "block", width: "100%", aspectRatio: "4 / 3", objectFit: "cover" }}
            />
          ) : (
            <div style={{ width: "100%", aspectRatio: "4 / 3", background: pal.card }} />
          )}
          <div
            style={{
              position: "absolute", left: 0, right: 0, bottom: 0,
              padding: "4px 6px", fontSize: 9.5, color: "#fff",
              background: "linear-gradient(transparent, rgba(0,0,0,.6))",
              display: "flex", justifyContent: "space-between", gap: 4,
            }}
          >
            <span>{kindLabel(it.kind)}</span>
            <span>{timeLabel(it.at)}</span>
          </div>
        </button>
      ))}

      {enlarged && (
        <div
          role="dialog"
          aria-label="evidence frame"
          onClick={() => setEnlarged(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,.72)", display: "grid", placeItems: "center",
            cursor: "zoom-out",
          }}
        >
          {enlarged.frame && (
            <img
              src={enlarged.frame}
              alt={kindLabel(enlarged.kind) || "evidence"}
              style={{ maxWidth: "82vw", maxHeight: "82vh", borderRadius: 12 }}
            />
          )}
          <div style={{ position: "absolute", bottom: "9vh", color: "#fff", fontSize: 13, fontFamily: FONT }}>
            {kindLabel(enlarged.kind)} · {timeLabel(enlarged.at)}
          </div>
        </div>
      )}
    </div>
  );
}
