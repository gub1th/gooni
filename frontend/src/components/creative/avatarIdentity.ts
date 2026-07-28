// Who the visitor is, carried across the drop.
//
// You choose a colour and a name in the plaza, then fall through the
// hole into the walk — and it has to be the SAME character that walks
// the story, or the drop reads as a scene change rather than as you
// going somewhere. Route changes remount everything, so identity can't
// live in either scene's component state.
//
// localStorage rather than a store so a refresh mid-walk doesn't reset
// the visitor to a stranger.

const KEY = "gooni-visitor-v1";

export type AvatarIdentity = {
  name: string;
  bodyColor: string;
  accentColor: string;
};

export const DEFAULT_IDENTITY: AvatarIdentity = {
  name: "too lazy",
  bodyColor: "#4ADE80",
  accentColor: "#3AAD6E",
};

/** Darker sibling of the body colour, for limbs/trim. Keeps a
 *  user-picked colour from needing a hand-authored pair. */
export function accentFor(hex: string): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return DEFAULT_IDENTITY.accentColor;
  const dim = (v: number) => Math.max(0, Math.round(v * 0.76));
  const r = dim(parseInt(h.slice(0, 2), 16));
  const g = dim(parseInt(h.slice(2, 4), 16));
  const b = dim(parseInt(h.slice(4, 6), 16));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function setIdentity(name: string, bodyColor: string): void {
  try {
    const id: AvatarIdentity = { name, bodyColor, accentColor: accentFor(bodyColor) };
    localStorage.setItem(KEY, JSON.stringify(id));
  } catch {
    // Private mode / quota — the walk falls back to the default colour,
    // which is a cosmetic loss, not a broken experience.
  }
}

export function getIdentity(): AvatarIdentity {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_IDENTITY;
    const parsed = JSON.parse(raw) as Partial<AvatarIdentity>;
    if (typeof parsed?.bodyColor !== "string") return DEFAULT_IDENTITY;
    return {
      name: typeof parsed.name === "string" ? parsed.name : DEFAULT_IDENTITY.name,
      bodyColor: parsed.bodyColor,
      accentColor:
        typeof parsed.accentColor === "string" ? parsed.accentColor : accentFor(parsed.bodyColor),
    };
  } catch {
    return DEFAULT_IDENTITY;
  }
}
