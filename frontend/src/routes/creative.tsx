import { createFileRoute } from "@tanstack/react-router";
import { Scene } from "../components/creative/Scene";

export const Route = createFileRoute("/creative")({
  component: CreativePage,
});

function CreativePage() {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        // Pre-Canvas backdrop so the page isn't flash-white before WebGL paints.
        background: "linear-gradient(180deg, #cfb088 0%, #6b8a92 60%, #2c3e3f 100%)",
        overflow: "hidden",
      }}
    >
      <Scene />
    </div>
  );
}
