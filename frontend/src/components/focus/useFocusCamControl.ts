import { useEffect } from "react";
import { isAccruingFocus, useFocusSessionStore } from "../../stores/useFocusSessionStore";
import { setFocusCamControl } from "../../services/api";

// Who tells the sidecar to sense — ONE owner, app-level.
//
// This used to live on the focus page, which was fine while focus WAS a page.
// It cannot live on a view any more: the overlay unmounts every time you
// collapse it back to the strip, and an unmount-clears rule there would stop the
// camera mid-session on a collapse. It cannot live on the banner either, because
// the banner is mounted by `HomeCorner` on the home and by `TopRightControls`
// everywhere else — two different component instances, so a home→notes
// navigation would unmount one and mount the other, firing `idle` and `running`
// as racing posts with no guaranteed order.
//
// So it is a hook mounted ONCE in AppShell, which survives every route change
// inside the app. Control follows the SESSION, which is what it was always
// about; the session outlives any particular view of it.
//
// The rule itself is unchanged and load-bearing: the sidecar senses during LIVE
// FOCUS ONLY — never while paused — because nothing should be sensed for a
// window that will never be written.
//
// **The unmount-clear is GONE (2026-08-16), and its removal is the point of the
// server-side lifecycle rather than an oversight.** It existed because a closed
// tab used to be the end of the session as far as anything could tell, so the
// only safe reading of "this tab is going away" was "stop sensing". Now the
// session is a row: closing a tab mid-session leaves a session that is genuinely
// still running, and posting `idle` on the way out would blind the sidecar for
// the rest of it — on a laptop with a second monitor, merely closing one window.
// What used to be covered by unmount is covered better by the two things that
// replaced it: `focus_session_service` reconciles control on every transition
// (so a stop from ANY client releases the camera), and `active()` retires a
// session past the 6h cap on the next read, which releases it too.
//
// This hook is therefore now purely belt-and-braces: it re-posts the same value
// the server already set, which is what heals a sidecar that was asleep at click
// time.
export function useFocusCamControl() {
  const session = useFocusSessionStore((s) => s.session);
  const promiseId = session?.promiseId ?? null;
  const accruing = isAccruingFocus(session);

  useEffect(() => {
    void setFocusCamControl(
      accruing ? "running" : "idle",
      accruing ? promiseId : null,
    ).catch(() => {});
  }, [promiseId, accruing]);
}
