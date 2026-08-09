/**
 * URL scrubbing — the extension's only privacy mechanism.
 *
 * The full URL of every host is captured on purpose: the question this sensor
 * answers is "what was I distracted BY", and hostname-only data cannot answer
 * it. A YouTube video id lives in `?v=`, a LeetCode problem in the path — both
 * must survive.
 *
 * The one thing that must never land in the log is a credential. OAuth
 * callbacks, magic links and password-reset links carry live secrets in the
 * query string, and a log of them is a log of ways into Daniel's accounts. So
 * every param whose NAME looks credential-bearing has its VALUE replaced with
 * `REDACTED` before the URL is buffered, and the fragment is dropped entirely
 * (implicit-flow OAuth returns `#access_token=…` there and a fragment carries
 * no identity worth the risk).
 *
 * EDITING THE LIST: `SCRUB_SUBSTRINGS` / `SCRUB_EXACT` below are the defaults.
 * They can be overridden at runtime from the options page without a rebuild —
 * `loadScrubConfig()` in config.js merges the user's list in. Gooni re-runs an
 * equivalent strip server-side (browser_activity_service.scrub_url) as a
 * backstop; that copy is a fixed floor, not user-editable.
 */

/**
 * Matched as a case-insensitive SUBSTRING of the param name, so one entry
 * covers a family: "token" catches access_token, id_token, refresh_token,
 * X-Amz-Security-Token.
 */
export const SCRUB_SUBSTRINGS = [
  "token",
  "secret",
  "password",
  "passwd",
  "auth",
  "session",
  "sig",
  "signature",
  "credential",
  "apikey",
  "api_key",
];

/**
 * Matched as the WHOLE param name. These are too short or too common to match
 * as substrings — "code" would eat `zipcode`, "key" would eat `keyword`,
 * "state" would eat `estate` — but each is the standard name for a real
 * credential (OAuth authorization code, API key, CSRF nonce).
 */
export const SCRUB_EXACT = ["code", "key", "state", "id_token", "pwd", "otp"];

export const REDACTED = "REDACTED";

/** True if a query param's value should be redacted. */
export function isSecretParam(name, config = {}) {
  const n = String(name || "").toLowerCase();
  const exact = config.exact || SCRUB_EXACT;
  const substrings = config.substrings || SCRUB_SUBSTRINGS;
  if (exact.some((e) => String(e).toLowerCase() === n)) return true;
  return substrings.some((frag) => n.includes(String(frag).toLowerCase()));
}

/**
 * Scrub one URL. Returns { url, host, path } — or null for a URL we can't or
 * shouldn't record (chrome://, about:, extension pages, unparseable input).
 *
 * A null return means "no interval here": internal browser pages are not
 * attention worth logging and have no meaningful host.
 */
export function scrubUrl(raw, config = {}) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  // Only real web navigation counts. chrome://, chrome-extension://, about:,
  // file:, devtools:, view-source: are either the browser's own furniture or
  // local disk paths that have no business in a remote log.
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;

  const params = new URLSearchParams(u.search);
  const out = new URLSearchParams();
  for (const [k, v] of params.entries()) {
    out.append(k, isSecretParam(k, config) ? REDACTED : v);
  }
  const query = out.toString();
  const path = u.pathname || "/";
  const url = `${u.protocol}//${u.host}${path}${query ? `?${query}` : ""}`;

  return { url, host: u.hostname.toLowerCase(), path };
}
