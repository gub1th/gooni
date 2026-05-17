import { forwardRef, useMemo } from "react";
import { Effect } from "postprocessing";
import * as THREE from "three";

// Custom Effect — multiplicative warmth tint + contrast lift + saturation
// boost. Mirrors the shader from the Gooni Plaza spec exactly.

const fragmentShader = /* glsl */ `
  uniform vec3 warmth;
  uniform float contrast;
  uniform float saturation;
  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec3 c = inputColor.rgb * warmth;
    c = (c - 0.5) * contrast + 0.5;
    float g = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(g), c, saturation);
    outputColor = vec4(c, inputColor.a);
  }
`;

type WarmthOpts = {
  warmth?: [number, number, number];
  contrast?: number;
  saturation?: number;
};

class WarmthPass extends Effect {
  constructor(opts: WarmthOpts = {}) {
    const warmth = opts.warmth ?? [1.05, 1.02, 0.95];
    const contrast = opts.contrast ?? 1.10;
    const saturation = opts.saturation ?? 1.15;
    super("WarmthPass", fragmentShader, {
      uniforms: new Map<string, THREE.Uniform>([
        ["warmth", new THREE.Uniform(new THREE.Vector3(...warmth))],
        ["contrast", new THREE.Uniform(contrast)],
        ["saturation", new THREE.Uniform(saturation)],
      ]),
    });
  }
}

export const Warmth = forwardRef<WarmthPass, WarmthOpts>(function Warmth(opts, ref) {
  const effect = useMemo(
    () => new WarmthPass(opts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts.warmth?.join(","), opts.contrast, opts.saturation],
  );
  return <primitive ref={ref} object={effect} dispose={null} />;
});
