import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { BlendFunction, KernelSize } from "postprocessing";

type Props = { mobile: boolean };

// Sun + water highlights bloom, with a faint vignette to focus the eye
// on the boat. Bloom is the biggest single perceptual upgrade in the
// scene — without it the water reflection of the sun is flat-white.
export function PostFX({ mobile }: Props) {
  return (
    <EffectComposer multisampling={mobile ? 0 : 4} enableNormalPass={false}>
      <Bloom
        intensity={mobile ? 0.55 : 0.75}
        kernelSize={KernelSize.LARGE}
        luminanceThreshold={0.62}
        luminanceSmoothing={0.22}
        mipmapBlur
      />
      <Vignette
        offset={0.30}
        darkness={0.45}
        blendFunction={BlendFunction.NORMAL}
      />
    </EffectComposer>
  );
}
