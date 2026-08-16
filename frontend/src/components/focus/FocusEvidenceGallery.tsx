import { useEffect, useState } from "react";
import { FONT } from "../../ui";
import { FOCUS_PALETTES } from "./focusPalette";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { FEED_REFRESH_MS, fetchFocusCamEvidence, type FocusCamEvidence } from "../../services/api";
import { parseServerDate } from "../../utils/date";

// The right-rail evidence strip. Deliberately NOT a filmstrip of every frame
// the sidecar ever saw — /focus/cam/evidence only holds frames the sidecar
// chose to KEEP because a detection fired (phone, vape, distracted…), so
// every thumbnail here already means something. A quiet session shows nothing,
// which is itself the honest answer (the treatment rule the ambient home
// follows for the same reason: an always-something slot stops being read).

const KIND_LABEL: Record<string, string> = {
  phone: "phone",
  vape: "vape",
  distracted: "distracted",
  stand: "stood up",
  left_desk: "left desk",
};

function timeLabel(iso: string | null): string {
  const d = iso ? parseServerDate(iso) : null;
  if (!d) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

interface Props {
  /** Only frames at/after this epoch ms count as THIS session's evidence. */
  sinceMs: number | null;
}

export function FocusEvidenceGallery({ sinceMs }: Props) {
  const theme = useGooniThemeStore((s) => s.theme);
  const pal = FOCUS_PALETTES[theme];
  const [items, setItems] = useState<FocusCamEvidence[]>([]);
  const [enlarged, setEnlarged] = useState<FocusCamEvidence | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const rows = await fetchFocusCamEvidence(20);
        if (!cancelled) setItems(rows);
      } catch {
        // best-effort — a quiet gallery reads the same as a failed fetch,
        // which is fine here (there's nothing actionable to say about it)
      }
    };
    void load();
    const iv = window.setInterval(() => void load(), FEED_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, []);

  const inSession = items.filter((it) => {
    if (sinceMs == null) return true;
    const at = it.at ? parseServerDate(it.at)?.getTime() : null;
    return at != null && at >= sinceMs;
  });

  if (inSession.length === 0) return null;

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
      {inSession.map((it) => (
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
              alt={KIND_LABEL[it.kind ?? ""] ?? "evidence"}
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
            <span>{KIND_LABEL[it.kind ?? ""] ?? it.kind ?? "—"}</span>
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
              alt={KIND_LABEL[enlarged.kind ?? ""] ?? "evidence"}
              style={{ maxWidth: "82vw", maxHeight: "82vh", borderRadius: 12 }}
            />
          )}
          <div style={{ position: "absolute", bottom: "9vh", color: "#fff", fontSize: 13, fontFamily: FONT }}>
            {KIND_LABEL[enlarged.kind ?? ""] ?? enlarged.kind} · {timeLabel(enlarged.at)}
          </div>
        </div>
      )}
    </div>
  );
}
