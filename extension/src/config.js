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

/**
 * The DEPLOYED backend, not localhost.
 *
 * This used to be `http://localhost:8000`, which is a backend that only exists
 * while `dev.sh` is running. A fresh install therefore buffered against nothing
 * for most of every day, retaining correctly and reporting nothing — the exact
 * silent-failure shape the delivery rules in buffer.js exist to prevent, sitting
 * one layer above them in the config.
 *
 * Defaulting to the deployed URL rather than refusing to run unconfigured is the
 * deliberate choice, and it is the same one `enabled` already makes two fields
 * down: an installed sensor that senses nothing is worse than no sensor.
 * Refuse-until-configured fails in the other direction — a fresh install would
 * record nothing until someone visits the options page, which is the same lost
 * data with a better excuse. Localhost is still one edit away for dev work.
 *
 * A wrong-but-reachable default cannot silently eat data either: everything is
 * buffered until the server confirms it, so pointing this at the right place
 * later delivers the backlog. What was missing was any way to NOTICE, which is
 * what health.js and the toolbar badge now provide.
 */
export const DEFAULT_BASE_URL = "https://gooni-bot.fly.dev";

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
