import { useEffect, useState } from "react";
import { FONT } from "../../ui";
import { FOCUS_PALETTES } from "./focusPalette";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { FEED_REFRESH_MS, fetchFocusCam, fetchFocusCamEvidence, type FocusCamBlob } from "../../services/api";
import { parseServerDate } from "../../utils/date";

// Can't tell if the camera is on, which one, or whether anything's been
// flagged — the captain's exact complaint. This is the answer: a small line
// naming the camera, a live sensing state, and a running violation count.
//
// FRESHNESS = LIVENESS, same rule the preview-frame widget already uses
// (`frame_at` older than ~40s means a dead sidecar, not a live one) — a
// `control: running` blob with a stale frame is exactly the state that would
// otherwise silently claim "on" while nothing is actually being sensed.
const STALE_MS = 40_000;

const VIOLATION_KINDS = new Set(["distracted", "phone", "vape"]);

type DetectionStatus = "on" | "off" | "error";

function statusOf(blob: FocusCamBlob | null): DetectionStatus {
  if (!blob || blob.control !== "running") return "off";
  const frameAt = blob.frame_at ? parseServerDate(blob.frame_at)?.getTime() : null;
  if (frameAt == null || Date.now() - frameAt > STALE_MS) return "error";
  return "on";
}

interface Props {
  sinceMs: number | null;
}

export function FocusCameraStatus({ sinceMs }: Props) {
  const theme = useGooniThemeStore((s) => s.theme);
  const pal = FOCUS_PALETTES[theme];
  const [blob, setBlob] = useState<FocusCamBlob | null>(null);
  const [violations, setViolations] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [b, ev] = await Promise.allSettled([fetchFocusCam(), fetchFocusCamEvidence(40)]);
      if (cancelled) return;
      if (b.status === "fulfilled") setBlob(b.value);
      if (ev.status === "fulfilled") {
        const count = ev.value.filter((it) => {
          if (!it.kind || !VIOLATION_KINDS.has(it.kind)) return false;
          if (sinceMs == null) return true;
          const at = it.at ? parseServerDate(it.at)?.getTime() : null;
          return at != null && at >= sinceMs;
        }).length;
        setViolations(count);
      }
    };
    void load();
    const iv = window.setInterval(() => void load(), FEED_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [sinceMs]);

  const status = statusOf(blob);
  const dotColor = status === "on" ? pal.accent : status === "error" ? pal.warn : pal.ink3;
  const label = status === "on" ? "sensing" : status === "error" ? "not responding" : "off";

  return (
    <div
      style={{
        position: "absolute", top: 22, left: 26, display: "flex", alignItems: "center", gap: 10,
        fontFamily: FONT, fontSize: 11.5, color: pal.ink3,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7, height: 7, borderRadius: 999, background: dotColor,
          boxShadow: status === "on" ? `0 0 0 3px ${dotColor}22` : "none",
        }}
      />
      <span style={{ color: pal.ink2 }}>{blob?.camera ?? "camera"}</span>
      <span>· {label}</span>
      {violations > 0 && (
        <span style={{ color: pal.warn }}>· {violations} flagged</span>
      )}
    </div>
  );
}
