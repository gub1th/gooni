import { createFileRoute } from "@tanstack/react-router";
import { PasswordGate } from "../components/PasswordGate";
import { AmbientShell } from "../components/focus/AmbientShell";

// The focus-system kiosk (`gooni-focus-system-plan.md`). A standalone,
// chrome-LESS route — __root.tsx's isChromelessPath() keeps the SummonedNav /
// sidebar / widget overlays off this surface, so a browser parked here on a
// second monitor shows nothing but the glanceable display. PasswordGate stays
// (the payload is authed, owner-only data), but once the kiosk browser has a
// token it never shows again.
//
// This route renders the ambient STATE MACHINE (AmbientShell), not the
// dashboard directly: the monitor stays on 24/7, so at rest it shows Gooni
// asleep and only surfaces data when summoned. `/` mounts FocusDashboard bare —
// opening a tab is already a deliberate act.
export const Route = createFileRoute("/focus")({
  component: () => (
    <PasswordGate>
      <AmbientShell />
    </PasswordGate>
  ),
});
