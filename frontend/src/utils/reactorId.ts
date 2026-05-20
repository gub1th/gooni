/**
 * Stable anonymous reactor id, persisted in localStorage so a viewer's
 * reactions survive page reloads + dedup correctly server-side. Generated
 * lazily on first call; never sent anywhere except as the body of POST
 * /reactions. No PII — just a UUID.
 *
 * Public viewers + Daniel both use this same path. When auth lands, swap
 * the body of getReactorId() to prefer a real user id when present.
 */

const STORAGE_KEY = "gooni-reactor-id-v1";

function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as Crypto).randomUUID();
  }
  // Fallback for older browsers — coarse but stable enough for anon
  // dedup. Date + random tail.
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function getReactorId(): string {
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing && existing.length <= 80) return existing;
    const fresh = generateId();
    window.localStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // Private mode / disabled storage — fall back to per-pageload id. Loses
    // dedup across reloads but reactions still work in-session.
    return generateId();
  }
}
