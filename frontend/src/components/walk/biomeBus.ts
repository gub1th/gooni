import * as THREE from "three";
import { BIOMES } from "./biomes";

// The live, blended biome palette — the moving average of two adjacent
// biomes weighted by the continuous scroll position. ONE driver calls
// updateBiome(walkPos) each frame (first, before any reader); the sky,
// lights, fog, ground tint and particles then read getBiome().
//
// Same rationale as scrollBus: this is hot per-frame state read inside
// useFrame, so it lives module-level, not in React state — and every
// THREE.Color is a reused instance, never re-allocated per frame.

const cur = {
  skyHorizon: new THREE.Color("#ffe2c4"),
  skyTop: new THREE.Color("#a7bce0"),
  fogColor: new THREE.Color("#e8e0d0"),
  fogDensity: 0.012,
  sunColor: new THREE.Color("#fff4e0"),
  sunIntensity: 1.1,
  hemiSky: new THREE.Color("#b8c9e8"),
  hemiGround: new THREE.Color("#d4c8a8"),
  hemiIntensity: 0.55,
  ground: new THREE.Color("#ffffff"),
  particleColor: new THREE.Color("#f2dca0"),
  particleFall: 0.18,
  particleDrift: 0.5,
  particleOpacity: 0.3,
  /** Rounded dominant biome index — for anything that wants a discrete pick. */
  index: 0,
};

// Scratch colour for the far endpoint of each lerp — reused, never leaks.
const tmp = new THREE.Color();

function lerpHex(out: THREE.Color, from: string, to: string, t: number) {
  out.set(from).lerp(tmp.set(to), t);
}
function lerpNum(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export function updateBiome(walkPos: number) {
  const n = BIOMES.length;
  // +1: biome 0 is the intro (hero, walkPos −1), then station i → biome i+1,
  // so every section — including the very first scroll — changes biome.
  const p = Math.max(0, Math.min(n - 1, walkPos + 1));
  const i0 = Math.floor(p);
  const i1 = Math.min(i0 + 1, n - 1);
  const t = p - i0;
  const a = BIOMES[i0];
  const b = BIOMES[i1];

  lerpHex(cur.skyHorizon, a.skyHorizon, b.skyHorizon, t);
  lerpHex(cur.skyTop, a.skyTop, b.skyTop, t);
  lerpHex(cur.fogColor, a.fogColor, b.fogColor, t);
  cur.fogDensity = lerpNum(a.fogDensity, b.fogDensity, t);
  lerpHex(cur.sunColor, a.sunColor, b.sunColor, t);
  cur.sunIntensity = lerpNum(a.sunIntensity, b.sunIntensity, t);
  lerpHex(cur.hemiSky, a.hemiSky, b.hemiSky, t);
  lerpHex(cur.hemiGround, a.hemiGround, b.hemiGround, t);
  cur.hemiIntensity = lerpNum(a.hemiIntensity, b.hemiIntensity, t);
  lerpHex(cur.ground, a.ground, b.ground, t);
  lerpHex(cur.particleColor, a.particle.color, b.particle.color, t);
  cur.particleFall = lerpNum(a.particle.fall, b.particle.fall, t);
  cur.particleDrift = lerpNum(a.particle.drift, b.particle.drift, t);
  cur.particleOpacity = lerpNum(a.particle.opacity, b.particle.opacity, t);
  cur.index = Math.round(p);
}

export function getBiome() {
  return cur;
}
