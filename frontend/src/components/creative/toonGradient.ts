import * as THREE from "three";

// Single shared 3-band toon gradient — used by every MeshToonMaterial
// in the scene so the whole world reads as one stylistic family.
// 60/140/220 luminance bands give a crisp 3-step shade-mid-lit look.

let cached: THREE.DataTexture | null = null;

export function getToonGradient(): THREE.DataTexture {
  if (cached) return cached;
  const colors = new Uint8Array([60, 60, 60, 255, 140, 140, 140, 255, 220, 220, 220, 255]);
  const tex = new THREE.DataTexture(colors, 3, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  cached = tex;
  return cached;
}

// Recursively replace MeshStandardMaterial / MeshPhysicalMaterial /
// MeshBasicMaterial w/ MeshToonMaterial on a loaded GLTF scene. Keeps
// the original color but swaps the lighting model. Skips materials
// already toon-shaded.
export function applyToonToTree(root: THREE.Object3D, opts?: {
  recolor?: (origColor: THREE.Color, meshName: string) => THREE.Color;
  castShadow?: boolean;
  receiveShadow?: boolean;
}) {
  const grad = getToonGradient();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const origMat = mesh.material as THREE.Material | THREE.Material[];
    function convert(m: THREE.Material): THREE.Material {
      if ((m as THREE.MeshToonMaterial).isMeshToonMaterial) return m;
      const stdMat = m as THREE.MeshStandardMaterial;
      const origColor = stdMat.color?.clone?.() ?? new THREE.Color("#888888");
      const color = opts?.recolor ? opts.recolor(origColor, mesh.name) : origColor;
      const toon = new THREE.MeshToonMaterial({
        color,
        gradientMap: grad,
        map: stdMat.map ?? null,
        transparent: stdMat.transparent,
        opacity: stdMat.opacity,
        side: stdMat.side,
      });
      return toon;
    }
    if (Array.isArray(origMat)) {
      mesh.material = origMat.map(convert);
    } else {
      mesh.material = convert(origMat);
    }
    if (opts?.castShadow !== undefined) mesh.castShadow = opts.castShadow;
    if (opts?.receiveShadow !== undefined) mesh.receiveShadow = opts.receiveShadow;
  });
}
