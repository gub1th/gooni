import { useEffect, useState } from "react";
import { FONT } from "../../ui";
import { FOCUS_PALETTES } from "./focusPalette";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { FEED_REFRESH_MS, fetchFocusCam, type FocusCamBlob, type SessionActivity } from "../../services/api";
import { parseServerDate } from "../../utils/date";
import { DISTRACTION_KINDS } from "./focusDetectionKinds";

// Can't tell if the camera is on, which one, or whether anything's been
// flagged — the captain's exact complaint. This is the answer: a small line
// naming the camera, a live sensing state, and a running violation count.
//
// FRESHNESS = LIVENESS, same rule the preview-frame widget already uses
// (`frame_at` older than ~40s means a dead sidecar, not a live one) — a
// `control: running` blob with a stale frame is exactly the state that would
// otherwise silently claim "on" while nothing is actually being sensed.
const STALE_MS = 40_000;

type DetectionStatus = "on" | "off" | "error";

function statusOf(blob: FocusCamBlob | null): DetectionStatus {
  if (!blob || blob.control !== "running") return "off";
  const frameAt = blob.frame_at ? parseServerDate(blob.frame_at)?.getTime() : null;
  if (frameAt == null || Date.now() - frameAt > STALE_MS) return "error";
  return "on";
}

interface Props {
  /** THIS session's activity, polled once by `FocusExpanded`. `null` while the
   *  first read is in flight or after it failed — the count simply doesn't
   *  render, since a failed read is not evidence of a clean session. */
  activity: SessionActivity | null;
}

export function FocusCameraStatus({ activity }: Props) {
  const theme = useGooniThemeStore((s) => s.theme);
  const pal = FOCUS_PALETTES[theme];
  const [blob, setBlob] = useState<FocusCamBlob | null>(null);

  // The flagged count comes from the session's camera EVENTS, not from kept
  // evidence frames. It used to count frames, which meant it read zero all
  // session for as long as the sidecar posts detections (`/focus/cam/events`)
  // without posting a frame for them (`/focus/cam/evidence`) — which is the
  // state it is in today. The event is the detection; the frame is optional
  // proof of one.
  const violations = (activity?.camera_events ?? [])
    .filter((e) => DISTRACTION_KINDS.has(e.kind))
    .reduce((n, e) => n + e.count, 0);

  // The control blob stays its OWN fetch, deliberately: it is liveness (which
  // camera, is a frame still arriving), not a rollup over a window, so it has
  // no business riding the session-scoped read.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const b = await fetchFocusCam();
        if (!cancelled) setBlob(b);
      } catch {
        // best-effort — the indicator falls back to "off", which is the safe
        // read: claiming "sensing" off a failed fetch is the one lie here
      }
    };
    void load();
    const iv = window.setInterval(() => void load(), FEED_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, []);

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
