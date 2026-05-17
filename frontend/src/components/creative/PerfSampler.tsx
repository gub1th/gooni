import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";

export type PerfMetrics = {
  fps: number;
  ms: number;
  draws: number;
  tris: number;
};

type Props = { onSample: (m: PerfMetrics) => void };

const SAMPLE_INTERVAL_MS = 250;
const WINDOW_FRAMES = 60;
// Reject anomalous frame times caused by tab-switch / rAF resume.
// 100ms = 10fps floor; anything worse than that almost always means
// the tab was hidden, not a real perf issue.
const DT_CAP = 0.10;

export function PerfSampler({ onSample }: Props) {
  const { gl } = useThree();
  const dtsRef = useRef<number[]>([]);
  const lastSampleRef = useRef(0);
  const lastDrawsRef = useRef(0);
  const lastTrisRef = useRef(0);

  // On tab-return, clear the rolling window so stale spike frames
  // don't pollute the FPS average for the next ~15s.
  useEffect(() => {
    function onVis() {
      if (!document.hidden) {
        dtsRef.current = [];
        lastSampleRef.current = 0;
      }
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useFrame((_, dt) => {
    // Cap dt so a single bad frame can't tank the rolling average.
    const cappedDt = Math.min(dt, DT_CAP);
    dtsRef.current.push(cappedDt);
    if (dtsRef.current.length > WINDOW_FRAMES) dtsRef.current.shift();

    lastDrawsRef.current = gl.info.render.calls;
    lastTrisRef.current = gl.info.render.triangles;

    const now = performance.now();
    if (now - lastSampleRef.current >= SAMPLE_INTERVAL_MS) {
      lastSampleRef.current = now;
      const dts = dtsRef.current;
      const avgDt = dts.length > 0
        ? dts.reduce((a, b) => a + b, 0) / dts.length
        : 0.016;
      const fps = avgDt > 0 ? Math.round(1 / avgDt) : 0;
      onSample({
        fps,
        ms: Math.round(avgDt * 1000),
        draws: lastDrawsRef.current,
        tris: lastTrisRef.current,
      });
    }
  });

  return null;
}
