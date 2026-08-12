// Ink on the void, at an alpha.
//
// The ambient home paints with `--gooni-ink` (an RGB TRIPLET, so one var carries
// every alpha a call site needs — near-white on the black void in dark, dark ink
// on the warm off-white in light). This is just the string builder; before it,
// the same `rgb(var(--gooni-ink, 244 245 244) / 0.42)` literal was pasted a few
// dozen times per surface and the fallback drifted between copies.
export function ink(alpha: number): string {
  return `rgb(var(--gooni-ink, 244 245 244) / ${alpha})`;
}

/** Panel/fill base, at an alpha. */
export function surf(alpha: number): string {
  return `rgb(var(--gooni-surf, 11 15 13) / ${alpha})`;
}
