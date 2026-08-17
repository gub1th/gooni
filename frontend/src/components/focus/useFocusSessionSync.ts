import { useEffect } from "react";
import { syncFocusSession } from "../../stores/useFocusSessionStore";

/** How often to ask the server what is actually running. */
export const SESSION_SYNC_MS = 20_000;

// Keep the client's mirror pointed at the server's session — ONE owner,
// app-level, mounted once in AppShell beside `useFocusCamControl`.
//
// It runs on MOUNT first and on an interval after, and both matter for a
// different reason:
//
//   · mount is the restore. A refresh, a cold app launch, or a second monitor
//     opening the app all recover the running session from here — the whole
//     point of the session having become a row.
//   · the interval is what makes the OTHER writers visible. A session Claude
//     started over MCP, one stopped from `/focus` while `/` sat open on another
//     screen, and a session the server retired at the 6h cap all reach this tab
//     only by being asked about.
//
// It also syncs on `visibilitychange`, which is the machine-sleep case: a
// laptop closed on a running session wakes with a clock that has been ticking
// locally against a session the server may have already capped, and waiting up
// to a full interval to notice is exactly the stale-clock bug the move to the
// server was meant to end.
export function useFocusSessionSync() {
  useEffect(() => {
    void syncFocusSession();
    const iv = window.setInterval(() => void syncFocusSession(), SESSION_SYNC_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncFocusSession();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
