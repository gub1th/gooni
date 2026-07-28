import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { WalkPage } from "../components/walk/WalkPage";

// Temporary home for the converged portfolio while it's being built
// next to the old plaza, so both can be compared before one replaces
// the other. Once it lands this becomes the canonical public URL and
// /creative + /public/cv fold into it.
export const Route = createFileRoute("/walk")({
  component: WalkRoute,
});

function WalkRoute() {
  // The app shell paints a dark ambient background on the html element;
  // this page owns the full viewport and needs its own ground so the
  // gap above the first paint doesn't flash the wrong colour.
  useEffect(() => {
    const prevHtml = document.documentElement.style.background;
    const prevBody = document.body.style.background;
    const prevMargin = document.body.style.margin;
    document.documentElement.style.background = "#0C0F12";
    document.body.style.background = "#0C0F12";
    document.body.style.margin = "0";
    return () => {
      document.documentElement.style.background = prevHtml;
      document.body.style.background = prevBody;
      document.body.style.margin = prevMargin;
    };
  }, []);

  return <WalkPage />;
}
