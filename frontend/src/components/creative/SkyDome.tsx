import { useMemo } from "react";
import * as THREE from "three";

// Large skybox sphere w/ vertical gradient — warm peach at horizon,
// soft periwinkle at zenith. Rendered inside-out (BackSide). No
// async load, no shader file — colors come from vertex colors baked
// at construction.
export function SkyDome() {
  const { geometry, material } = useMemo(() => {
    const geo = new THREE.SphereGeometry(120, 32, 24);
    // Build vertex colors based on Y (height in sphere).
    const horizon = new THREE.Color("#ffe2c4");       // warm peach
    const upper   = new THREE.Color("#c8d8ee");       // soft periwinkle
    const top     = new THREE.Color("#a7bce0");       // deeper sky
    const colors: number[] = [];
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      // Normalize to 0..1 — y goes from -120 (bottom) to 120 (top)
      const v = (y + 120) / 240;
      let c: THREE.Color;
      if (v < 0.5) {
        // Below horizon equator — peach base, slightly dimmer downward
        const k = v / 0.5;
        c = horizon.clone().lerp(new THREE.Color("#e9c79c"), 1 - k);
      } else if (v < 0.82) {
        // Horizon → upper sky
        const k = (v - 0.5) / 0.32;
        c = horizon.clone().lerp(upper, k);
      } else {
        // Upper sky → top
        const k = (v - 0.82) / 0.18;
        c = upper.clone().lerp(top, k);
      }
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    return { geometry: geo, material: mat };
  }, []);

  return <mesh geometry={geometry} material={material} renderOrder={-1} />;
}
