import { createFileRoute } from "@tanstack/react-router";
import { AmbientHome } from "../components/ambient/AmbientHome";

// The old app home — the line-art "presence" surface: the breathing waveform
// that morphs into the voice/typed capture box. It used to be "/"; the Focus
// dashboard took that slot, so the capture home moved here. Reachable via the
// top-right home button (see __root's TopRightControls) and the summoned nav's
// "Capture" entry. AppShell renders it full-bleed (not a summoned sheet), same
// as the index home did — see isFullBleedPath there.
export const Route = createFileRoute("/home")({
  component: AmbientHome,
});
