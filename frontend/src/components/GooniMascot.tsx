import { useGooniMascotTypeStore } from "../stores/useGooniMascotTypeStore";
import { type GooniFace } from "../stores/useGooniFaceStore";
import { GooniMascot2D } from "./GooniMascot2D";
import { GooniMascot3D, GooniFacePreviewCanvas } from "./GooniMascot3D";

// Dispatcher: picks the user's preferred mascot variant. Unmounts and
// remounts the other when the setting flips — ensures the previous Three.js
// context is disposed and we don't leak WebGL resources.

interface GooniMascotProps {
  dashboardRef: React.RefObject<HTMLDivElement | null>;
}

export function GooniMascot(props: GooniMascotProps) {
  const type = useGooniMascotTypeStore((s) => s.type);
  return type === "3d" ? <GooniMascot3D {...props} /> : <GooniMascot2D {...props} />;
}

// GooniFacePreview — shared 2D canvas thumbnail used by SettingsModal. Pure
// 2D canvas (no SVG, no Three.js per preview). Re-exported here so the rest
// of the app imports from a stable module path regardless of mascot variant.
export function GooniFacePreview({ face, size = 36 }: { face: GooniFace; size?: number }) {
  return <GooniFacePreviewCanvas face={face} size={size} />;
}
