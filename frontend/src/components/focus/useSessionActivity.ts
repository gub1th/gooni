import { useCallback, useEffect, useRef, useState } from "react";
import { FEED_REFRESH_MS, fetchSessionActivity, type SessionActivity } from "../../services/api";

// ONE read for the whole focus surface.
//
// The footer, the camera status indicator and the evidence gallery used to pull
// from three endpoints at three different scopes — `/focus/cam/today` (local
// day), `/focus/dashboard` rollups (local day) and `/focus/cam/evidence` (last
// few days). All three were answering a question nobody on this surface asked,
// which is how a twenty-minute session came to report "17 signals today".
//
// They now share this one poll of `/focus/session-activity?since=<session
// start>`, so every number on screen describes the SAME window, and three
// components cannot drift into three answers. It stays AFTER-THE-FACT by
// design (the same `FEED_REFRESH_MS` cadence the feeds already use): the timer
// bounds the window, so a periodic read of what the sensors last said is the
// whole answer.

export interface SessionActivityState {
  data: SessionActivity | null;
  /** True until the first read settles — distinct from "read, and it's empty". */
  loading: boolean;
  /** The last read FAILED. A failed fetch is not evidence of a quiet session,
   *  so callers render "—" rather than a zero. */
  failed: boolean;
}

const EMPTY: SessionActivityState = { data: null, loading: false, failed: false };

/**
 * Poll session-scoped activity for `[sinceMs, now)` while `active`.
 *
 * `sinceMs == null` (no session) yields the empty state and issues no request —
 * there is no window to ask about, and asking with a default one would answer a
 * question about the day, which is the bug this replaces.
 *
 * The last GOOD payload is retained across a failed refresh (only the first
 * load falls through to `failed`), so the footer can't flicker between real
 * numbers and dashes on one dropped poll.
 */
export function useSessionActivity(active: boolean, sinceMs: number | null): SessionActivityState {
  const [state, setState] = useState<SessionActivityState>(EMPTY);
  // Read inside `load` rather than closed over, so a refresh failing doesn't
  // need `state` in the dep array (which would re-arm the interval on every
  // successful poll).
  const hasData = useRef(false);

  const load = useCallback(async () => {
    if (sinceMs == null) return;
    try {
      const data = await fetchSessionActivity(new Date(sinceMs));
      hasData.current = true;
      setState({ data, loading: false, failed: false });
    } catch {
      setState((prev) =>
        hasData.current
          ? { ...prev, loading: false, failed: false }
          : { data: null, loading: false, failed: true },
      );
    }
  }, [sinceMs]);

  useEffect(() => {
    if (!active || sinceMs == null) {
      hasData.current = false;
      setState(EMPTY);
      return;
    }
    hasData.current = false;
    setState({ data: null, loading: true, failed: false });
    void load();
    const iv = window.setInterval(() => void load(), FEED_REFRESH_MS);
    return () => window.clearInterval(iv);
  }, [active, sinceMs, load]);

  return state;
}
