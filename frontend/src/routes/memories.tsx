import { createFileRoute, redirect } from "@tanstack/react-router";

// `/memories` is now a REDIRECT, not a surface. The view itself moved onto the
// index route (`/?view=memories`) because it was the last surface with a path of
// its own: the shell slides a panel over the home, and the home is mounted on
// `/`, so arriving here meant the panel slid over an empty void — a page stamped
// on top of nothing, which is what stage 1 exists to end.
//
// It stays declared rather than deleted so bookmarks and old deep links keep
// resolving; `?focus=<id>` is carried across, since that is what the MemoryBrain
// "view memory →" CTA and the note memories panel hand it.
export const Route = createFileRoute("/memories")({
  validateSearch: (s: Record<string, unknown>) => ({
    focus: typeof s.focus === "number"
      ? s.focus
      : typeof s.focus === "string" && s.focus.length > 0
        ? Number(s.focus) || undefined
        : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/",
      search: { view: "memories" as const, focus: search.focus },
      replace: true,
    });
  },
});
