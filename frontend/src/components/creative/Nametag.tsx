import { Html } from "@react-three/drei";

// Floating game-style nametag — rendered as DOM via drei <Html> at a
// world position. Parent the <Nametag> inside an UNSCALED group so the
// avatar's squash/stretch doesn't drag the position offset around.

type Props = {
  name: string;
  color?: string;
  height?: number;        // local-y offset above the avatar root
  flag?: string | null;   // emoji shown to the left of the name
};

export function Nametag({ name, color = "#ffffff", height = 1.95, flag }: Props) {
  return (
    <Html
      position={[0, height, 0]}
      center
      distanceFactor={7}
      pointerEvents="none"
      zIndexRange={[40, 50]}
      style={{ pointerEvents: "none" }}
    >
      <div
        style={{
          background: "rgba(20,22,28,0.72)",
          color,
          padding: "5px 14px",
          borderRadius: 999,
          fontSize: 16,
          lineHeight: 1,
          fontFamily: "'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
          fontWeight: 600,
          letterSpacing: "0.02em",
          whiteSpace: "nowrap",
          userSelect: "none",
          backdropFilter: "blur(6px) saturate(140%)",
          WebkitBackdropFilter: "blur(6px) saturate(140%)",
          boxShadow: "0 2px 8px rgba(0,0,0,0.30), 0 0 0 1px rgba(255,255,255,0.12) inset",
          transform: "translateZ(0)",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {flag && <span style={{ fontSize: 17 }}>{flag}</span>}
        <span>{name}</span>
      </div>
    </Html>
  );
}
