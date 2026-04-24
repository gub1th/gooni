import { useEffect, useRef } from "react";
import * as THREE from "three";

// A compact 3D brain, hand-rolled from a sphere via vertex displacement so it
// actually looks like a brain: oblong proportions (longer front-to-back),
// bumpy gyri-like surface, a longitudinal fissure groove down the top. Shaded
// with a single directional light for form; subtle green synapse nodes float
// just above the surface and pulse. Minimalist-dark to match the mascot.

interface BrainOrbProps {
  size?: number;
  onClick?: () => void;
}

// Pseudo-noise built from stacked sines. Good enough for small-scale surface
// detail; no need to pull in simplex-noise.
function surfaceBump(x: number, y: number, z: number): number {
  return (
    0.035 * Math.sin(x * 11.5) * Math.cos(z * 10.2) +
    0.028 * Math.sin((y + x) * 14.3) * Math.cos(z * 7.1) +
    0.022 * Math.cos(z * 16.8 + y * 9.4) +
    0.018 * Math.sin(x * 19.2 + y * 6.7)
  );
}

function buildBrainGeometry(): THREE.BufferGeometry {
  const geom = new THREE.SphereGeometry(0.85, 80, 60);
  const pos = geom.attributes.position as THREE.BufferAttribute;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.sqrt(x * x + y * y + z * z) || 1;
    const nx = x / r, ny = y / r, nz = z / r;

    // Gyri/sulci bumps
    const bump = surfaceBump(x, y, z);

    // Longitudinal fissure: a narrow trough along x=0 on the UPPER hemisphere.
    // Gaussian falloff so the groove fades in/out smoothly.
    const fissure = ny > 0
      ? -0.085 * Math.exp(-Math.pow(x * 11, 2)) * ny
      : 0;

    // Slight forward bias on the frontal lobe (+z side) so the brain reads
    // as front-heavy rather than spherical.
    const frontal = 0.035 * Math.max(0, nz) * Math.max(0, ny);

    const d = bump + fissure + frontal;
    pos.setXYZ(i, x + nx * d, y + ny * d, z + nz * d);
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();
  return geom;
}

export function BrainOrb({ size = 72, onClick }: BrainOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size, false);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    camera.position.set(0, 0.3, 3.2);
    camera.lookAt(0, -0.05, 0);

    // Lighting — warm key + cool fill makes the pink read as flesh-ish rather
    // than plastic. Ambient keeps the sulci readable on the shadow side.
    const key = new THREE.DirectionalLight(0xfff4ec, 1.15);
    key.position.set(2.5, 3, 2.5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdfe7f0, 0.45);
    fill.position.set(-2, 1, -1.5);
    scene.add(fill);
    const ambient = new THREE.AmbientLight(0xffffff, 0.42);
    scene.add(ambient);

    // Brain mesh — anatomical pinkish salmon. Roughness high so it reads as
    // tissue, not ceramic; metalness zero for no specular cues of hard surface.
    const brainGroup = new THREE.Group();
    const brainGeom = buildBrainGeometry();
    const brainMat = new THREE.MeshStandardMaterial({
      color: 0xe8a49e,
      roughness: 0.82,
      metalness: 0.0,
    });
    const brain = new THREE.Mesh(brainGeom, brainMat);
    brainGroup.add(brain);
    // Ellipsoidal proportions: long front-back (z), narrower side-side (x),
    // flatter top-bottom (y). These match a real brain's outline roughly.
    brainGroup.scale.set(1.04, 0.82, 1.22);
    scene.add(brainGroup);

    // Synapse nodes — green (pulsing) + black (steady) dots distributed on
    // the surface via golden-angle sunflower pattern for even spacing. Reads
    // as neural activity + deeper nuclei without looking random-clumpy.
    const greenMat = new THREE.MeshBasicMaterial({
      color: 0x4ade80, transparent: true, opacity: 0.85,
    });
    const blackMat = new THREE.MeshBasicMaterial({
      color: 0x0f0f0f, transparent: true, opacity: 0.85,
    });
    const dotGeom = new THREE.SphereGeometry(0.042, 10, 10);
    const synapses: { mesh: THREE.Mesh; offset: number; animated: boolean }[] = [];
    const N_GREEN = 9;
    const N_BLACK = 4;
    const total = N_GREEN + N_BLACK;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < total; i++) {
      const y = 1 - (i / (total - 1)) * 2;
      const radius = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      const sx = Math.cos(theta) * radius;
      const sz = Math.sin(theta) * radius;
      const isGreen = i < N_GREEN;
      const mesh = new THREE.Mesh(dotGeom, (isGreen ? greenMat : blackMat).clone());
      mesh.position.set(sx * 0.95, y * 0.95, sz * 0.95);
      brainGroup.add(mesh);
      synapses.push({ mesh, offset: i * 0.83, animated: isGreen });
    }

    const start = performance.now();
    renderer.setAnimationLoop(() => {
      const t = (performance.now() - start) / 1000;
      // Slow Y-rotation with a subtle wobble on X.
      brainGroup.rotation.y = t * 0.42;
      brainGroup.rotation.x = Math.sin(t * 0.3) * 0.12;

      // Green synapses pulse; black dots stay steady so they read as
      // structural features rather than activity.
      for (const { mesh, offset, animated } of synapses) {
        if (!animated) continue;
        const phase = Math.sin(t * 2.3 + offset);
        const mat = mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = 0.3 + Math.max(0, phase) * 0.55;
        const scale = 0.8 + Math.max(0, phase) * 0.4;
        mesh.scale.setScalar(scale);
      }

      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      brainGeom.dispose();
      brainMat.dispose();
      dotGeom.dispose();
      greenMat.dispose();
      blackMat.dispose();
      for (const { mesh } of synapses) (mesh.material as THREE.Material).dispose();
      renderer.dispose();
    };
  }, [size]);

  return (
    <button
      onClick={onClick}
      title="Visualize notes"
      aria-label="Visualize notes"
      style={{
        background: "#fff",
        border: "0.5px solid rgba(0,0,0,0.08)",
        borderRadius: 10,
        padding: 6,
        cursor: "pointer",
        transition: "transform 0.15s, border-color 0.15s, box-shadow 0.15s",
        width: size + 12,
        height: size + 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        const b = e.currentTarget as HTMLButtonElement;
        b.style.transform = "scale(1.04)";
        b.style.borderColor = "rgba(0,0,0,0.15)";
        b.style.boxShadow = "0 2px 10px rgba(74,222,128,0.18)";
      }}
      onMouseLeave={(e) => {
        const b = e.currentTarget as HTMLButtonElement;
        b.style.transform = "scale(1)";
        b.style.borderColor = "rgba(0,0,0,0.08)";
        b.style.boxShadow = "none";
      }}
    >
      <canvas ref={canvasRef} style={{ width: size, height: size, display: "block" }} aria-hidden="true" />
    </button>
  );
}
