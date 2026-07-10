// Ambient waveform shader (ambient-loop v2 "presence" home).
//
// A Spectre-style glowing waveform rendered entirely in the fragment shader:
// several stacked sine+noise curves, windowed to a burst in the middle of the
// screen, additively glowing (white-hot core → green halo). All motion is
// uniform-driven so the JS side never touches geometry:
//   uTime   — advances only when not paused / reduced-motion (frozen = still)
//   uEnergy — 0..1, how much "something is pending" (raises amplitude + green)
//   uActive — 0..1, interaction (hover/focus) → the wave expands
//   uAspect — viewport w/h so the horizontal window matches any screen
// Bloom (postprocessing) does the actual glow bleed; this just draws hot cores.

export const WAVE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const WAVE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform float uTime;
  uniform float uEnergy;
  uniform float uActive;
  uniform float uAspect;
  uniform vec3  uCore;   // white-hot core
  uniform vec3  uGlow;   // green halo

  // cheap 1-D value noise for organic wobble on top of the sines
  float hash(float n) { return fract(sin(n) * 43758.5453123); }
  float noise(float x) {
    float i = floor(x);
    float f = fract(x);
    float u = f * f * (3.0 - 2.0 * f);
    return mix(hash(i), hash(i + 1.0), u);
  }

  const int LAYERS = 5;

  void main() {
    // center + aspect-correct so x spans the full width, y stays [-1,1]
    vec2 p = (vUv - 0.5) * 2.0;
    p.x *= uAspect;

    // horizontal envelope — the wave is a burst in the middle that tapers to
    // nothing at the edges (the Spectre-icon silhouette)
    float env = exp(-p.x * p.x * 0.5);

    // gentle breathing so the object feels alive even at rest
    float breathe = 0.5 + 0.5 * sin(uTime * 0.6);
    float amp = (0.10 + 0.08 * breathe) * (0.65 + uEnergy * 0.9) * (1.0 + uActive * 0.9);

    vec3 col = vec3(0.0);
    for (int i = 0; i < LAYERS; i++) {
      float fi = float(i);
      float depth = fi / float(LAYERS - 1);        // 0 = front, 1 = back
      float speed = 0.8 + fi * 0.16;
      float freq  = 2.0 + fi * 0.7;
      float phase = fi * 1.7;

      float wave =
          sin(p.x * freq + uTime * speed + phase)
        + 0.5 * sin(p.x * freq * 1.9 - uTime * speed * 1.3 + phase * 2.0)
        + 0.35 * (noise(p.x * 1.5 + uTime * 0.7 + fi * 10.0) * 2.0 - 1.0);
      wave *= amp * env * (1.0 - depth * 0.35);

      // parallax vertical drift per depth → pseudo-3D stacking
      float y = p.y + depth * 0.05 * sin(uTime * 0.3 + fi);
      float dist = abs(y - wave);

      float core = 0.006 / (dist + 0.006);
      float halo = 0.05  / (dist + 0.05);
      float atten = mix(1.0, 0.32, depth);          // back layers dimmer

      // energy + depth push the halo greener; core stays white-hot
      vec3 lineCol = mix(uCore, uGlow, clamp(0.35 + uEnergy * 0.5 + depth * 0.3, 0.0, 1.0));
      col += atten * (core * uCore * 0.9 + halo * lineCol * 0.5) * env;
    }

    // soft vignette to seat the object in the black
    float vig = smoothstep(1.5, 0.2, length(vUv - 0.5) * 1.8);
    col *= vig;

    // reinhard-ish rolloff so the core doesn't clip to a flat white slab
    // (bloom adds the actual bloom on top)
    col = col / (1.0 + col * 0.6);

    gl_FragColor = vec4(col, 1.0);
  }
`;
