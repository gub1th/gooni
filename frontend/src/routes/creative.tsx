import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Scene } from "../components/creative/Scene";
import { HamsterWheel } from "../components/animations/HamsterWheel";

export const Route = createFileRoute("/creative")({
  component: CreativePage,
});

// Pre-paint background. Match the SkyDome horizon palette so the gap
// between route mount and first Canvas paint doesn't flash a different
// color.
const PRE_PAINT_BG = "linear-gradient(180deg, #b0c4de 0%, #d8d0ce 55%, #ffe2c4 100%)";

// Custom hand cursor. Bigger than system default but not gigantic
// (~36px). Hotspot at fingertip (10, 4). Applied to the whole route
// container so the loader, landing overlay, and gameplay scene all
// share it.
const HAND_CURSOR_SVG = encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='36' height='36' viewBox='0 0 24 24'>` +
  `<path d='M9 11 V4 a1.6 1.6 0 0 1 3.2 0 V11 V7.5 a1.6 1.6 0 0 1 3.2 0 V11 V9 a1.6 1.6 0 0 1 3.2 0 V14 c0 3.6 -2.6 6 -6.4 6 c-3 0 -5.4 -1.8 -6.4 -4.6 L4.4 11 a1.6 1.6 0 0 1 2.6 -1.7 L9 11 Z' ` +
  `fill='white' stroke='#222' stroke-width='1.4' stroke-linejoin='round' stroke-linecap='round'/>` +
  `</svg>`,
);
const HAND_CURSOR = `url("data:image/svg+xml;utf8,${HAND_CURSOR_SVG}") 8 3, pointer`;

function CreativePage() {
  const [canvasReady, setCanvasReady] = useState(false);

  useEffect(() => {
    const prevHtmlBg = document.documentElement.style.background;
    const prevBodyBg = document.body.style.background;
    const prevMargin = document.body.style.margin;
    document.documentElement.style.background = PRE_PAINT_BG;
    document.body.style.background = PRE_PAINT_BG;
    document.body.style.margin = "0";
    return () => {
      document.documentElement.style.background = prevHtmlBg;
      document.body.style.background = prevBodyBg;
      document.body.style.margin = prevMargin;
    };
  }, []);

  // Hold the loader for a beat so the user sees the hamster wheel,
  // then fade it out — gives Canvas + GLTFs time to finish.
  useEffect(() => {
    const t = setTimeout(() => setCanvasReady(true), 1400);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: PRE_PAINT_BG,
        overflow: "hidden",
        cursor: HAND_CURSOR,
      }}
    >
      <Scene />
      <PrePaintLoader fadeOut={canvasReady} />
    </div>
  );
}

function PrePaintLoader({ fadeOut }: { fadeOut: boolean }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: PRE_PAINT_BG,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 22,
        zIndex: 50,
        color: "#5a4a32",
        fontFamily: "'Iowan Old Style', 'Hoefler Text', Georgia, serif",
        opacity: fadeOut ? 0 : 1,
        pointerEvents: fadeOut ? "none" : "auto",
        transition: "opacity 600ms ease-out",
      }}
    >
      <HamsterWheel size={140} />
      <div style={{ fontSize: 16, opacity: 0.75, letterSpacing: "0.04em" }}>
        gooni is waking up…
      </div>
    </div>
  );
}
