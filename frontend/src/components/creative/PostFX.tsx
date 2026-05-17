import {
  Bloom,
  EffectComposer,
  Vignette,
} from "@react-three/postprocessing";
import { BlendFunction, KernelSize } from "postprocessing";
import { Warmth } from "./WarmthEffect";

type Props = { mobile: boolean };

// Cinematic toon-friendly post-pipeline (per Gooni Plaza spec):
//   1. Bloom — soft halo on bright pixels (strength 0.3, threshold 0.7).
//      Disabled on mobile.
//   2. Warmth — custom shader: multiplicative warm tint + contrast lift +
//      saturation boost (1.05/1.02/0.95, 1.1x contrast, 1.15x saturation).
//   3. Vignette — gentle corner darkening to focus the eye on the plaza.
//
// FXAA is not added explicitly; postprocessing v6 handles AA via
// EffectComposer multisampling at the renderer level + a single output
// pass — no separate FXAA pass needed at this scale.

export function PostFX({ mobile }: Props) {
  return (
    <EffectComposer multisampling={mobile ? 0 : 2} enableNormalPass={false}>
      {mobile ? (
        <></>
      ) : (
        <Bloom
          intensity={0.30}
          kernelSize={KernelSize.LARGE}
          luminanceThreshold={0.70}
          luminanceSmoothing={0.25}
          mipmapBlur
        />
      )}
      <Warmth warmth={[1.05, 1.02, 0.95]} contrast={1.10} saturation={1.15} />
      <Vignette offset={0.40} darkness={0.30} blendFunction={BlendFunction.NORMAL} />
    </EffectComposer>
  );
}
