import { useCallback, useEffect, useState } from "react";
import { FONT } from "../../ui";
import { FOCUS_PALETTES } from "./focusPalette";
import { useGooniThemeStore } from "../../stores/useGooniThemeStore";
import { FocusSessionRecap, type SessionRecapData } from "./FocusSessionRecap";
import { recapFromSession } from "../../services/sessionRecap";
import { fetchFocusSession, patchFocusSession } from "../../services/api";

interface Props {
  sessionId: number;
  onClose: () => void;
}

/**
 * Addresses the analytics dashboard by SESSION ID rather than by "whatever
 * `FocusExpanded` just built" — the fetch + mapper (`recapFromSession`) are
 * the exact same path a just-stopped session and a three-week-old one both
 * go through, which is the whole point: one dashboard, reachable for ANY
 * session, not a special case for the one that ended a moment ago.
 *
 * Re-fetches on every `sessionId` change (including the first mount) rather
 * than trusting a cached copy — this view is cheap to re-enter (a click on
 * the history list, a reload landing on a persisted id) and a session's
 * numbers can change under it (a rename from another tab, a fresh sensor
 * read), so "the freshest read" beats "whatever we last had".
 */
export function FocusSessionRecapView({ sessionId, onClose }: Props) {
  const theme = useGooniThemeStore((s) => s.theme);
  const pal = FOCUS_PALETTES[theme];
  const [recap, setRecap] = useState<SessionRecapData | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const session = await fetchFocusSession(sessionId, { activity: true });
      setRecap(recapFromSession(session));
    } catch {
      setFailed(true);
    }
  }, [sessionId]);

  useEffect(() => {
    setRecap(null);
    void load();
  }, [load]);

  // Optimistic: the input already shows the new text the instant it commits,
  // and a failed PATCH rolls the local copy back — the SAME pattern
  // `TodayList`'s tick uses, so a flaky connection doesn't leave the title
  // hanging on the request.
  async function rename(title: string) {
    setRecap((prev) => (prev ? { ...prev, title } : prev));
    try {
      await patchFocusSession(sessionId, { title });
    } catch {
      void load();
    }
  }

  if (failed) {
    return (
      <div
        style={{
          width: "100%", height: "100%", display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 14,
          fontFamily: FONT, color: pal.ink2, fontSize: 13,
        }}
      >
        <span>couldn&apos;t load this session</span>
        <button
          onClick={onClose}
          style={{
            border: `1px solid ${pal.rule}`, background: "transparent", cursor: "pointer",
            borderRadius: 999, padding: "7px 16px", fontFamily: FONT, fontSize: 12, color: pal.ink2,
          }}
        >
          close
        </button>
      </div>
    );
  }

  if (!recap) {
    return (
      <div
        style={{
          width: "100%", height: "100%", display: "grid", placeItems: "center",
          fontFamily: FONT, color: pal.ink3, fontSize: 13,
        }}
      >
        loading…
      </div>
    );
  }

  return <FocusSessionRecap recap={recap} onClose={onClose} onRename={rename} />;
}
