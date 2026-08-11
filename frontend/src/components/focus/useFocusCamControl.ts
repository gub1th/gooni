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
// FOCUS ONLY — never on a break, never while paused — because nothing should be
// sensed for a window that will never be written, and break segments are exactly
// such a window (`splitSegmentsByDay` drops them). Unmount ALWAYS clears, so a
// closed tab can never leave the camera running.
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

  // Deliberately its own effect. Folded into the one above, a resume would fire
  // cleanup(idle) and setup(running) as two racing posts, and an idle landing
  // last would leave the sidecar asleep for the rest of the session.
  useEffect(() => {
    return () => { void setFocusCamControl("idle", null).catch(() => {}); };
  }, []);
}
