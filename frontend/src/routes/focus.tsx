import { createFileRoute } from "@tanstack/react-router";

// `/focus` — the URL that summons the focus hub.
//
// The actual content (FocusKiosk) is mounted permanently in __root.tsx's
// AppShell, inside its own persistent SurfacePanel, and just slid open when
// this route is active — the same "always mounted, parked off-screen" trick
// the shared SurfaceHost uses for notes/memories/etc. A node that only
// mounts when this route matches has no parked frame to animate FROM, so it
// would snap open instead of sliding — which is exactly the bug this route
// used to have. This component therefore renders nothing; it exists only so
// the router has something to match at this path (and so __root's shared
// PasswordGate — which now wraps this path too — actually gates it).
export const Route = createFileRoute("/focus")({
  component: () => null,
});
