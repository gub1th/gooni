import { createFileRoute } from "@tanstack/react-router";
import { PasswordGate } from "../components/PasswordGate";
import { FocusKiosk } from "../components/focus/FocusKiosk";

// `/focus` — the chromeless KIOSK WINDOW onto a session (prototype pass 2).
//
// It is no longer where focus happens. Focus is a STATE, not a place: the
// session is owned by the banner, which rides every surface, so pause/resume
// are always under your thumb. Making this a page conflated BEING in focus with
// LOOKING AT focus, and stranded the controls on a route you had navigated away
// from. This route is now just a second-monitor view of the same session.
//
// Chrome-LESS (see __root.tsx's isChromelessPath) — app nav on a glance surface
// is the opposite of the point. PasswordGate stays: owner-only data.
// Gooni asleep is the idle state; see FocusKiosk for why he lives here.
export const Route = createFileRoute("/focus")({
  component: () => (
    <PasswordGate>
      <FocusKiosk />
    </PasswordGate>
  ),
});
