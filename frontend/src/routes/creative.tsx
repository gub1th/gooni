import { createFileRoute, redirect } from "@tanstack/react-router";

// /creative is now a permanent redirect alias for the portfolio front
// door at /public. The plaza scene itself lives in
// components/creative/CreativeExperience and renders at /public.
// Kept so old bookmarks / external links to /creative don't 404.
export const Route = createFileRoute("/creative")({
  beforeLoad: () => {
    throw redirect({ to: "/public" });
  },
});
