import { useEffect, useRef } from "react";
import { GooniMascot2D } from "./GooniMascot2D";
import { type GooniFace } from "../stores/useGooniFaceStore";

interface GooniMascotProps {
  dashboardRef: React.RefObject<HTMLDivElement | null>;
}

// Single mascot variant — the 2D walking Gooni. The earlier Three.js variant
// has been removed; this dispatcher stays so other components keep their
// import path stable.
export function GooniMascot(props: GooniMascotProps) {
  return <GooniMascot2D {...props} />;
}

// ──────────────────────────────────────────────────────────────────────────────
// Per-face geometry tuning. Used by the 36px preview thumbnail rendered in the
// SettingsModal face picker. Only the preview lives here; the live mascot's
// face state is owned by GooniMascot2D.
// ──────────────────────────────────────────────────────────────────────────────
interface FaceConfig {
  eyeScaleX: number;
  eyeScaleY: number;
  eyeOffsetX: number;
  eyeOffsetY: number;
  mouthCurveY: number;
  mouthWidth: number;
}

const FACES: Record<GooniFace, FaceConfig> = {
  "smirk":           { eyeScaleX: 1.0, eyeScaleY: 1.0,  eyeOffsetX: 0.00, eyeOffsetY: 0.00, mouthCurveY: 0.03,  mouthWidth: 0.12 },
  "side-eye":        { eyeScaleX: 1.0, eyeScaleY: 1.0,  eyeOffsetX: 0.04, eyeOffsetY: 0.00, mouthCurveY: 0.00,  mouthWidth: 0.11 },
  "hyped":           { eyeScaleX: 1.2, eyeScaleY: 1.2,  eyeOffsetX: 0.00, eyeOffsetY: 0.02, mouthCurveY: 0.08,  mouthWidth: 0.18 },
  "dead-inside":     { eyeScaleX: 1.0, eyeScaleY: 0.12, eyeOffsetX: 0.00, eyeOffsetY: 0.00, mouthCurveY: 0.00,  mouthWidth: 0.10 },
  "sus":             { eyeScaleX: 0.9, eyeScaleY: 0.45, eyeOffsetX: 0.00, eyeOffsetY: 0.01, mouthCurveY: -0.02, mouthWidth: 0.10 },
  "crying-laughing": { eyeScaleX: 1.0, eyeScaleY: 0.12, eyeOffsetX: 0.00, eyeOffsetY: 0.00, mouthCurveY: 0.10,  mouthWidth: 0.20 },
};

export function GooniFacePreview({ face, size = 36 }: { face: GooniFace; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    ctx.fillStyle = "#F2F2F2";
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.lineWidth = 0.5;
    ctx.stroke();

    const cfg = FACES[face];
    const cx = size / 2;
    const cy = size / 2;

    ctx.fillStyle = "#1a1a1a";
    const eyeR = size * 0.08;
    const eyeSpacing = size * 0.13;
    const eyeY = cy - size * 0.03 - cfg.eyeOffsetY * size;
    for (const side of [-1, 1] as const) {
      const eyeX = cx + side * (eyeSpacing - cfg.eyeOffsetX * size);
      ctx.save();
      ctx.translate(eyeX, eyeY);
      ctx.scale(cfg.eyeScaleX, Math.max(0.12, cfg.eyeScaleY));
      ctx.beginPath();
      ctx.arc(0, 0, eyeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const mouthW = size * cfg.mouthWidth * 2;
    const mouthY = cy + size * 0.15;
    const curveY = mouthY - cfg.mouthCurveY * size * 2;
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = Math.max(1, size * 0.04);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx - mouthW / 2, mouthY);
    ctx.quadraticCurveTo(cx, curveY, cx + mouthW / 2, mouthY);
    ctx.stroke();
  }, [face, size]);

  return <canvas ref={ref} style={{ width: size, height: size, display: "block" }} aria-hidden="true" />;
}
