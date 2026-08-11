import { createFileRoute } from "@tanstack/react-router";
import { PasswordGate } from "../components/PasswordGate";
import { FocusSession } from "../components/focus/FocusSession";

// The focus SESSION page. Reached only by the focus control on a task row —
// focus has exactly one door and it is a task, which is what makes sensor
// attribution work without a classifier.
//
// Still a chrome-LESS route (see __root.tsx's isChromelessPath): a session is
// one task and a clock, and the app nav on top of that is the opposite of the
// point. PasswordGate stays — the payload is authed, owner-only data.
//
// With no session running this renders Gooni asleep rather than redirecting.
// It used to host the kiosk dashboard (AmbientShell → FocusDashboard); both are
// gone, the home absorbed what they showed.
export const Route = createFileRoute("/focus")({
  component: () => (
    <PasswordGate>
      <FocusSession />
    </PasswordGate>
  ),
});
