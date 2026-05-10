// 10-color palette mirrors `_COLOR_PALETTE` in
// app/services/focus_service.py. Backend assigns one on focus creation
// (cycled by total focus count); frontend uses the stored value as-is
// and only falls back to the palette index for legacy NULL rows.
export const FOCUS_PALETTE = [
  "#22C55E", "#3B82F6", "#F59E0B", "#A855F7", "#EF4444",
  "#06B6D4", "#EC4899", "#84CC16", "#F97316", "#14B8A6",
] as const;

export const FOCUS_FALLBACK = "#94A3B8"; // slate-400 for un-coloured rows

// Pick a deterministic palette color from a focus id. Used only when a
// row's `color` field is null (older rows pre-migration backfill).
export function focusColorFromId(id: number): string {
  return FOCUS_PALETTE[id % FOCUS_PALETTE.length];
}

// Resolve a focus's effective color: stored value wins, then id-derived,
// then a neutral fallback for "unknown focus" / chip-without-id cases.
export function resolveFocusColor(
  color: string | null | undefined,
  id?: number | null,
): string {
  if (color) return color;
  if (typeof id === "number") return focusColorFromId(id);
  return FOCUS_FALLBACK;
}
