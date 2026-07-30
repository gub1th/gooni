// One biome per station. As the reader scrolls the walk, the world
// cross-fades between these: plains → coast → desert → grassland → snow.
//
// This is DATA only — colours + scalars. `biomeBus` blends two adjacent
// entries by the continuous scroll position (walkPos) every frame, and
// the sky / fog / lights / ground-tint / particles / props all read the
// blended result. Keeping it declarative means a new biome is one entry,
// and the mapping to stations is just array order (index i = station i).
//
// Colours are plain sRGB hex; THREE.Color converts them to linear on
// `set`, which is what the lights + shaders expect.

export type PropKind = "plains" | "coast" | "desert" | "grassland" | "snow";

export type Biome = {
  id: string;
  /** Vertical sky gradient (BiomeSky lerps these into shader uniforms). */
  skyHorizon: string;
  skyTop: string;
  /** Exponential fog — colour matches the sky band so tiles melt into it. */
  fogColor: string;
  fogDensity: number;
  /** Key light. */
  sunColor: string;
  sunIntensity: number;
  /** Fill: sky bounce + ground bounce. */
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  /** Multiplied onto the causeway's per-tile colours to re-tint the road. */
  ground: string;
  /** Which crystalline prop set dresses this stretch. */
  prop: PropKind;
  /** Ambient falling/drifting particle layer. */
  particle: {
    color: string;
    /** Downward speed. 0 ≈ hangs; higher = snow. */
    fall: number;
    /** Horizontal sway amplitude. High = blowing sand. */
    drift: number;
    /** Layer opacity — 0 hides it (coast is nearly clear). */
    opacity: number;
  };
};

export const BIOMES: Biome[] = [
  // 0 · the hero / walk intro — a cool pre-dawn, so the FIRST scroll (intro
  // → origin) is already a visible biome change (cool → warm). Without this
  // the hero and origin were both "plains" and nothing shifted at the start.
  {
    id: "intro",
    skyHorizon: "#d9d2ea",
    skyTop: "#8f97c6",
    fogColor: "#dcd8e8",
    fogDensity: 0.012,
    sunColor: "#e8e2f2",
    sunIntensity: 0.95,
    hemiSky: "#ccd2ee",
    hemiGround: "#c8c4c2",
    hemiIntensity: 0.6,
    ground: "#e0e0ea",
    // Crystal shards — distinct from origin's boulders, so intro → origin
    // visibly transforms (was rock → rock, no change).
    prop: "snow",
    particle: { color: "#e6e0f2", fall: 0.12, drift: 0.6, opacity: 0.2 },
  },
  // 1 · origin — warm dawn plains (the world's original look).
  {
    id: "plains",
    skyHorizon: "#ffe2c4",
    skyTop: "#a7bce0",
    fogColor: "#e8e0d0",
    fogDensity: 0.012,
    sunColor: "#fff4e0",
    sunIntensity: 1.1,
    hemiSky: "#b8c9e8",
    hemiGround: "#d4c8a8",
    hemiIntensity: 0.55,
    ground: "#ffffff",
    prop: "plains",
    particle: { color: "#f2dca0", fall: 0.18, drift: 0.5, opacity: 0.3 },
  },
  // 1 · atlassian — clear cool coast.
  {
    id: "coast",
    skyHorizon: "#dceffa",
    skyTop: "#7fb4e2",
    fogColor: "#dce9ef",
    fogDensity: 0.008,
    sunColor: "#ffffff",
    sunIntensity: 1.2,
    hemiSky: "#c2e4f4",
    hemiGround: "#c9d4cf",
    hemiIntensity: 0.62,
    ground: "#e6eef1",
    prop: "coast",
    particle: { color: "#eaf4ff", fall: 0.12, drift: 0.9, opacity: 0.16 },
  },
  // 2 · kreatify — desert dunes, dusty + harsh.
  {
    id: "desert",
    skyHorizon: "#ffdca0",
    skyTop: "#e6ac64",
    fogColor: "#e9c98e",
    fogDensity: 0.019,
    sunColor: "#fff0c8",
    sunIntensity: 1.35,
    hemiSky: "#ecd6a4",
    hemiGround: "#cf9a52",
    hemiIntensity: 0.5,
    ground: "#e9c98c",
    prop: "desert",
    particle: { color: "#e9cd94", fall: 0.08, drift: 1.7, opacity: 0.26 },
  },
  // 3 · gooni — verdant grassland.
  {
    id: "grassland",
    skyHorizon: "#e2efca",
    skyTop: "#8fc196",
    fogColor: "#cfe0bd",
    fogDensity: 0.013,
    sunColor: "#f4ffe2",
    sunIntensity: 1.12,
    hemiSky: "#cfe8c2",
    hemiGround: "#93b06f",
    hemiIntensity: 0.62,
    ground: "#cfe0ac",
    prop: "grassland",
    particle: { color: "#daf0a2", fall: 0.16, drift: 0.7, opacity: 0.3 },
  },
  // 4 · edge — stark snow tundra. The island runs out: cold + empty.
  {
    id: "snow",
    skyHorizon: "#eef4f9",
    skyTop: "#c4d7ee",
    fogColor: "#eef3f8",
    fogDensity: 0.03,
    sunColor: "#e8f0ff",
    sunIntensity: 0.95,
    hemiSky: "#dce7f3",
    hemiGround: "#cbd6e2",
    hemiIntensity: 0.75,
    ground: "#eef3f8",
    prop: "snow",
    particle: { color: "#ffffff", fall: 0.6, drift: 0.8, opacity: 0.62 },
  },
];
