/**
 * Extension configuration, stored in chrome.storage.local and edited from the
 * options page — nothing here needs a rebuild to change.
 *
 * The scrub list in particular is meant to be edited: it is the whole of the
 * privacy model (full URLs are captured for every host, minus params whose
 * value is a credential), so Daniel has to be able to add a param name the
 * moment some site invents a new way to put a secret in a query string.
 */

import { SCRUB_SEGMENTS } from "./scrub.js";

export const CONFIG_KEYS = {
  baseUrl: "gooni_base_url",
  token: "gooni_token",
  enabled: "gooni_enabled",
  scrubSegments: "gooni_scrub_segments",
  lastFlush: "gooni_last_flush",
};

export const DEFAULT_BASE_URL = "http://localhost:8000";

/** Seconds of no input before chrome.idle calls it idle. 60 is the API floor. */
export const IDLE_DETECTION_SEC = 60;

export async function loadConfig(storage) {
  const got = (await storage.get(Object.values(CONFIG_KEYS))) || {};
  return {
    baseUrl: (got[CONFIG_KEYS.baseUrl] || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    token: got[CONFIG_KEYS.token] || "",
    // Default ON: an installed sensor that silently senses nothing is worse
    // than no sensor. The options page can pause it.
    enabled: got[CONFIG_KEYS.enabled] !== false,
    scrub: {
      segments: normalizeList(got[CONFIG_KEYS.scrubSegments], SCRUB_SEGMENTS),
    },
    lastFlush: got[CONFIG_KEYS.lastFlush] || null,
  };
}

/**
 * A user list REPLACES the default rather than extending it — an editable list
 * you can only add to isn't editable. The options page seeds the textarea with
 * the defaults so the normal edit is "defaults plus mine".
 */
function normalizeList(raw, fallback) {
  if (!Array.isArray(raw)) return fallback;
  const cleaned = raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  return cleaned.length ? cleaned : fallback;
}

export function ingestEndpoint(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, "")}/browser/intervals`;
}
