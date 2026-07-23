import { createFileRoute } from "@tanstack/react-router";
import { PasswordGate } from "../components/PasswordGate";
import { FocusDashboard } from "../components/focus/FocusDashboard";

// The focus-system kiosk (`gooni-focus-system-plan.md`). A standalone,
// chrome-LESS route — __root.tsx's isChromelessPath() keeps the SummonedNav /
// sidebar / widget overlays off this surface, so a browser parked here on a
// second monitor shows nothing but the glanceable display. PasswordGate stays
// (the payload is authed, owner-only data), but once the kiosk browser has a
// token it never shows again.
export const Route = createFileRoute("/focus")({
  component: () => (
    <PasswordGate>
      <FocusDashboard />
    </PasswordGate>
  ),
});
