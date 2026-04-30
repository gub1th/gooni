import type { CSSProperties } from "react";

// Subtle shimmer-pulse placeholder. Pair with React Query's isLoading +
// !data so cached views skip the placeholder entirely on revisit.
interface Props {
  width?: number | string;
  height?: number | string;
  radius?: number;
  style?: CSSProperties;
}

export function Skeleton({ width = "100%", height = 14, radius = 6, style }: Props) {
  return (
    <span
      style={{
        display: "inline-block", width, height, borderRadius: radius,
        background: "linear-gradient(90deg, rgba(0,0,0,0.05) 25%, rgba(0,0,0,0.09) 37%, rgba(0,0,0,0.05) 63%)",
        backgroundSize: "400% 100%",
        animation: "gooni-skeleton-shimmer 1.4s ease infinite",
        ...style,
      }}
    >
      <style>{`
        @keyframes gooni-skeleton-shimmer {
          0%   { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
      `}</style>
    </span>
  );
}
